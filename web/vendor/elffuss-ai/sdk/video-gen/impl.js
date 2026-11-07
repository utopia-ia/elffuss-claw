// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The text-to-video task where the model runs (a Worker). Wan 2.1 T2V 1.3B,
// a few-step distilled student, with ONNX Runtime Web on WebGPU:
//   encode  UMT5-XXL in shards (4-bit), one shard in memory at a time, then freed
//   ctx     the transformer's cross-attention keys and values of the prompt, once
//   step    the transformer (8-bit weights, fp16 activations) at each sampling step
//   decode  the latent, frame by frame, with a tiny streaming decoder (TAEHV)
//   mux     H.264 in MP4 (or WebM) with WebCodecs, with an optional soundtrack
// Nothing of the encoder stays loaded once the transformer loads; dispose()
// releases every session. Progress: ctx.report('running', { stage, index, count }).

import { AiError, throwIfAborted } from '../core/errors.js';
import { createTokenizer } from './tokenizer.js';
import { gatherEmbeddings, relativeBuckets, padContext, T5_DIM, TEXT_LEN } from './t5.js';
import { gaussian, randomSeed } from './noise.js';
import { patchify, unpatchify, ropeTables, timeFrequencies, FPS } from './latent.js';
import { SAMPLERS, flowTimes, step } from './schedule.js';
import { toHalf } from './half.js';
import { normalizeOptions } from './options.js';
import { encodeVideo } from '../video/encode.js';
import { fitSoundtrack } from '../video/audio.js';

export const task = 'text-to-video';

/** The files of the model, by role (references of registry/tasks.json). */
export const FILES = Object.freeze({
  tokenizer: 'tok:google/umt5-xxl/tokenizer.json',
  embed: 'web:t5/embed_q4.bin',
  encoder: [0, 1, 2, 3].map(i => `web:t5/encoder_${i}.onnx`),
  ctx: 'web:dit/ctx.onnx',
  parts: [0, 1, 2].map(i => `web:dit/part${i}.onnx`),
  decoder: 'web:vae/taew2_1_light.onnx',
});
const dataOf = ref => (ref.endsWith('.onnx') ? ref + '_data' : null);

export async function load(ctx) {
  if (ctx.device !== 'webgpu') throw new AiError('device-unsupported', 'text to video needs WebGPU');
  if (ctx.test?.failLoad) throw new AiError('run-failed', 'test hook: the load fails');
  // Every file into the model store, checked, one at a time (nothing is kept in memory here).
  for (const f of ctx.files) {
    const ref = `${f.part}:${f.path}`;
    if (ref === FILES.tokenizer) continue;
    await ctx.bytes(ref);
  }
  const tokenizer = createTokenizer(JSON.parse(await ctx.text(FILES.tokenizer)));
  const ort = await ctx.ort();
  return { ort, tokenizer, dit: null, ctxSession: null, decoder: null, sampler: SAMPLERS[ctx.model.sampler || 'rcm'] || SAMPLERS.rcm };
}

/** A WebGPU session of one graph file and its weights, both from the store. */
async function session(ctx, ort, ref, outputs = 'gpu-buffer') {
  const model = new Uint8Array(await ctx.bytes(ref));
  const data = dataOf(ref) && ctx.files.some(f => `${f.part}:${f.path}` === dataOf(ref)) ? new Uint8Array(await ctx.bytes(dataOf(ref))) : null;
  const name = dataOf(ref)?.split('/').pop();
  try {
    return await ort.InferenceSession.create(model, {
      executionProviders: ['webgpu'], graphOptimizationLevel: 'all', preferredOutputLocation: outputs,
      ...(data ? { externalData: [{ path: name, data }] } : {}),
    });
  } catch (err) {
    throw new AiError(/memory|allocat|OOM/i.test(String(err?.message)) ? 'out-of-memory' : 'run-failed', 'could not create a session of ' + ref, { cause: err });
  }
}

const release = async s => { try { await s?.release(); } catch { /* gone */ } };

/** UMT5 over the prompt's tokens, shard by shard: [L × 4096]. */
async function encodePrompt(state, ctx, ids, signal) {
  const { ort } = state;
  const L = ids.length;
  let hidden = gatherEmbeddings(await ctx.bytes(FILES.embed), ids);
  const buckets = new ort.Tensor('int64', relativeBuckets(L), [L, L]);
  for (let i = 0; i < FILES.encoder.length; i++) {
    throwIfAborted(signal);
    ctx.report('running', { stage: 'encode', index: i, count: FILES.encoder.length });
    const s = await session(ctx, ort, FILES.encoder[i], 'cpu');
    try {
      const out = await s.run({ hidden: new ort.Tensor('float32', hidden, [1, L, T5_DIM]), buckets });
      hidden = out.hidden_out.data;
    } finally {
      await release(s);
    }
  }
  return hidden;
}

async function releaseDit(state) {
  for (const s of state.dit || []) await release(s);
  await release(state.ctxSession);
  await release(state.decoder);
  state.dit = null; state.ctxSession = null; state.decoder = null;
}

export async function run(state, input, opts = {}, ctx) {
  const signal = opts.signal;
  const o = normalizeOptions({ ...opts, prompt: opts.prompt ?? (typeof input === 'string' ? input : undefined) });
  if (opts.image != null || (input && typeof input !== 'string')) throw new AiError('unsupported-format', 'this model makes video from text only');
  const seed = o.seed ?? randomSeed();
  const { ort } = state;
  const { g } = o;
  const ids = state.tokenizer.encode(o.prompt, { maxLength: TEXT_LEN });

  // 1. The prompt, with nothing of the transformer loaded.
  await releaseDit(state);
  const hidden = await encodePrompt(state, ctx, ids, signal);
  throwIfAborted(signal);

  // 2. The transformer: its prompt keys and values once, then the parts.
  ctx.report('running', { stage: 'load', index: 0, count: 1 });
  state.ctxSession = await session(ctx, ort, FILES.ctx);
  const ckv = await state.ctxSession.run({ context: new ort.Tensor('float32', padContext(hidden, ids.length), [1, TEXT_LEN, T5_DIM]) });
  state.dit = [];
  for (let i = 0; i < FILES.parts.length; i++) state.dit.push(await session(ctx, ort, FILES.parts[i], i === FILES.parts.length - 1 ? 'cpu' : 'gpu-buffer'));
  if (opts.test?.failRun) await state.dit[0].run({ tokens: new ort.Tensor('float32', new Float32Array(3), [1, 1, 3]) });

  // 3. Sampling.
  const S = g.tokens;
  const rope = ropeTables(g);
  const common = {
    rope_cos: new ort.Tensor('float16', toHalf(rope.cos), [S, 64]),
    rope_sin: new ort.Tensor('float16', toHalf(rope.sin), [S, 64]),
    rope_pos: new ort.Tensor('int64', BigInt64Array.from({ length: S }, (_, i) => BigInt(i)), [1, S]),
  };
  const times = flowTimes(state.sampler, o.steps);
  const x = gaussian(seed, 0, g.latentSize);
  for (let i = 0; i < x.length; i++) x[i] *= times[0];
  for (let k = 0; k < o.steps; k++) {
    throwIfAborted(signal);
    ctx.report('running', { stage: 'step', index: k, count: o.steps });
    const flow = await transformer(state, ckv, common, patchify(x, g), timeFrequencies(times[k] * 1000), S);
    const v = unpatchify(flow, g);
    step(x, v, times[k], times[k + 1], times[k + 1] > 0 ? gaussian(seed, k + 1, g.latentSize) : null);
  }
  for (const t of Object.values(ckv)) t.dispose?.();
  await releaseDit(state);

  // 4. Decode, latent frame by latent frame, into RGBA frames.
  throwIfAborted(signal);
  const frames = await decode(state, ctx, x, g, signal);

  // 5. The video file.
  ctx.report('running', { stage: 'mux', index: 0, count: 1 });
  const audio = opts.audio?.channels?.length ? fitSoundtrack(opts.audio, o.frames / FPS) : null;
  const video = await encodeVideo({
    width: g.width, height: g.height, fps: FPS, frames: frames.length, audio, signal,
    frame: i => new ImageData(frames[i], g.width, g.height),
  });
  ctx.report('done');
  return {
    value: {
      blob: video.blob, mime: video.mime, width: g.width, height: g.height, seconds: video.seconds, fps: FPS,
      frames: frames.length, seed, steps: o.steps, model: ctx.modelId, device: ctx.device, prompt: o.prompt, tokens: ids.length,
    },
    transfer: [],
  };
}

/** One transformer evaluation: tokens [S × 64] in, velocity tokens out. */
async function transformer(state, ckv, common, tokens, tfreq, S) {
  const { ort } = state;
  let carry = {}, flow = null;
  for (const s of state.dit) {
    const feeds = {};
    for (const n of s.inputNames) {
      if (n in common) feeds[n] = common[n];
      else if (n === 'tokens') feeds[n] = new ort.Tensor('float32', tokens, [1, S, 64]);
      else if (n === 't_freq') feeds[n] = new ort.Tensor('float32', tfreq, [1, 256]);
      else if (n in carry) feeds[n] = carry[n];
      else if (n in ckv) feeds[n] = ckv[n];
      else throw new AiError('model-mismatch', 'the transformer asks for an unknown input ' + n);
    }
    const out = await s.run(feeds);
    if (out.flow) flow = out.flow.data;
    if (out.hidden_out) { carry.hidden?.dispose?.(); carry.hidden = out.hidden_out; }
    if (out.e0) { carry.e0 = out.e0; carry.e = out.e; }
  }
  for (const t of Object.values(carry)) t.dispose?.();
  return flow;
}

/** Decode the latent into RGBA frames (Uint8ClampedArray each), streaming one latent frame at a time. */
async function decode(state, ctx, x, g, signal) {
  const { ort } = state;
  state.decoder = await session(ctx, ort, FILES.decoder, 'cpu');
  const s = state.decoder;
  const mems = [];
  for (const [i, c, k] of [[0, 256, 1], [1, 128, 2], [2, 64, 4]]) for (let r = 0; r < 3; r++) mems.push({ c, h: g.h * k, w: g.w * k, i });
  let mem = mems.map(m => new ort.Tensor('float32', new Float32Array(m.c * m.h * m.w), [1, m.c, m.h, m.w]));
  const plane = g.h * g.w;
  const W = g.width, H = g.height, px = W * H;
  const frames = [];
  for (let f = 0; f < g.f; f++) {
    throwIfAborted(signal);
    ctx.report('running', { stage: 'decode', index: f, count: g.f });
    const z = new Float32Array(16 * plane);
    for (let c = 0; c < 16; c++) z.set(x.subarray((c * g.f + f) * plane, (c * g.f + f + 1) * plane), c * plane);
    const feeds = { x: new ort.Tensor('float32', z, [1, 16, g.h, g.w]) };
    mem.forEach((t, i) => { feeds[`mem_${i}`] = t; });
    const out = await s.run(feeds);
    mem = mem.map((_, i) => out[`new_mem_${i}`]);
    const rgb = out.frames.data; // [4, 3, H, W] in [0, 1]
    const n = out.frames.dims[0];
    for (let t = f === 0 ? n - 1 : 0; t < n; t++) {
      const rgba = new Uint8ClampedArray(px * 4);
      const o = t * 3 * px;
      for (let p = 0; p < px; p++) {
        rgba[p * 4] = rgb[o + p] * 255 + 0.5;
        rgba[p * 4 + 1] = rgb[o + px + p] * 255 + 0.5;
        rgba[p * 4 + 2] = rgb[o + 2 * px + p] * 255 + 0.5;
        rgba[p * 4 + 3] = 255;
      }
      frames.push(rgba);
    }
  }
  await release(state.decoder);
  state.decoder = null;
  return frames;
}

export async function dispose(state) {
  await releaseDit(state);
}
