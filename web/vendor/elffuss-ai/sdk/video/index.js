// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// A video from one photo, in the browser: the photo's depth (Depth Anything V2
// Small, Apache-2.0), the background behind what is near painted in (MI-GAN,
// MIT), a camera that moves through the layers, and an MP4 (WebM where the
// browser has no H.264 encoder) with an optional soundtrack. The models come
// from their original Hugging Face repositories at pinned revisions, through
// the Elffuss model store; everything runs in a Worker except decoding a
// soundtrack, which needs Web Audio (a page).

import { Task, TASK_OPTIONS } from '../core/task.js';
import { loadRegistry, getModel, defaultModelId, variantFiles } from '../core/registry.js';
import { probeWebGPU, chooseVariant } from '../core/device.js';
import { toAiError } from '../core/errors.js';
import { soundtrackOf } from './audio.js';
import { normalizeOptions, outputSize, autoQuality } from './options.js';

export { PRESETS, DEFAULT_PRESET, ASPECTS, DEFAULT_ASPECT, LOOPS, planCamera, cameraAt, frameCount, frameTime } from './camera.js';
export { SECONDS, FPS, QUALITY, normalizeOptions, outputSize, autoQuality } from './options.js';
export { createRenderer } from './render.js';
export { encodeVideo, chooseCodecs } from './encode.js';
export { decodeSoundtrack, fitSoundtrack, soundtrackOf } from './audio.js';

/** The task name in the registry. */
export const TASK = 'image-to-video';

/** The quality 'auto' stands for in this page: standard (720) on a phone, high (1080) elsewhere. */
export function pageQuality(env = globalThis) {
  const nav = env.navigator || {};
  const mobile = Boolean(nav.userAgentData?.mobile) || Boolean(env.matchMedia?.('(pointer: coarse) and (max-width: 900px)')?.matches);
  return autoQuality({ mobile, deviceMemory: Number(nav.deviceMemory) });
}

/**
 * A video from a photo. Runs in a Worker (replaced after any failure); the first
 * `load()` or `run()` asks the model store for the files of the variant this
 * browser can run (WebGPU fp16 with shader-f16, WebGPU fp32, else WebAssembly
 * q8; MI-GAN is the same file in all) and checks their hashes.
 *
 * ```js
 * import { Video } from '@elffuss/ai/video';
 * const video = new Video({ onProgress: p => console.log(p.status, p.stage, p.frame, p.frames) });
 * const { blob, mime, width, height, seconds, fps } = await video.run(photo, { preset: 'orbit', seconds: 6, aspect: '9:16', audio: song });
 * await video.dispose();   // the sessions, the drawing context and the Worker
 * ```
 *
 * Progress events: `downloading` (loaded / total bytes of the models), then
 * `running` with `stage` 'depth', 'inpaint', 'render' (with `frame` and `frames`)
 * and 'mux', then `done`. Cancel with `signal`: the Worker is stopped and
 * everything it held is given back. A second run of the same photo reuses its
 * depth and layers.
 * @extends Task
 */
export class Video extends Task {
  /** @param {import('../core/task.js').TaskOptions} [options] */
  constructor(options) {
    super({ task: TASK, workerUrl: new URL('./worker.js', import.meta.url), impl: () => import('./impl.js') }, options);
  }

  /**
   * Make the video of a photo. `image`: a Blob or File (PNG, JPEG, WebP, GIF,
   * BMP or AVIF), an ImageBitmap or an ImageData. Options (plain data; `audio`
   * may also be a Blob, decoded here, in the page):
   * `preset` ('dolly-in', 'orbit', 'swing', 'zoom-pan', 'vertigo'), `seconds`
   * (2-15, 6), `aspect` ('16:9', '9:16', '1:1'), `fps` (24, 25, 30 or 60; 30),
   * `quality` ('auto', 'high' 1080, 'standard' 720), `strength` (of the move,
   * 0.2-2, 1), `effects` ({ dof, vignette, grain }, each 0-1), `container`
   * ('auto', 'mp4', 'webm'), `audio` (a sound file, an AudioBuffer or
   * { sampleRate, channels }: looped or cut to the video, faded out), `signal`.
   * With `output: 'scene'` it gives the photo's layers instead, for a page that
   * previews the moves with createRenderer (see sdk/video/render.js).
   * @param {Blob|ImageBitmap|ImageData} image
   * @param {object} [opts]
   * @returns {Promise<VideoResult>}
   */
  async run(image, opts = {}) {
    const { signal, audio, ...rest } = opts;
    const quality = rest.quality === 'high' || rest.quality === 'standard' ? rest.quality : pageQuality();
    let sound = null;
    if (audio != null && rest.output !== 'scene') {
      try { sound = await soundtrackOf(audio); } catch (err) { throw toAiError(err, 'unsupported-format'); }
    }
    return super.run(image, { ...rest, quality, ...(sound ? { audio: sound } : {}), signal });
  }

  /**
   * The photo's scene for a live preview: its layers (premultiplied RGBA and a
   * disparity plane each), the subject and the edge points the framing keeps out.
   * @param {Blob|ImageBitmap|ImageData} image
   * @param {{ signal?: AbortSignal, quality?: string, previewSide?: number }} [opts]
   */
  scene(image, opts = {}) {
    return this.run(image, { ...opts, output: 'scene' });
  }

  /**
   * Whether this browser can make a video, and what it would download, before
   * downloading anything. `store` (optional, any object with has(url, bytes))
   * tells what is already stored; without it `missingBytes` is the whole download.
   * @param {{ seconds?: number, aspect?: string, quality?: string, store?: { has(url: string, bytes: number): Promise<boolean> },
   *   registry?: object, registryUrl?: string, model?: string, gpu?: any }} [opts]
   * @param {'auto'|'webgpu'|'wasm'} [device]
   * @returns {Promise<{ fits: boolean, reason: string|null, downloadBytes: number, missingBytes: number, device: string|null, width: number, height: number }>}
   */
  static async estimate(opts = {}, device = 'auto') {
    const o = normalizeOptions(opts);
    const quality = opts.quality === 'high' || opts.quality === 'standard' ? opts.quality : pageQuality();
    const { width, height } = outputSize(o.aspect, quality);
    const base = { fits: false, reason: null, downloadBytes: 0, missingBytes: 0, device: null, width, height };
    let registry, model, choice;
    try {
      registry = opts.registry || await loadRegistry(opts.registryUrl);
      model = getModel(registry, opts.model || defaultModelId(registry, TASK));
      choice = chooseVariant(model, device, await probeWebGPU(opts.gpu !== undefined ? { gpu: opts.gpu } : undefined));
    } catch (err) {
      return { ...base, reason: toAiError(err).code };
    }
    const files = variantFiles(model, choice.variant);
    const downloadBytes = choice.variant.bytes;
    let missingBytes = downloadBytes;
    if (opts.store?.has) {
      try { missingBytes = 0; for (const f of files) if (!(await opts.store.has(f.url, f.size))) missingBytes += f.size; } catch { missingBytes = downloadBytes; }
    }
    const g = globalThis;
    let reason = null;
    if (typeof g.VideoEncoder !== 'function' || typeof g.VideoFrame !== 'function') reason = 'webcodecs-unavailable';
    else if (typeof g.OffscreenCanvas !== 'function') reason = 'offscreencanvas-unavailable';
    else {
      try { if (!new g.OffscreenCanvas(1, 1).getContext('webgl2')) reason = 'webgl2-unavailable'; } catch { reason = 'webgl2-unavailable'; }
    }
    return { fits: !reason, reason, downloadBytes, missingBytes, device: choice.device, width, height };
  }
}

/**
 * One call, as a chat tool calls it: `animate({ image, preset, seconds, aspect,
 * audio })` loads the models, makes the video and releases everything. Any
 * option of `Video` (its constructor's and its run's) goes in the same object.
 * @param {{ image: Blob|ImageBitmap|ImageData } & Record<string, any>} args
 * @returns {Promise<VideoResult>}
 */
export async function animate({ image, ...args } = {}) {
  const ctor = {}, run = {};
  for (const [k, v] of Object.entries(args)) (TASK_OPTIONS.includes(k) ? ctor : run)[k] = v;
  const v = new Video(ctor);
  try { return await v.run(image, { ...run, signal: args.signal }); } finally { await v.dispose(); }
}

/**
 * @typedef {{ blob: Blob, mime: string, container: 'mp4'|'webm', videoCodec: string, audioCodec: string|null, width: number,
 *   height: number, fps: number, frames: number, seconds: number, bytes: number, model: string, device: 'webgpu'|'wasm',
 *   dtype: string, preset: string, aspect: string, layers: number }} VideoResult
 *   What `run()` gives: `blob` is the video file (`mime` with its codecs); `layers` is how many depth layers the photo was cut into.
 */
