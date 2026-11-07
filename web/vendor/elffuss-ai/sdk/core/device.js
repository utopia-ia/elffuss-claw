// SPDX-License-Identifier: Apache-2.0 AND MIT
// Copyright (c) 2026 UtopiaIA
// Portions Copyright (c) 2026 Miguel Ángel Durán (runonweb.ai, MIT; see LICENSES/MIT-runonweb.txt):
//   the probe of probeWebGPU (packages/runonweb/src/core/device.ts:9-54), the
//   shader-failure test of isShaderError (packages/runonweb/src/remove-bg/index.ts:18-21)
//   and the thread rule of threadCount (packages/runonweb/src/core/pipeline.ts:54-58).
//
// Which backend and which file variant a model runs with. The registry lists the
// variants of each model per backend in order of preference; this module never
// switches backend on its own: asking for a backend the model does not declare,
// or for WebGPU without a usable adapter, is an error.

import { AiError } from './errors.js';

/**
 * @typedef {{ available: boolean, shaderF16: boolean, fallbackAdapter: boolean, reason?: string }} WebGPUProbe
 * @typedef {'auto'|'webgpu'|'wasm'} DeviceRequest
 * @typedef {{ device: 'webgpu'|'wasm', dtype: string, variant: import('./registry.js').RegistryVariant, index: number }} DeviceChoice
 */

/** @type {Promise<WebGPUProbe> | null} */
let probePromise = null;

/**
 * Ask for a WebGPU adapter once per page or Worker. Only a real adapter counts:
 * a software fallback adapter is reported as unavailable.
 * @param {{ gpu?: any, force?: boolean }} [opts] `gpu` replaces navigator.gpu (tests)
 * @returns {Promise<WebGPUProbe>}
 */
export function probeWebGPU({ gpu, force = false } = {}) {
  if (probePromise && !force && gpu === undefined) return probePromise;
  const p = (async () => {
    const api = gpu !== undefined ? gpu : globalThis.navigator?.gpu;
    if (!api) return { available: false, shaderF16: false, fallbackAdapter: false, reason: 'no-webgpu' };
    try {
      const adapter = await api.requestAdapter();
      if (!adapter) return { available: false, shaderF16: false, fallbackAdapter: false, reason: 'no-adapter' };
      const info = adapter.info || {};
      const software = /swiftshader|llvmpipe|lavapipe|software|warp/i.test(`${info.vendor || ''} ${info.architecture || ''} ${info.description || ''}`);
      const fallbackAdapter = Boolean(info.isFallbackAdapter ?? adapter.isFallbackAdapter) || software;
      if (fallbackAdapter) return { available: false, shaderF16: false, fallbackAdapter: true, reason: software ? 'software-adapter' : 'fallback-adapter' };
      return { available: true, shaderF16: Boolean(adapter.features?.has?.('shader-f16')), fallbackAdapter: false };
    } catch {
      return { available: false, shaderF16: false, fallbackAdapter: false, reason: 'adapter-error' };
    }
  })();
  if (gpu === undefined) probePromise = p;
  return p;
}

/** True when a variant's condition holds for this probe. */
export function variantFits(variant, probe) {
  if (!variant.when) return true;
  if (variant.when === 'shader-f16') return Boolean(probe?.shaderF16);
  return false;
}

/**
 * Pick the backend and the variant of a model.
 * `auto` takes WebGPU when the model declares it and there is a usable adapter,
 * else WebAssembly. An explicit backend is taken or refused, never swapped.
 * @param {import('./registry.js').RegistryModel} model
 * @param {DeviceRequest} requested
 * @param {WebGPUProbe} probe
 * @returns {DeviceChoice}
 */
export function chooseVariant(model, requested, probe) {
  const devices = model.devices || {};
  const pick = dev => {
    const list = devices[dev] || [];
    const index = list.findIndex(v => variantFits(v, probe));
    return index < 0 ? null : { device: dev, dtype: list[index].dtype, variant: list[index], index };
  };
  if (requested !== 'auto' && requested !== 'webgpu' && requested !== 'wasm') {
    throw new AiError('device-unsupported', `unknown device ${requested}`, { details: { requested } });
  }
  if (requested === 'webgpu' || requested === 'wasm') {
    if (!devices[requested]) throw new AiError('device-unsupported', `this model does not run on ${requested}`, { details: { requested, declared: Object.keys(devices) } });
    if (requested === 'webgpu' && !probe?.available) throw new AiError('webgpu-unavailable', 'WebGPU is not available in this browser', { details: { reason: probe?.reason } });
    const c = pick(requested);
    if (!c) throw new AiError('device-unsupported', `no ${requested} variant fits this adapter`, { details: { requested } });
    return c;
  }
  if (devices.webgpu && probe?.available) {
    const c = pick('webgpu');
    if (c) return c;
  }
  const c = pick('wasm');
  if (c) return c;
  if (devices.webgpu && !probe?.available) throw new AiError('webgpu-unavailable', 'this model needs WebGPU and it is not available', { details: { reason: probe?.reason } });
  throw new AiError('device-unsupported', 'no variant of this model fits this browser');
}

/** The backends a site needs to ship for a set of models (decides the ONNX Runtime variant). */
export function ortVariantFor(models) {
  return models.some(m => m.devices?.webgpu) ? 'webgpu' : 'wasm';
}

/**
 * True when an error looks like a WebGPU shader or kernel failure. A site that
 * ran with device 'auto' on WebGPU retries once on WebAssembly after any failure;
 * this only labels the reason it reports.
 */
export function isShaderError(err) {
  const message = err instanceof Error ? err.message : String(err?.message ?? err);
  return /Invalid ShaderModule|LayerNorm|failed to call OrtRun|GPUValidationError/i.test(message);
}

/**
 * True when this realm can grow a WebAssembly memory to `bytes`, as the
 * WebAssembly runtime will have to for a large model. It asks for the pages
 * the way that runtime does, before anything is downloaded; a browser that
 * caps WebAssembly lower (or cannot reserve that much) answers false. The probe
 * is dropped at once, and V8 collects it before failing a later allocation.
 * @param {number} bytes
 * @param {{ WebAssembly?: any }} [scope] replaces the global WebAssembly (tests)
 */
export function canGrowWasmMemory(bytes, scope = globalThis) {
  const W = scope.WebAssembly;
  if (typeof W?.Memory !== 'function') return false;
  const pages = Math.ceil(bytes / 65536);
  if (!(pages >= 1 && pages <= 65536)) return false;
  let mem = null;
  try {
    mem = new W.Memory({ initial: 1, maximum: pages });
    if (pages > 1) mem.grow(pages - 1);
    return true;
  } catch {
    return false;
  } finally {
    mem = null;
  }
}

/**
 * Threads for ONNX Runtime's WebAssembly backend: one unless the page is
 * cross-origin isolated (the threaded build needs SharedArrayBuffer).
 * @param {{ isolated?: boolean, cores?: number }} [env]
 */
export function threadCount({ isolated = Boolean(globalThis.crossOriginIsolated), cores = globalThis.navigator?.hardwareConcurrency || 1 } = {}) {
  return isolated ? Math.max(1, Math.min(4, Math.floor(cores / 2))) : 1;
}
