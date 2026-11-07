// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The text-to-image task where the model runs (a Worker): SANA-Sprint 0.6B with
// ONNX Runtime Web on WebGPU. Three sessions (the Gemma 2 text model with 4-bit
// weights, the transformer and the decoder in float16), the 4-bit token table and
// the tokenizer, all from the store through the task context and checked against
// the registry. The model's numbers (latent channels, scaling factor, guidance
// scale, sampler) are read from its own configuration files at the pinned commit.
// No fetch, no DOM.

import { AiError } from '../core/errors.js';
import { releaseSession } from '../core/ort-env.js';
import { generate } from './pipeline.js';
import { embedRows } from './pixels.js';
import { normalizeRequest } from './request.js';

export const task = 'text-to-image';

/** The guidance value the distilled model was made for (the pipeline's default). */
export const GUIDANCE_SCALE = 4.5;

/** Files of the variant, by role. */
export const FILES = Object.freeze({
  tokenizer: 'main:tokenizer/tokenizer.json',
  tokenizerConfig: 'main:tokenizer/tokenizer_config.json',
  transformerConfig: 'main:transformer/config.json',
  vaeConfig: 'main:vae/config.json',
  schedulerConfig: 'main:scheduler/scheduler_config.json',
  encoder: 'onnx:text_encoder/model_q4.onnx',
  embed: 'onnx:text_encoder/embed_tokens_q4.bin',
  embedScales: 'onnx:text_encoder/embed_tokens_q4_scales.bin',
  transformer: 'onnx:transformer/model_fp16.onnx',
  decoder: 'onnx:vae_decoder/model_fp16.onnx',
});

/** Create one session from bytes the store gave, without another copy of them. */
async function session(ort, bytes) {
  return ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
}

/** @param {import('../core/task-runtime.js').TaskContext} ctx */
export async function load(ctx) {
  const ort = await ctx.ort();
  const tf = await ctx.transformers();
  if (ctx.test?.failLoad) await ort.InferenceSession.create(new Uint8Array([1, 2, 3, 4]));
  const json = async ref => JSON.parse(await ctx.text(ref));
  const [tokenizerJson, tokenizerConfig, tcfg, vcfg, scfg] = await Promise.all([
    json(FILES.tokenizer), json(FILES.tokenizerConfig), json(FILES.transformerConfig), json(FILES.vaeConfig), json(FILES.schedulerConfig),
  ]);
  const tokenizer = new tf.GemmaTokenizer(tokenizerJson, tokenizerConfig);
  const hidden = tcfg.caption_channels;
  const embed = new Uint8Array(await ctx.bytes(FILES.embed));
  const scales = new Uint16Array(await ctx.bytes(FILES.embedScales));
  if (embed.length * 2 !== scales.length * 32 || (embed.length * 2) % hidden) throw new AiError('model-mismatch', 'the token table does not match the text model');
  const config = {
    channels: tcfg.in_channels,
    factor: 2 ** (vcfg.decoder_block_out_channels.length - 1),
    scaling: vcfg.scaling_factor,
    guidance: GUIDANCE_SCALE * tcfg.guidance_embeds_scale,
    sigmaData: scfg.sigma_data,
  };
  // One after the other, each file read and handed over before the next: a model
  // is held twice (its bytes and its session) only while its session is created.
  const sessions = {};
  try {
    for (const name of ['encoder', 'transformer', 'decoder']) {
      const bytes = await ctx.bytes(FILES[name]);
      ctx.report('loading', { stage: name });
      sessions[name] = await session(ort, bytes);
    }
  } catch (err) {
    for (const s of Object.values(sessions)) await releaseSession(s);
    throw err;
  }
  return { ort, tokenizer, embed, scales, hidden, config, ...sessions };
}

/**
 * @param {Awaited<ReturnType<typeof load>>} state
 * @param {object} input the request (see request.js)
 * @param {{ test?: { failRun?: boolean } | null }} opts
 * @param {import('../core/task-runtime.js').TaskContext} ctx
 */
export async function run(state, input, opts = {}, ctx) {
  const { ort } = state;
  if (opts.test?.failRun) await state.transformer.run({ latents: new ort.Tensor('float32', new Float32Array(3), [1, 3, 1, 1]) });
  const req = normalizeRequest(input);
  const T = (data, dims) => new ort.Tensor('float32', data, dims);
  const out = async (s, feeds, name) => {
    const r = await s.run(feeds);
    const t = r[name];
    const data = t.data;
    for (const v of Object.values(r)) v.dispose?.();
    return { data, dims: t.dims };
  };
  const models = {
    encode: text => Array.from(state.tokenizer.encode(text)),
    embed: ids => embedRows(state.embed, state.scales, ids, state.hidden),
    hidden: state.hidden,
    config: state.config,
    runEncoder: async (embeds, n) => (await out(state.encoder, { embeds: T(embeds, [1, n, state.hidden]) }, 'hidden')).data,
    runTransformer: async o => (await out(state.transformer, {
      latents: T(o.latents, [1, state.config.channels, o.h, o.w]), caption: T(o.caption, [1, o.tokens, state.hidden]),
      timestep: T(Float32Array.of(o.time), [1]), guidance: T(Float32Array.of(o.guidance), [1]),
    }, 'velocity')).data,
    runDecoder: async (z, h, w) => {
      const r = await out(state.decoder, { latents: T(z, [1, state.config.channels, h, w]) }, 'image');
      return { data: r.data, height: r.dims[2], width: r.dims[3] };
    },
  };
  const report = (stage, extra) => ctx.report('running', { stage, ...extra });
  const img = await generate(models, req, { report });
  report('encode-png');
  const canvas = new OffscreenCanvas(img.width, img.height);
  canvas.getContext('2d').putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  ctx.report('done');
  return {
    value: {
      blob, mime: 'image/png', width: img.width, height: img.height, seed: req.seed, steps: req.steps, prompt: req.prompt,
      aspect: req.aspect, model: ctx.modelId, device: ctx.device, promptTokens: img.promptTokens, truncated: img.truncated,
    },
    transfer: [],
  };
}

export async function dispose(state) {
  for (const k of ['encoder', 'transformer', 'decoder']) await releaseSession(state?.[k]);
  if (state) { state.embed = null; state.scales = null; state.tokenizer = null; }
}
