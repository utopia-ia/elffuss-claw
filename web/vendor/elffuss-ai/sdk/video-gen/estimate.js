// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Whether this device can make a video, before anything is downloaded: the
// WebGPU adapter (a real one, with shader-f16, and buffers as large as the
// largest tensor of the run), the memory the run needs at its peak, and the
// download (all of it, and what the model store does not have yet). The
// memory figures come from measured runs of the graphs (see the numbers below);
// a device that does not say how much memory it has is probed by asking WebGPU
// for buffers of that size and giving them back at once, never assumed.

import { getModel, defaultModelId, loadRegistry, variantFiles } from '../core/registry.js';
import { normalizeOptions } from './options.js';

const MB = 1 << 20;

/**
 * Bytes the run holds at its peak, by phase, for a number of tokens. The
 * transformer phase holds its weights (`ditBytes`), the prompt's keys and
 * values, and per token the residual stream, the attention's copies of keys and
 * values and the feed-forward's widest tensor.
 */
export function peakBytes({ tokens, width, height }, { ditBytes, encoderShardBytes, embedBytes, decoderBytes }) {
  const perToken = 1536 * 4 * 6 + 1536 * 2 * 8 + 8960 * 2 * 2;
  const transformer = ditBytes + 30 * 2 * 512 * 1536 * 2 + tokens * perToken + 256 * MB;
  const encoder = encoderShardBytes * 2 + embedBytes + 256 * MB;
  const decoder = decoderBytes * 2 + width * height * (64 * 4 * 4 + 3 * 4 * 4) + 128 * MB;
  return { transformer, encoder, decoder, peak: Math.max(transformer, encoder, decoder) };
}

/** The largest single buffer of a run: the feed-forward's hidden tensor, or the decoder's widest. */
export function largestBuffer({ tokens, width, height }) {
  return Math.max(tokens * 8960 * 2, width * height * 64 * 4 * 4);
}

/**
 * Can this device make the video `opts` asks for, and what would it download?
 * Downloads nothing. Without a store, `missingBytes` is the whole download.
 * @param {{ seconds?: number, size?: string, steps?: number }} [opts]
 * @param {{ registry?: object, registryUrl?: string, model?: string, store?: { has(url: string, bytes: number): Promise<boolean> },
 *   gpu?: any, probeMemory?: boolean }} [env]
 * @returns {Promise<{ fits: boolean, reason: string|null, downloadBytes: number, missingBytes: number, memoryBytes: number,
 *   width: number, height: number, frames: number, seconds: number, tokens: number }>}
 */
export async function estimate(opts = {}, env = {}) {
  const o = normalizeOptions({ ...opts, prompt: 'x' }); // the prompt does not change the estimate
  const registry = env.registry || await loadRegistry(env.registryUrl);
  const model = getModel(registry, env.model || defaultModelId(registry, 'text-to-video'));
  const variant = (model.devices.webgpu || [])[0];
  const files = variant ? variantFiles(model, variant) : [];
  const downloadBytes = files.reduce((s, f) => s + f.size, 0);
  let missingBytes = downloadBytes;
  if (env.store && files.length) {
    try {
      const have = await Promise.all(files.map(f => env.store.has(f.url, f.size)));
      missingBytes = files.reduce((s, f, i) => s + (have[i] ? 0 : f.size), 0);
    } catch { /* the store did not answer: count it all */ }
  }
  const size = p => files.filter(f => p.test(f.path)).reduce((s, f) => s + f.size, 0);
  const shards = files.filter(f => /t5\/encoder_\d+\.onnx/.test(f.path));
  const mem = peakBytes(o.g, {
    ditBytes: size(/^dit\//),
    encoderShardBytes: shards.length ? size(/^t5\/encoder_/) / (shards.length / 2) : 0,
    embedBytes: size(/^t5\/embed/),
    decoderBytes: size(/^vae\//),
  });
  const base = { downloadBytes, missingBytes, memoryBytes: mem.peak, width: o.width, height: o.height, frames: o.frames, seconds: o.seconds, tokens: o.g.tokens };
  const no = reason => ({ fits: false, reason, ...base });
  if (!variant) return no('no-webgpu-variant');
  const gpu = env.gpu !== undefined ? env.gpu : globalThis.navigator?.gpu;
  if (!gpu) return no('no-webgpu');
  let adapter;
  try { adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch { adapter = null; }
  if (!adapter) return no('no-adapter');
  const info = adapter.info || {};
  if (info.isFallbackAdapter || /swiftshader|llvmpipe|lavapipe|software|warp/i.test(`${info.vendor || ''} ${info.architecture || ''} ${info.description || ''}`)) return no('software-adapter');
  if (!adapter.features?.has?.('shader-f16')) return no('no-shader-f16');
  const need = largestBuffer(o.g);
  if ((adapter.limits?.maxBufferSize ?? 0) < need || (adapter.limits?.maxStorageBufferBindingSize ?? 0) < need) return no('buffers-too-small');
  if (env.probeMemory !== false && !(await probeGpuMemory(adapter, mem.peak))) return no('not-enough-memory');
  return { fits: true, reason: null, ...base };
}

/**
 * True when the adapter's device gives `bytes` of buffers (in pieces no larger
 * than its limit), checked with an error scope and released at once.
 */
export async function probeGpuMemory(adapter, bytes) {
  let device = null;
  const buffers = [];
  try {
    const limit = Math.min(adapter.limits.maxBufferSize, 1024 * MB);
    device = await adapter.requestDevice({ requiredLimits: { maxBufferSize: limit } });
    device.pushErrorScope('out-of-memory');
    for (let left = bytes; left > 0; left -= limit) {
      buffers.push(device.createBuffer({ size: Math.min(limit, left) & ~3, usage: 128 /* STORAGE */ }));
    }
    const err = await device.popErrorScope();
    return !err;
  } catch {
    return false;
  } finally {
    for (const b of buffers) { try { b.destroy(); } catch { /* gone */ } }
    try { device?.destroy(); } catch { /* gone */ }
  }
}
