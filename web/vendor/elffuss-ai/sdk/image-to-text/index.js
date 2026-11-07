// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// What a picture shows, in words, in the browser: a detailed caption and its visible text, with Florence-2 base
// (fine-tuned; Microsoft, MIT) on WebGPU or WebAssembly. The model comes from its ONNX repository at the pinned
// revision, through the Elffuss model store. The words are English: an assistant reads them and answers in the
// user's language.

import { Task, oneShot } from '../core/task.js';
import { loadRegistry, getModel, defaultModelId, variantFiles } from '../core/registry.js';
import { probeWebGPU, chooseVariant } from '../core/device.js';
import { toAiError } from '../core/errors.js';

/**
 * Describe a picture. Runs in a Worker; the first `load()` or `run()` asks the model store for the files of the
 * variant this browser can run (WebGPU with shader-f16: fp16 vision and embeddings with a q4 encoder and decoder;
 * WebGPU without it: q4; WebAssembly: q8) and checks their hashes.
 *
 * ```js
 * import { ImageToText } from '@elffuss/ai/image-to-text';
 *
 * const eyes = new ImageToText({ onProgress: p => console.log(p.status) });
 * const { caption, text, lines } = await eyes.run(file);              // { want: 'caption' | 'text' | 'all' }
 * await eyes.dispose();
 * ```
 *
 * `run(input, { want, signal })` takes a `Blob` or `File`, an `ImageBitmap` or an `ImageData`, and resolves to
 * `{ caption, text, lines, width, height, device, dtype }`: `caption` a few sentences, `lines` the lines of visible
 * text (none when there is no text), `text` those lines joined with « · ».
 * @extends Task
 */
export class ImageToText extends Task {
  /** @param {import('../core/task.js').TaskOptions} [options] */
  constructor(options) {
    super({ task: 'image-to-text', workerUrl: new URL('./worker.js', import.meta.url), impl: () => import('./impl.js') }, options);
  }

  /**
   * Before anything is downloaded: can this browser run it, and how much it downloads. `missingBytes` is what the
   * store still lacks (the whole download without a store to ask).
   * @param {{ store?: { has(url: string, bytes: number): Promise<boolean> }, registry?: object, model?: string }} [opts]
   * @param {'auto'|'webgpu'|'wasm'} [device]
   */
  static async estimate(opts = {}, device = 'auto') {
    return estimate(opts, device);
  }
}

/** See `ImageToText.estimate`. */
export async function estimate({ store, registry, model } = {}, device = 'auto') {
  const reg = registry || await loadRegistry();
  const m = getModel(reg, model || defaultModelId(reg, 'image-to-text'));
  const probe = await probeWebGPU();
  let choice;
  try { choice = chooseVariant(m, device, probe); } catch (err) {
    const all = Object.values(m.devices).flat().map((v) => v.bytes);
    return { fits: false, reason: toAiError(err).code, device: null, downloadBytes: Math.min(...all), missingBytes: Math.min(...all) };
  }
  const files = variantFiles(m, choice.variant);
  const downloadBytes = files.reduce((s, f) => s + f.size, 0);
  let missingBytes = downloadBytes;
  if (store) {
    try {
      const has = await Promise.all(files.map((f) => store.has(f.url, f.size)));
      missingBytes = files.reduce((s, f, i) => s + (has[i] ? 0 : f.size), 0);
    } catch { /* the store did not answer: count everything */ }
  }
  return { fits: true, reason: null, device: choice.device, downloadBytes, missingBytes };
}

/**
 * Load, run once and dispose: `await describeImage(file, { want: 'text' })`.
 * @type {(input: Blob|ImageBitmap|ImageData, options?: import('../core/task.js').TaskOptions & { want?: 'all'|'caption'|'text' }) => Promise<object>}
 */
export const describeImage = oneShot(ImageToText);
