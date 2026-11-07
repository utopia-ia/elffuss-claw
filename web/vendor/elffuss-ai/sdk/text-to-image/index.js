// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// @elffuss/ai/text-to-image: pictures from a text, in the browser. SANA-Sprint
// 0.6B (NVlabs, Apache-2.0), with its Gemma 2 text model, on WebGPU with ONNX
// Runtime Web; the model comes through the Elffuss model store at a pinned
// revision. One to four steps; the same prompt, seed, steps and size give the same
// picture, the one the reference pipeline (diffusers) gives for them.
//
//   import { TextToImage } from '@elffuss/ai/text-to-image';
//   const image = new TextToImage({ onProgress: p => console.log(p.status, p.stage) });
//   const { blob, width, height, seed } = await image.generate({ prompt: 'a red fox in the snow', aspect: '16:9', seed: 7 });
//   await image.dispose();

import { Task, oneShot } from '../core/task.js';
import { loadRegistry, getModel, defaultModelId, variantFiles } from '../core/registry.js';
import { probeWebGPU, chooseVariant } from '../core/device.js';
import { toAiError } from '../core/errors.js';
import { normalizeRequest } from './request.js';

export { normalizeRequest, DEFAULT_STEPS, MAX_PROMPT_CHARS } from './request.js';
export { ASPECTS, TRAINED_SIZES, resolveSize } from './shapes.js';
export { MAX_SEED, randomSeed } from './rng.js';

/**
 * @typedef {import('./request.js').ImageRequest} ImageRequest
 * @typedef {{ blob: Blob, mime: 'image/png', width: number, height: number, seed: number, steps: number, prompt: string,
 *   aspect: string|null, model: string, device: 'webgpu', promptTokens: number, truncated: boolean }} ImageResult
 *   What `generate()` gives: the picture as a PNG `blob` and everything needed to
 *   make it again (`seed`, `steps`, `prompt`, `aspect` or `width` × `height`).
 *   `truncated`: the prompt was longer than the 300 tokens the model reads.
 * @typedef {{ fits: boolean, reason: null|'webgpu-unavailable'|'shader-f16'|'memory'|'store-unavailable', device: 'webgpu'|null,
 *   downloadBytes: number, missingBytes: number|null }} ImageEstimate
 */

/**
 * Pictures from text. Loads the three models once (through the model store), then
 * makes one picture per `generate(request)`, one after another. Progress events
 * carry `status` ('checking', 'downloading' with `loaded`/`total` bytes, 'loading',
 * 'running', 'done') and, while running, `stage`: 'encode', 'step' (with `step` of
 * `steps`), 'decode', 'encode-png'. `dispose()` releases every session and the
 * memory it holds on the graphics device, and ends the Worker. Needs WebGPU with float16 shaders.
 * @extends Task
 */
export class TextToImage extends Task {
  /** @param {import('../core/task.js').TaskOptions} [options] */
  constructor(options) {
    super({
      task: 'text-to-image',
      workerUrl: new URL('./worker.js', import.meta.url),
      impl: () => import('./impl.js'),
      prepare: async input => ({ value: normalizeRequest(input), transfer: [] }),
    }, options);
  }

  /**
   * Make one picture. Same as `run(request, { signal })`.
   * @param {ImageRequest} request
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<ImageResult>}
   */
  generate(request, opts = {}) {
    return this.run(request, opts);
  }

  /**
   * Before anything is downloaded: can this browser run it, and how much it downloads.
   * `missingBytes` is what the store still lacks (null without a store to ask).
   * @param {{ store?: { has(url: string, bytes: number): Promise<boolean> }, registry?: object, model?: string }} [opts]
   * @param {'auto'|'webgpu'} [device]
   * @returns {Promise<ImageEstimate>}
   */
  static async estimate(opts = {}, device = 'auto') {
    return estimate(opts, device);
  }
}

/**
 * See `TextToImage.estimate`. Phones are refused for memory: the models alone are
 * larger than the memory a phone browser gives one tab.
 * @param {{ store?: { has(url: string, bytes: number): Promise<boolean> }, registry?: object, model?: string, probe?: object, mobile?: boolean }} [opts]
 * @param {'auto'|'webgpu'} [device]
 * @returns {Promise<ImageEstimate>}
 */
export async function estimate({ store, registry, model, probe, mobile } = {}, device = 'auto') {
  const reg = registry || await loadRegistry();
  const m = getModel(reg, model || defaultModelId(reg, 'text-to-image'));
  const bytes = Object.values(m.devices).flat().reduce((a, v) => Math.max(a, v.bytes), 0);
  const p = probe || await probeWebGPU();
  let choice = null, reason = null;
  try { choice = chooseVariant(m, device, p); } catch (err) {
    reason = p.available ? 'shader-f16' : 'webgpu-unavailable';
    if (toAiError(err).code !== 'device-unsupported' && toAiError(err).code !== 'webgpu-unavailable') throw err;
  }
  const isMobile = mobile ?? Boolean(globalThis.navigator?.userAgentData?.mobile || /iPhone|iPad|Android/i.test(globalThis.navigator?.userAgent || ''));
  if (!reason && isMobile) reason = 'memory';
  const files = choice ? variantFiles(m, choice.variant) : [];
  const downloadBytes = choice ? choice.variant.bytes : bytes;
  let missingBytes = null;
  if (store && files.length) {
    try {
      const has = await Promise.all(files.map(f => store.has(f.url, f.size)));
      missingBytes = files.reduce((s, f, i) => s + (has[i] ? 0 : f.size), 0);
    } catch { reason ||= 'store-unavailable'; }
  }
  return { fits: !reason, reason, device: choice ? choice.device : null, downloadBytes, missingBytes };
}

/**
 * Make one picture: load, run once, dispose. Options of the task (`onProgress`,
 * `signal`…) and the request in one object.
 * @type {(request: ImageRequest, options?: import('../core/task.js').TaskOptions) => Promise<ImageResult>}
 */
export const generateImage = oneShot(TextToImage);
