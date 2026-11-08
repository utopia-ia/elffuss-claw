// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Video from text in the browser, with Wan 2.1 T2V 1.3B (Wan-AI, Apache-2.0)
// distilled to a few steps, on WebGPU. Heavy: it downloads gigabytes once and
// needs a capable graphics card, so ask `estimate()` first; it never pretends to run
// where it cannot. The model comes through the Elffuss model store, at pinned
// revisions; nothing of the prompt or the video leaves the browser.

import { Task, TASK_OPTIONS } from '../core/task.js';

export { estimate, probeGpuMemory } from './estimate.js';
export { SIZES, SECONDS, STEPS, normalizeOptions } from './options.js';
export { StoryVideo, readPhoto, estimateStory, storyPeakBytes, STORY_MODEL, planStory, checkPlan, splitActions, sizeForAspect, containRect, clipCount, clipFrames, videoFrames, PLAN_GUIDE, STORY_SIZES, MAX_CLIPS, SHOT_SECONDS, SDEDIT_TIME } from './story.js';

/**
 * Whether this browser may run the task at all: WebGPU gives it an adapter. It
 * downloads nothing; `estimate()` says whether a given video fits this device.
 * @returns {Promise<boolean>}
 */
export async function supported() {
  try { return Boolean(await globalThis.navigator?.gpu?.requestAdapter()); } catch { return false; }
}

/** Stages a run reports, in order (`onProgress` events carry `stage`, `index`, `count`). */
export const STAGES = Object.freeze(['download', 'encode', 'load', 'step', 'decode', 'mux']);

const withStage = onProgress => onProgress && (p => onProgress(p?.status === 'downloading' || p?.status === 'checking' ? { ...p, stage: 'download' } : p));

/**
 * Text to video. Runs in a Worker; the first `load()` or `run()` downloads the
 * model into the store (several gigabytes, once) and checks every file.
 *
 * ```js
 * import { TextToVideo, estimate } from '@elffuss/ai/video-gen';
 * const can = await estimate({ seconds: 2, size: '832x480' });   // { fits, reason, downloadBytes, missingBytes, … }
 * const t2v = new TextToVideo({ onProgress: p => console.log(p.stage, p.index, p.count) });
 * const { blob, mime, width, height, seconds, fps, seed } = await t2v.run(null, { prompt: 'a red fox in the snow', seconds: 2 });
 * await t2v.dispose();
 * ```
 *
 * `run(input, opts)`: `input` is ignored (pass null) or the prompt; `opts` is
 * `{ prompt, seconds, size, seed, steps, audio }`, every field JSON except
 * `audio` (`{ sampleRate, channels: Float32Array[] }`, fitted to the video).
 * Cancel with the `signal` of the constructor or of `run()`: the Worker is
 * stopped and every WebGPU buffer goes with it.
 * @extends Task
 */
export class TextToVideo extends Task {
  /** @param {import('../core/task.js').TaskOptions} [options] */
  constructor(options = {}) {
    super({
      task: 'text-to-video',
      workerUrl: new URL('./worker.js', import.meta.url),
      impl: () => import('./impl.js'),
      prepare: async input => ({ value: typeof input === 'string' ? input : null, transfer: [] }),
    }, { device: 'webgpu', ...options, onProgress: withStage(options.onProgress) });
  }
}

/**
 * One video, then everything released: `await generate({ prompt, seconds, size, seed, steps })`.
 * The task's options (`onProgress`, `signal`, `store`, …) go in the same object.
 * This is the chat tool `video.generate`: its `args` are this object, unchanged.
 * @returns {Promise<{ blob: Blob, mime: string, width: number, height: number, seconds: number, fps: number,
 *   frames: number, seed: number, steps: number, model: string, device: string }>}
 */
export async function generate(options = {}) {
  const ctor = {}, run = {};
  for (const [k, v] of Object.entries(options)) (TASK_OPTIONS.includes(k) ? ctor : run)[k] = v;
  const t = new TextToVideo(ctor);
  try { return await t.run(null, run); } finally { await t.dispose(); }
}
