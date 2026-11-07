// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// What the depth model (Depth Anything V2 Small, through ONNX Runtime) takes,
// read from its preprocessor_config.json: the size (DPT's rule: the side nearest
// to its scale reaches the model's size, keeping the photo's shape, in multiples
// of 14) and the normalisation. Pure: Node tests it.

import { AiError } from '../core/errors.js';

/**
 * The model's input settings, checked.
 * @param {object} cfg the parsed preprocessor_config.json
 * @returns {{ size: number, multiple: number, mean: number[], std: number[], rescale: number, keepAspect: boolean }}
 */
export function depthSpec(cfg) {
  const size = cfg?.size?.height ?? cfg?.size?.shortest_edge ?? cfg?.size;
  const ok = Number.isInteger(size) && size >= 14 && Array.isArray(cfg?.image_mean) && cfg.image_mean.length === 3 && Array.isArray(cfg?.image_std) && cfg.image_std.length === 3;
  if (!ok) throw new AiError('model-mismatch', 'the depth model does not say its input size and normalisation');
  return {
    size, multiple: cfg.ensure_multiple_of || 1, mean: cfg.image_mean, std: cfg.image_std,
    rescale: cfg.do_rescale === false ? 1 : cfg.rescale_factor ?? 1 / 255, keepAspect: cfg.keep_aspect_ratio !== false,
  };
}

/** Width and height the model sees a W × H photo at (DPT: the scale nearest to 1 for both sides). */
export function depthInputSize(W, H, spec) {
  let sh = spec.size / H, sw = spec.size / W;
  if (spec.keepAspect) { if (Math.abs(1 - sw) < Math.abs(1 - sh)) sh = sw; else sw = sh; }
  const m = spec.multiple;
  const fit = v => Math.max(m, Math.round(v / m) * m);
  return [fit(W * sw), fit(H * sh)];
}

/** Planar float input (1 × 3 × h × w) of RGBA pixels already at the model's size. */
export function toDepthInput(rgba, w, h, spec) {
  const n = w * h, out = new Float32Array(3 * n);
  for (let c = 0; c < 3; c++) {
    const m = spec.mean[c], s = spec.std[c];
    for (let i = 0; i < n; i++) out[c * n + i] = (rgba[i * 4 + c] * spec.rescale - m) / s;
  }
  return out;
}
