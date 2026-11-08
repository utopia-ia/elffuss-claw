// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The storyboard video where the models run (a Worker), in two operations the
// page calls one after the other, so the person can look at the keyframes first:
//
//   keyframes  SANA-Sprint 0.6B paints the keyframes of the plan: from the text, or
//              by SDEdit from an earlier keyframe or a photo (its DC-AE encoder, then
//              the noise at time t, then two steps); each step's estimate is
//              reported as a preview. One keyframe again: `only: k`.
//   clips      Wan 2.1 VACE 1.3B makes the clip between each pair of keyframes: the
//              known frames (the keyframes, the last frames of the clip before) go in
//              as VACE's control through the tiny encoder, four rCM steps, each step's
//              estimate decoded small as a preview; the clip decoded, its colour pulled
//              back to its keyframes, reported as a short MP4; then all of them
//              stitched into one video file.
//
// The transformer is the T2V one (its published weights) with the VACE blocks
// woven in (vpart graphs that read both weight files). SANA is released before
// Wan loads; UMT5 runs shard by shard for every clip's prompt at once.

import { AiError, throwIfAborted } from '../core/errors.js';
import { createTokenizer } from './tokenizer.js';
import { gatherEmbeddings, relativeBuckets, padContext, T5_DIM, TEXT_LEN } from './t5.js';
import { gaussian } from './noise.js';
import { grid, patchify, unpatchify, ropeTables, timeFrequencies, FPS } from './latent.js';
import { SAMPLERS, flowTimes, step } from './schedule.js';
import { toHalf } from './half.js';
import { checkPlan, withStyle, clipFrames, containRect, CARRY } from './story/plan.js';
import { knownFrames, foldMask, controlTokens } from './story/control.js';
import { matchClip, anchorSpread } from './story/color.js';
import { encodeVideo } from '../video/encode.js';
import { fitSoundtrack } from '../video/audio.js';
import { generate as paint } from '../text-to-image/pipeline.js';
import { normalizeRequest } from '../text-to-image/request.js';
import { embedRows, resizeCrop, toRgba } from '../text-to-image/pixels.js';

export const task = 'text-to-video';

/** The files of the model, by role (references of the registry). */
export const FILES = Object.freeze({
  tokenizer: 'tok:google/umt5-xxl/tokenizer.json',
  embed: 'web:t5/embed_q4.bin',
  encoder: [0, 1, 2, 3].map(i => `web:t5/encoder_${i}.onnx`),
  ctx: 'web:dit/ctx.onnx',
  vctx: 'vace:dit/vctx.onnx',
  vparts: [0, 1, 2].map(i => `vace:dit/vpart${i}.onnx`),
  partData: [0, 1, 2].map(i => `web:dit/part${i}.onnx_data`),
  decoder: 'web:vae/taew2_1_light.onnx',
  tae: 'vace:vae/lighttaew2_1_encoder.onnx',
  sana: {
    tokenizer: 'sana:tokenizer/tokenizer.json', tokenizerConfig: 'sana:tokenizer/tokenizer_config.json',
    transformerConfig: 'sana:transformer/config.json', vaeConfig: 'sana:vae/config.json', schedulerConfig: 'sana:scheduler/scheduler_config.json',
    encoder: 'sanaw:text_encoder/model_q4.onnx', embed: 'sanaw:text_encoder/embed_tokens_q4.bin', embedScales: 'sanaw:text_encoder/embed_tokens_q4_scales.bin',
    transformer: 'sanaw:transformer/model_fp16.onnx', decoder: 'sanaw:vae_decoder/model_fp16.onnx', imageEncoder: 'sanaenc:vae_encoder/model_fp16.onnx',
  },
});
/** The guidance value SANA-Sprint was distilled for (as text-to-image). */
const SANA_GUIDANCE = 4.5;
/** Width of a step preview (the page scales it up). */
const PREVIEW_WIDTH = 320;

const has = (ctx, ref) => ctx.files.some(f => `${f.part}:${f.path}` === ref);

export async function load(ctx) {
  if (ctx.device !== 'webgpu') throw new AiError('device-unsupported', 'a storyboard video needs WebGPU');
  if (ctx.test?.failLoad) throw new AiError('run-failed', 'test hook: the load fails');
  for (const f of ctx.files) {
    const ref = `${f.part}:${f.path}`;
    if (ref !== FILES.tokenizer && !ref.startsWith('sana:')) await ctx.bytes(ref);
  }
  const tokenizer = createTokenizer(JSON.parse(await ctx.text(FILES.tokenizer)));
  const ort = await ctx.ort();
  return { ort, tokenizer, sana: null, wan: null, sampler: SAMPLERS[ctx.model.sampler || 'rcm'] || SAMPLERS.rcm };
}

const release = async s => { try { await s?.release(); } catch { /* gone */ } };

/** A WebGPU session of one graph and the weight files it names (each from the store). */
async function session(ctx, ort, ref, { outputs = 'gpu-buffer', data = [] } = {}) {
  const model = new Uint8Array(await ctx.bytes(ref));
  const own = ref.endsWith('.onnx') && has(ctx, ref + '_data') ? [ref + '_data'] : [];
  const externalData = [];
  for (const d of [...own, ...data]) externalData.push({ path: d.split('/').pop(), data: new Uint8Array(await ctx.bytes(d)) });
  try {
    return await ort.InferenceSession.create(model, {
      executionProviders: ['webgpu'], graphOptimizationLevel: 'all', preferredOutputLocation: outputs,
      ...(externalData.length ? { externalData } : {}),
    });
  } catch (err) {
    throw new AiError(/memory|allocat|OOM/i.test(String(err?.message)) ? 'out-of-memory' : 'run-failed', 'could not create a session of ' + ref, { cause: err });
  }
}

/** RGBA of a size, downscaled for a preview (box filter). */
function shrink(rgba, W, H, w) {
  const h = Math.max(1, Math.round((H * w) / W));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.floor((x * W) / w), sy = Math.floor((y * H) / h);
    const ex = Math.max(sx + 1, Math.floor(((x + 1) * W) / w)), ey = Math.max(sy + 1, Math.floor(((y + 1) * H) / h));
    const acc = [0, 0, 0]; let n = 0;
    for (let yy = sy; yy < ey; yy++) for (let xx = sx; xx < ex; xx++) { const p = (yy * W + xx) * 4; acc[0] += rgba[p]; acc[1] += rgba[p + 1]; acc[2] += rgba[p + 2]; n++; }
    const o = (y * w + x) * 4;
    out[o] = acc[0] / n; out[o + 1] = acc[1] / n; out[o + 2] = acc[2] / n; out[o + 3] = 255;
  }
  return { width: w, height: h, rgba: out };
}

/**
 * A photo in a W × H frame without cropping it: contained and centred, the bands
 * around it filled with its own edges stretched and blurred (SDEdit and VACE paint
 * them over; VACE is told only the photo's rectangle is known).
 * @param {{ rgba: Uint8ClampedArray, width: number, height: number }} img
 */
export function placePhoto(img, W, H) {
  const r = containRect(img.width, img.height, W, H);
  const out = new Uint8ClampedArray(W * H * 4);
  const sample = (x, y) => {
    const sx = Math.min(img.width - 1, Math.max(0, Math.floor(((x - r.x + 0.5) * img.width) / r.w)));
    const sy = Math.min(img.height - 1, Math.max(0, Math.floor(((y - r.y + 0.5) * img.height) / r.h)));
    return (sy * img.width + sx) * 4;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const inside = x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
    let p;
    if (inside) p = sample(x, y);
    else {
      // the nearest edge, blurred by averaging a few samples further in
      const cx = Math.min(r.x + r.w - 1, Math.max(r.x, x)), cy = Math.min(r.y + r.h - 1, Math.max(r.y, y));
      const acc = [0, 0, 0];
      const d = Math.max(Math.abs(x - cx), Math.abs(y - cy));
      const spread = Math.min(24, 2 + (d >> 2));
      for (let k = -2; k <= 2; k++) {
        const q = sample(x === cx ? Math.min(r.x + r.w - 1, Math.max(r.x, cx + k * spread)) : cx, y === cy ? Math.min(r.y + r.h - 1, Math.max(r.y, cy + k * spread)) : cy);
        acc[0] += img.rgba[q]; acc[1] += img.rgba[q + 1]; acc[2] += img.rgba[q + 2];
      }
      const o = (y * W + x) * 4;
      out[o] = acc[0] / 5; out[o + 1] = acc[1] / 5; out[o + 2] = acc[2] / 5; out[o + 3] = 255;
      continue;
    }
    const o = (y * W + x) * 4;
    out[o] = img.rgba[p]; out[o + 1] = img.rgba[p + 1]; out[o + 2] = img.rgba[p + 2]; out[o + 3] = 255;
  }
  return { rgba: out, width: W, height: H, rect: r };
}

// ---------------------------------------------------------------------------- keyframes (SANA)

async function loadSana(state, ctx) {
  if (state.sana) return state.sana;
  await releaseWan(state);
  const { ort } = state;
  const F = FILES.sana;
  const tf = await ctx.transformers();
  const json = async ref => JSON.parse(await ctx.text(ref));
  const [tokenizerJson, tokenizerConfig, tcfg, vcfg, scfg] = await Promise.all([json(F.tokenizer), json(F.tokenizerConfig), json(F.transformerConfig), json(F.vaeConfig), json(F.schedulerConfig)]);
  const s = {
    tokenizer: new tf.GemmaTokenizer(tokenizerJson, tokenizerConfig), hidden: tcfg.caption_channels,
    embed: new Uint8Array(await ctx.bytes(F.embed)), scales: new Uint16Array(await ctx.bytes(F.embedScales)),
    config: { channels: tcfg.in_channels, factor: 2 ** (vcfg.decoder_block_out_channels.length - 1), scaling: vcfg.scaling_factor, guidance: SANA_GUIDANCE * tcfg.guidance_embeds_scale, sigmaData: scfg.sigma_data },
  };
  ctx.report('running', { stage: 'load', index: 0, count: 1 });
  for (const k of ['encoder', 'transformer', 'decoder']) s[k] = await session(ctx, ort, F[k], { outputs: 'cpu' });
  state.sana = s;
  return s;
}

async function releaseSana(state) {
  const s = state.sana;
  if (!s) return;
  for (const k of ['encoder', 'transformer', 'decoder', 'imageEncoder']) await release(s[k]);
  state.sana = null;
}

/** RGBA [W × H] → planar float [-1, 1] resized (cover, centre crop) to w × h. */
function toPlanes(rgba, W, H, w, h) {
  const px = W * H, planes = new Float32Array(3 * px);
  for (let p = 0; p < px; p++) for (let c = 0; c < 3; c++) planes[c * px + p] = rgba[p * 4 + c] / 127.5 - 1;
  return W === w && H === h ? planes : resizeCrop(planes, 3, H, W, w, h);
}

async function paintKeyframe(state, ctx, s, { prompt, seed, W, H, init, k, count, signal }) {
  const { ort } = state;
  const T = (data, dims) => new ort.Tensor('float32', data, dims);
  const out = async (sess, feeds, name) => {
    const r = await sess.run(feeds); const t = r[name]; const data = t.data;
    for (const v of Object.values(r)) v.dispose?.();
    return { data, dims: t.dims };
  };
  const req = normalizeRequest({ prompt, seed, width: W, height: H });
  const models = {
    encode: text => Array.from(s.tokenizer.encode(text)), embed: ids => embedRows(s.embed, s.scales, ids, s.hidden), hidden: s.hidden, config: s.config,
    runEncoder: async (embeds, n) => (await out(s.encoder, { embeds: T(embeds, [1, n, s.hidden]) }, 'hidden')).data,
    runTransformer: async o => (await out(s.transformer, {
      latents: T(o.latents, [1, s.config.channels, o.h, o.w]), caption: T(o.caption, [1, o.tokens, s.hidden]),
      timestep: T(Float32Array.of(o.time), [1]), guidance: T(Float32Array.of(o.guidance), [1]),
    }, 'velocity')).data,
    runDecoder: async (z, h, w) => { const r = await out(s.decoder, { latents: T(z, [1, s.config.channels, h, w]) }, 'image'); return { data: r.data, height: r.dims[2], width: r.dims[3] }; },
  };
  if (init) {
    // the picture to start from, through SANA's DC-AE encoder, at the generation size
    s.imageEncoder ||= await session(ctx, ort, FILES.sana.imageEncoder, { outputs: 'cpu' });
    const planes = toPlanes(init.rgba, init.width, init.height, req.genWidth, req.genHeight);
    const lat = (await out(s.imageEncoder, { image: T(planes, [1, 3, req.genHeight, req.genWidth]) }, 'latents')).data;
    req.init = { latents: Float32Array.from(lat, v => v * s.config.scaling), t: init.t };
  }
  const onX0 = async (x0, i, n) => {
    const z = Float32Array.from(x0, v => v / s.config.sigmaData / s.config.scaling);
    const img = await models.runDecoder(z, req.genHeight / s.config.factor, req.genWidth / s.config.factor);
    const rgba = toRgba(resizeCrop(img.data, 3, img.height, img.width, W, H), W, H);
    const p = shrink(rgba, W, H, PREVIEW_WIDTH);
    ctx.report('running', { stage: 'keyframe', index: k, count, step: i, steps: n, preview: p });
  };
  const img = await paint(models, req, { signal, onX0, report: () => {} });
  return { rgba: img.rgba, width: W, height: H };
}

async function keyframes(state, ctx, input, signal) {
  const { width: W, height: H } = sizeOf(input.size);
  const plan = checkPlan(input.plan, { start: Boolean(input.start), end: Boolean(input.end) });
  const n = plan.shots.length;
  const have = (input.keyframes || []).map(k => (k ? { ...k, rgba: new Uint8ClampedArray(k.rgba) } : null));
  const keys = Array.from({ length: n }, (_, k) => have[k] || null);
  const todo = input.only != null ? [Number(input.only)] : plan.shots.map((_, k) => k);
  let s = null;
  for (const k of todo) {
    throwIfAborted(signal);
    const shot = plan.shots[k];
    let img;
    if (shot.image) {
      const photo = input[shot.image];
      img = placePhoto({ ...photo, rgba: new Uint8ClampedArray(photo.rgba) }, W, H);
    } else {
      s ||= await loadSana(state, ctx);
      ctx.report('running', { stage: 'keyframe', index: k, count: n, step: 0, steps: 2 });
      const from = shot.from != null ? keys[shot.from] : null;
      if (shot.from != null && !from) throw new AiError('decode-failed', `keyframe ${k} comes from keyframe ${shot.from}, which is not there`);
      img = await paintKeyframe(state, ctx, s, {
        prompt: withStyle(plan, shot.prompt), seed: plan.seed, W, H, k, count: n, signal,
        init: from ? { ...from, t: shot.t } : null,
      });
      if (from) anchorSpread(img.rgba, from.rgba);
    }
    keys[k] = img;
    ctx.report('running', { stage: 'keyframe', index: k, count: n, done: true, image: shrink(img.rgba, W, H, Math.min(W, 2 * PREVIEW_WIDTH)) });
  }
  await releaseSana(state);
  ctx.report('done');
  const value = { size: `${W}x${H}`, keyframes: keys.map(k => (k ? { rgba: k.rgba.buffer, width: k.width, height: k.height, rect: k.rect || null } : null)) };
  return { value, transfer: [] };
}

// ---------------------------------------------------------------------------- clips (Wan VACE)

async function releaseWan(state) {
  const w = state.wan;
  if (!w) return;
  for (const s of [...(w.parts || []), ...(w.ctx || [])]) await release(s);
  await release(w.decoder); await release(w.tae);
  state.wan = null;
}

/** UMT5 over several prompts, shard by shard (each shard loaded once): one [L × 4096] per prompt. */
async function encodePrompts(state, ctx, prompts, signal) {
  const { ort } = state;
  const ids = prompts.map(p => state.tokenizer.encode(p, { maxLength: TEXT_LEN }));
  const table = await ctx.bytes(FILES.embed);
  let hidden = ids.map(i => gatherEmbeddings(table, i));
  for (let s = 0; s < FILES.encoder.length; s++) {
    throwIfAborted(signal);
    ctx.report('running', { stage: 'encode', index: s, count: FILES.encoder.length });
    const sess = await session(ctx, ort, FILES.encoder[s], { outputs: 'cpu' });
    try {
      // one run at a time: a session takes no concurrent runs
      for (let j = 0; j < hidden.length; j++) {
        const L = ids[j].length;
        const out = await sess.run({ hidden: new ort.Tensor('float32', hidden[j], [1, L, T5_DIM]), buckets: new ort.Tensor('int64', relativeBuckets(L), [L, L]) });
        hidden[j] = out.hidden_out.data;
      }
    } finally { await release(sess); }
  }
  return hidden.map((h, j) => padContext(h, ids[j].length));
}

/** The tiny encoder over a clip's frames (planar [T, 3, H, W] in [0, 1]): normalised latents [16, F, h, w]. */
async function encodeFrames(state, pixels, frames, W, H) {
  const { ort } = state;
  const s = state.wan.tae;
  const h = H / 8, w = W / 8, F = (frames - 1) / 4 + 1, px = W * H;
  const shapes = [[64, H / 2, W / 2], [64, H / 2, W / 2], [64, H / 2, W / 2], [64, H / 4, W / 4], [64, H / 4, W / 4], [64, H / 4, W / 4], [64, h, w], [64, h, w], [64, h, w]];
  let mem = shapes.map(([c, a, b]) => new ort.Tensor('float32', new Float32Array(c * a * b), [1, c, a, b]));
  const z = new Float32Array(16 * F * h * w);
  // 1 + 4k frames padded at the end with the last to 4(k + 1): chunk c gives latent frame c
  for (let c = 0; c < F; c++) {
    const chunk = new Float32Array(4 * 3 * px);
    for (let i = 0; i < 4; i++) {
      const f = Math.min(frames - 1, 4 * c + i);
      chunk.set(pixels.subarray(f * 3 * px, (f + 1) * 3 * px), i * 3 * px);
    }
    const feeds = { x: new ort.Tensor('float32', chunk, [4, 3, H, W]) };
    mem.forEach((t, i) => { feeds[`mem_${i}`] = t; });
    const out = await s.run(feeds);
    mem = mem.map((_, i) => out[`new_mem_${i}`]);
    const lat = out.z.data;
    for (let ch = 0; ch < 16; ch++) z.set(lat.subarray(ch * h * w, (ch + 1) * h * w), ((ch * F) + c) * h * w);
  }
  return z;
}

/** Decode latent frames into RGBA frames with the streaming tiny decoder (memory zeroed when `fresh`). */
async function decodeFrames(state, x, g, from = 0, count = g.f) {
  const { ort } = state;
  const s = state.wan.decoder;
  const mems = [];
  for (const [, c, k] of [[0, 256, 1], [1, 128, 2], [2, 64, 4]]) for (let r = 0; r < 3; r++) mems.push({ c, h: g.h * k, w: g.w * k });
  let mem = mems.map(m => new ort.Tensor('float32', new Float32Array(m.c * m.h * m.w), [1, m.c, m.h, m.w]));
  const plane = g.h * g.w, W = g.width, H = g.height, px = W * H;
  const frames = [];
  for (let f = from; f < from + count; f++) {
    const z = new Float32Array(16 * plane);
    for (let c = 0; c < 16; c++) z.set(x.subarray((c * g.f + f) * plane, (c * g.f + f + 1) * plane), c * plane);
    const feeds = { x: new ort.Tensor('float32', z, [1, 16, g.h, g.w]) };
    mem.forEach((t, i) => { feeds[`mem_${i}`] = t; });
    const out = await s.run(feeds);
    mem = mem.map((_, i) => out[`new_mem_${i}`]);
    const rgb = out.frames.data, n = out.frames.dims[0];
    for (let t = f === 0 ? n - 1 : 0; t < n; t++) {
      const rgba = new Uint8ClampedArray(px * 4), o = t * 3 * px;
      for (let p = 0; p < px; p++) { rgba[p * 4] = rgb[o + p] * 255 + 0.5; rgba[p * 4 + 1] = rgb[o + px + p] * 255 + 0.5; rgba[p * 4 + 2] = rgb[o + 2 * px + p] * 255 + 0.5; rgba[p * 4 + 3] = 255; }
      frames.push(rgba);
    }
  }
  return frames;
}

/** One transformer evaluation with VACE: tokens and control tokens in, velocity tokens out. */
async function transformer(state, ckv, common, tokens, control, tfreq, S) {
  const { ort } = state;
  let carry = {}, flow = null;
  for (const s of state.wan.parts) {
    const feeds = {};
    for (const n of s.inputNames) {
      if (n in common) feeds[n] = common[n];
      else if (n === 'tokens') feeds[n] = new ort.Tensor('float32', tokens, [1, S, 64]);
      else if (n === 'control') feeds[n] = new ort.Tensor('float32', control, [1, S, control.length / S]);
      else if (n === 't_freq') feeds[n] = new ort.Tensor('float32', tfreq, [1, 256]);
      else if (n in carry) feeds[n] = carry[n];
      else if (n in ckv) feeds[n] = ckv[n];
      else throw new AiError('model-mismatch', 'the transformer asks for an unknown input ' + n);
    }
    const out = await s.run(feeds);
    if (out.flow) flow = out.flow.data;
    if (out.hidden_out) { carry.hidden?.dispose?.(); carry.chid?.dispose?.(); carry.hidden = out.hidden_out; carry.chid = out.chid_out; }
    if (out.e0) { carry.e0 = out.e0; carry.e = out.e; }
  }
  for (const t of Object.values(carry)) t.dispose?.();
  return flow;
}

function sizeOf(size) {
  const [width, height] = String(size || '').split('x').map(Number);
  if (!['832x480', '480x832', '624x624'].includes(`${width}x${height}`)) throw new AiError('too-large', `size ${size} is not offered for a storyboard`);
  return { width, height };
}

async function clips(state, ctx, input, opts, signal) {
  const { ort } = state;
  const { width: W, height: H } = sizeOf(input.size);
  const plan = checkPlan(input.plan, { start: Boolean(input.start), end: Boolean(input.end) });
  const keys = (input.keyframes || []).map(k => k && { ...k, rgba: new Uint8ClampedArray(k.rgba) });
  if (keys.length !== plan.shots.length || keys.some(k => !k || k.width !== W || k.height !== H)) throw new AiError('decode-failed', 'the clips need every keyframe, at the video size');
  const carry = input.carry == null ? CARRY : Number(input.carry);
  const n = plan.clips.length;
  const lengths = clipFrames(n, carry);
  const steps = Number(input.steps || 4);
  const times = flowTimes(state.sampler, steps);
  await releaseSana(state);

  // 1. Every clip's prompt through UMT5, with nothing of the transformer loaded.
  await releaseWan(state);
  const contexts = await encodePrompts(state, ctx, plan.clips.map(c => withStyle(plan, c)), signal);

  // 2. The prompts' keys and values for the base and the VACE blocks, then the parts.
  ctx.report('running', { stage: 'load', index: 0, count: 1 });
  // (the sessions stay until the clips are made: their outputs stay on the device)
  state.wan = { parts: [], ctx: [], decoder: null, tae: null };
  const ckvs = [];
  for (const [ref, data] of [[FILES.ctx, []], [FILES.vctx, ['web:dit/ctx.onnx_data']]]) {
    const s = await session(ctx, ort, ref, { data });
    state.wan.ctx.push(s);
    for (let i = 0; i < n; i++) ckvs[i] = { ...(ckvs[i] || {}), ...(await s.run({ context: new ort.Tensor('float32', contexts[i], [1, TEXT_LEN, T5_DIM]) })) };
  }
  for (let i = 0; i < 3; i++) state.wan.parts.push(await session(ctx, ort, FILES.vparts[i], { outputs: i === 2 ? 'cpu' : 'gpu-buffer', data: [FILES.partData[i]] }));
  state.wan.decoder = await session(ctx, ort, FILES.decoder, { outputs: 'cpu' });
  state.wan.tae = await session(ctx, ort, FILES.tae, { outputs: 'cpu' });

  // 3. The clips, one after the other.
  const seed = plan.seed >>> 0;
  const video = [];
  let prev = null;
  const reactive = new Map(); // by frame count: the latents of an all-grey clip
  for (let i = 0; i < n; i++) {
    const T = lengths[i];
    const g = grid({ width: W, height: H, frames: T });
    const S = g.tokens;
    // what is known: the clip's first keyframe (or the last frames of the clip before) and its last
    const known = [];
    if (carry && prev) for (let j = 0; j < carry; j++) known.push({ frame: j, rgba: prev[prev.length - carry + j] });
    else known.push({ frame: 0, rgba: keys[i].rgba, rect: keys[i].rect || undefined });
    known.push({ frame: T - 1, rgba: keys[i + 1].rgba, rect: keys[i + 1].rect || undefined });
    const { pixels, masks } = knownFrames(known, { frames: T, width: W, height: H });
    ctx.report('running', { stage: 'clip', clip: i, clips: n, index: 0, count: steps });
    const inactive = await encodeFrames(state, pixels, T, W, H);
    if (!reactive.has(T)) reactive.set(T, await encodeFrames(state, new Float32Array(pixels.length).fill(0.5), T, W, H));
    const control = controlTokens(inactive, reactive.get(T), foldMask(masks, { frames: T, width: W, height: H }), g);
    const rope = ropeTables(g);
    const common = {
      rope_cos: new ort.Tensor('float16', toHalf(rope.cos), [S, 64]), rope_sin: new ort.Tensor('float16', toHalf(rope.sin), [S, 64]),
      rope_pos: new ort.Tensor('int64', BigInt64Array.from({ length: S }, (_, k) => BigInt(k)), [1, S]),
    };
    const x = gaussian(seed + 101 * i, 0, g.latentSize);
    for (let k = 0; k < x.length; k++) x[k] *= times[0];
    for (let k = 0; k < steps; k++) {
      throwIfAborted(signal);
      ctx.report('running', { stage: 'clip', clip: i, clips: n, index: k, count: steps });
      const flow = await transformer(state, ckvs[i], common, patchify(x, g), control, timeFrequencies(times[k] * 1000), S);
      const v = unpatchify(flow, g);
      if (k < steps - 1) {
        // the step's clean estimate, three latent frames decoded alone, small: the live preview
        const x0 = new Float32Array(x.length);
        for (let q = 0; q < x.length; q++) x0[q] = x[q] - times[k] * v[q];
        const picks = [0, (g.f - 1) >> 1, g.f - 1];
        const previews = [];
        for (const f of picks) {
          const fr = await decodeFrames(state, x0, g, f, 1);
          previews.push(shrink(fr[fr.length - 1], W, H, PREVIEW_WIDTH));
        }
        ctx.report('running', { stage: 'clip', clip: i, clips: n, index: k + 1, count: steps, previews, at: picks.map(f => Math.min(T - 1, f * 4)) });
      }
      step(x, v, times[k], times[k + 1], times[k + 1] > 0 ? gaussian(seed + 101 * i, k + 1, g.latentSize) : null);
    }
    ctx.report('running', { stage: 'decode', clip: i, clips: n, index: 0, count: 1 });
    const frames = await decodeFrames(state, x, g);
    if (input.colorMatch !== false) matchClip(frames, keys[i].rgba, keys[i + 1].rgba);
    const fresh = i === 0 ? frames : frames.slice(carry || 1);
    video.push(...fresh);
    prev = frames;
    const part = await encodeVideo({ width: W, height: H, fps: FPS, frames: frames.length, signal, frame: f => new ImageData(frames[f], W, H) });
    ctx.report('running', { stage: 'clip', clip: i, clips: n, index: steps, count: steps, done: true, blob: part.blob, mime: part.mime, frames: frames.length });
  }
  for (const c of ckvs) for (const t of Object.values(c)) t.dispose?.();
  await releaseWan(state);

  // 4. The video file.
  ctx.report('running', { stage: 'mux', index: 0, count: 1 });
  const audio = opts.audio?.channels?.length ? fitSoundtrack(opts.audio, video.length / FPS) : null;
  const file = await encodeVideo({ width: W, height: H, fps: FPS, frames: video.length, audio, signal, frame: f => new ImageData(video[f], W, H) });
  ctx.report('done');
  return {
    value: { blob: file.blob, mime: file.mime, width: W, height: H, seconds: file.seconds, fps: FPS, frames: video.length, clips: n, seed, steps, carry, model: ctx.modelId, device: ctx.device },
    transfer: [],
  };
}

/**
 * input.op: 'keyframes' (plan, size, start?, end?, keyframes?, only?) or 'clips'
 * (plan, size, keyframes, start?, end?, carry?, steps?, colorMatch?). Photos and
 * keyframes are { rgba: ArrayBuffer, width, height }.
 */
export async function run(state, input, opts = {}, ctx) {
  const signal = opts.signal;
  if (!input || typeof input !== 'object') throw new AiError('unsupported-format', 'a storyboard run takes an object with an op');
  if (opts.test?.failRun) throw new AiError('run-failed', 'test hook: the run fails');
  if (input.op === 'keyframes') return keyframes(state, ctx, input, signal);
  if (input.op === 'clips') return clips(state, ctx, input, opts, signal);
  throw new AiError('unsupported-format', 'op must be keyframes or clips');
}

export async function dispose(state) {
  await releaseSana(state);
  await releaseWan(state);
}
