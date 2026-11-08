// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// A video that does what it is asked, in the browser: a storyboard of keyframes
// every three seconds (SANA-Sprint), then the clip between each pair (Wan 2.1
// VACE 1.3B, few-step), stitched into one MP4. Two calls, so the page can show
// the keyframes and let the person change one before the long part:
//
//   const story = new StoryVideo({ onProgress });
//   const plan = planStory({ prompt, seconds: 9 });             // or a language model's plan
//   const { keyframes, size } = await story.keyframes({ plan, size: '832x480' });
//   const video = await story.clips({ plan, size, keyframes });   // { blob, mime, seconds, … }
//   await story.dispose();
//
// Progress events (`onProgress`) say where it is and carry previews to draw:
//   { stage: 'keyframe', index, count, step, steps, preview? }   a keyframe being painted
//   { stage: 'keyframe', index, count, done: true, image }        a keyframe made
//   { stage: 'encode' | 'load', index, count }                    the text, the models
//   { stage: 'clip', clip, clips, index, count, previews?, at? }   a step of a clip (previews:
//                                                                  three frames of its estimate)
//   { stage: 'clip', clip, clips, done: true, blob, mime, frames } a clip made (a short MP4)
//   { stage: 'decode' | 'mux', … }
// Pictures are { width, height, rgba } (RGBA bytes).

import { Task } from '../core/task.js';
import { getModel, loadRegistry, variantFiles } from '../core/registry.js';
import { deviceReason } from './estimate.js';
import { grid } from './latent.js';
import { clipCount, clipFrames, sizeForAspect, CARRY } from './story/plan.js';

export { planStory, checkPlan, splitActions, sizeForAspect, containRect, clipCount, clipFrames, videoFrames, PLAN_GUIDE, STORY_SIZES, MAX_CLIPS, SHOT_SECONDS, SDEDIT_TIME } from './story/plan.js';

/** The model of storyboards in the registry. */
export const STORY_MODEL = 'text-to-video/wan2.1-vace-1.3b-rcm';

const MB = 1 << 20;
const withStage = onProgress => onProgress && (p => onProgress(p?.status === 'downloading' || p?.status === 'checking' ? { ...p, stage: 'download' } : p));

/**
 * Storyboard video. Runs in a Worker; the first call downloads the models into the
 * store (several gigabytes, once; most of them shared with text-to-video and
 * text-to-image).
 * @extends Task
 */
export class StoryVideo extends Task {
  /** @param {import('../core/task.js').TaskOptions} [options] */
  constructor(options = {}) {
    super({
      task: 'text-to-video',
      workerUrl: new URL('./story-worker.js', import.meta.url),
      impl: () => import('./story-impl.js'),
      prepare: async input => ({ value: input, transfer: [] }),
    }, { device: 'webgpu', model: STORY_MODEL, ...options, onProgress: withStage(options.onProgress) });
  }

  /**
   * The keyframes of a plan (all, or `only` one again).
   * @param {{ plan: object, size: string, start?: Picture, end?: Picture, keyframes?: Picture[], only?: number, signal?: AbortSignal }} o
   * @returns {Promise<{ size: string, keyframes: Picture[] }>}
   */
  keyframes({ signal, ...o }) {
    return this.run({ op: 'keyframes', ...o }, { signal });
  }

  /**
   * The clips between the keyframes, stitched into one video.
   * @param {{ plan: object, size: string, keyframes: Picture[], start?: Picture, end?: Picture, carry?: number,
   *   steps?: number, colorMatch?: boolean, audio?: { sampleRate: number, channels: Float32Array[] }, signal?: AbortSignal }} o
   */
  clips({ signal, audio, ...o }) {
    return this.run({ op: 'clips', ...o }, { signal, ...(audio ? { audio } : {}) });
  }
}

/** @typedef {{ width: number, height: number, rgba: ArrayBuffer }} Picture */

/**
 * A photo (Blob or File) as a Picture no larger than `maxSide`, and the storyboard
 * size its shape asks for. Main thread or Worker (createImageBitmap, OffscreenCanvas).
 * @returns {Promise<{ picture: Picture, size: string }>}
 */
export async function readPhoto(blob, { maxSide = 1600 } = {}) {
  const bmp = await createImageBitmap(blob);
  try {
    const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const width = Math.max(1, Math.round(bmp.width * s)), height = Math.max(1, Math.round(bmp.height * s));
    const canvas = new OffscreenCanvas(width, height);
    const g = canvas.getContext('2d');
    g.drawImage(bmp, 0, 0, width, height);
    return { picture: { width, height, rgba: g.getImageData(0, 0, width, height).data.buffer }, size: sizeForAspect(bmp.width, bmp.height) };
  } finally { bmp.close?.(); }
}

/**
 * Bytes a storyboard run holds at its peak, by phase. Keyframes: SANA's three
 * models and the DC-AE encoder. Clips: the transformer with its VACE blocks, the
 * keys and values of every clip's prompt (45 blocks), and per token the residual
 * stream, the VACE state and the attention's and feed-forward's widest tensors.
 */
export function storyPeakBytes({ tokens, clips }, { ditBytes, sanaBytes, encoderShardBytes, embedBytes }) {
  const perToken = 1536 * 4 * 8 + 1536 * 2 * 8 + 8960 * 2 * 2 + 384 * 4;
  const clipPhase = ditBytes + clips * 45 * 2 * 512 * 1536 * 2 + tokens * perToken + 384 * MB;
  const keyframes = sanaBytes + 512 * MB;
  const encoder = encoderShardBytes * 2 + embedBytes + 256 * MB;
  return { clips: clipPhase, keyframes, encoder, peak: Math.max(clipPhase, keyframes, encoder) };
}

/**
 * Can this device make a storyboard video of `seconds` at `size`, and what would it
 * download? Downloads nothing.
 * @param {{ seconds?: number, size?: string }} [opts]
 * @param {{ registry?: object, registryUrl?: string, model?: string, store?: { has(url: string, bytes: number): Promise<boolean> }, gpu?: any, probeMemory?: boolean }} [env]
 */
export async function estimateStory({ seconds = 9, size = '832x480' } = {}, env = {}) {
  const registry = env.registry || await loadRegistry(env.registryUrl);
  let model;
  try { model = getModel(registry, env.model || STORY_MODEL); } catch { model = null; }
  const variant = model ? (model.devices.webgpu || [])[0] : null;
  const files = variant ? variantFiles(model, variant) : [];
  const downloadBytes = files.reduce((s, f) => s + f.size, 0);
  let missingBytes = downloadBytes;
  if (env.store && files.length) {
    try {
      const have = await Promise.all(files.map(f => env.store.has(f.url, f.size)));
      missingBytes = files.reduce((s, f, i) => s + (have[i] ? 0 : f.size), 0);
    } catch { /* count it all */ }
  }
  const [width, height] = String(size).split('x').map(Number);
  const clips = clipCount(seconds);
  const frames = Math.max(...clipFrames(clips, CARRY));
  const g = grid({ width, height, frames });
  const sizeOf = p => files.filter(f => p.test(`${f.part}:${f.path}`)).reduce((s, f) => s + f.size, 0);
  const shards = files.filter(f => /t5\/encoder_\d+\.onnx$/.test(f.path)).length || 1;
  const mem = storyPeakBytes({ tokens: g.tokens, clips }, {
    ditBytes: sizeOf(/^(web|vace):dit\//), sanaBytes: sizeOf(/^sana(w|enc):/),
    encoderShardBytes: sizeOf(/^web:t5\/encoder_/) / shards, embedBytes: sizeOf(/^web:t5\/embed/),
  });
  const base = { downloadBytes, missingBytes, memoryBytes: mem.peak, width, height, clips, seconds: clips * 3, tokens: g.tokens };
  if (!variant) return { fits: false, reason: 'no-webgpu-variant', ...base };
  const reason = await deviceReason(env, Math.max(g.tokens * 8960 * 2, width * height * 64 * 4 * 4), mem.peak);
  return { fits: !reason, reason, ...base };
}
