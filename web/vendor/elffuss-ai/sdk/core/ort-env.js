// SPDX-License-Identifier: Apache-2.0 AND MIT
// Copyright (c) 2026 UtopiaIA
// Portions Copyright (c) 2026 Miguel Ángel Durán (runonweb.ai, MIT; see LICENSES/MIT-runonweb.txt):
//   copying the model bytes before trying WebGPU, so that a WebAssembly session
//   still gets them intact (packages/runonweb/src/ocr/index.ts:271-281), and the
//   single-thread rule (packages/runonweb/src/core/pipeline.ts:54-58).
//
// ONNX Runtime Web used directly (the OCR). The pinned bundle is imported from
// the site's own origin, pointed at its own .wasm, and checked before any
// session exists.

import { AiError, toAiError } from './errors.js';
import { threadCount } from './device.js';
import { assertOrtRuntime } from './runtimes.js';
import { PINS } from './runtime-pins.js';

let loaded = null;

/**
 * Import and set up the pinned ONNX Runtime Web of this site. Once per realm.
 * @param {{ ortBundle: string, ortMjs: string, ortWasm: string }} runtime same-origin URLs
 * @param {{ pins?: typeof PINS }} [opts]
 */
export async function loadOrt(runtime, { pins = PINS } = {}) {
  if (!loaded) {
    loaded = (async () => {
      const abs = u => new URL(u, globalThis.location?.href).href;
      const ort = await import(abs(runtime.ortBundle));
      ort.env.wasm.wasmPaths = { mjs: abs(runtime.ortMjs), wasm: abs(runtime.ortWasm) };
      ort.env.wasm.numThreads = threadCount();
      ort.env.wasm.proxy = false;
      ort.env.logLevel = 'error';
      return ort;
    })();
    loaded.catch(() => { loaded = null; });
  }
  const ort = await loaded;
  assertOrtRuntime(ort, pins);
  return ort;
}

/**
 * Create a session on one backend. With WebGPU the bytes are copied first, so a
 * later WebAssembly attempt receives them intact.
 * @param {any} ort
 * @param {ArrayBuffer|Uint8Array} bytes
 * @param {'webgpu'|'wasm'} device
 * @param {{ providers?: string[] }} [opts] `providers` overrides the list (for example ['webgpu', 'wasm'])
 */
export async function createSession(ort, bytes, device, { providers } = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const input = device === 'webgpu' ? data.slice() : data;
  try {
    return await ort.InferenceSession.create(input, {
      executionProviders: providers || [device],
      graphOptimizationLevel: 'all',
    });
  } catch (err) {
    throw toAiError(err, 'run-failed');
  }
}

/** Release a session; never throws. */
export async function releaseSession(session) {
  try { await session?.release?.(); } catch { /* already gone */ }
}

/** A Float32 tensor of a shape, checking the data length. */
export function tensor(ort, data, dims) {
  const n = dims.reduce((a, b) => a * b, 1);
  if (data.length !== n) throw new AiError('run-failed', `tensor data has ${data.length} values, shape ${dims.join('×')} needs ${n}`);
  return new ort.Tensor('float32', data, dims);
}
