// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The colour of a clip pulled back to its keyframes. A few-step clip drifts to
// more contrast and saturation in the middle; each frame's mean and spread in
// YCbCr (luma and two chroma axes, BT.601 full range) are moved to those of the
// two keyframes, blended by the frame's place in the clip. Six numbers a frame:
// a gain and an offset per axis, applied as one 3 × 3 matrix and one offset in
// RGB (what a shader would do), here on RGBA bytes.

const M = [[0.299, 0.587, 0.114], [-0.168736, -0.331264, 0.5], [0.5, -0.418688, -0.081312]];
const Mi = [[1, 0, 1.402], [1, -0.344136, -0.714136], [1, 1.772, 0]];

/**
 * Mean and standard deviation of an RGBA picture on the YCbCr axes (every `stride`-th pixel).
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @returns {{ mean: number[], std: number[] }}
 */
export function colorStats(rgba, stride = 1) {
  const s = [0, 0, 0], q = [0, 0, 0];
  let n = 0;
  for (let p = 0; p < rgba.length; p += 4 * stride) {
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    for (let a = 0; a < 3; a++) {
      const v = M[a][0] * r + M[a][1] * g + M[a][2] * b;
      s[a] += v; q[a] += v * v;
    }
    n++;
  }
  const mean = s.map(v => v / n);
  return { mean, std: q.map((v, a) => Math.sqrt(Math.max(1e-6, v / n - mean[a] * mean[a]))) };
}

/**
 * The target of frame `i` of `n`: the keyframes' statistics blended linearly.
 */
export function blendStats(a, b, i, n) {
  const w = n > 1 ? i / (n - 1) : 0;
  return { mean: a.mean.map((v, k) => v + w * (b.mean[k] - v)), std: a.std.map((v, k) => v + w * (b.std[k] - v)) };
}

/**
 * The RGB transform that moves `from` to `to` (strength 0..1): rgb' = A·rgb + c.
 * @returns {{ A: number[][], c: number[] }}
 */
export function colorTransform(from, to, strength = 1) {
  const gain = [0, 1, 2].map(k => 1 + strength * (to.std[k] / from.std[k] - 1));
  const mean = [0, 1, 2].map(k => from.mean[k] + strength * (to.mean[k] - from.mean[k]));
  // y' = gain·(y − from.mean) + mean, in YCbCr; back to RGB: A = Mi·diag(gain)·M
  const A = [0, 1, 2].map(r => [0, 1, 2].map(c => Mi[r][0] * gain[0] * M[0][c] + Mi[r][1] * gain[1] * M[1][c] + Mi[r][2] * gain[2] * M[2][c]));
  const off = [0, 1, 2].map(k => mean[k] - gain[k] * from.mean[k]);
  const c = [0, 1, 2].map(r => Mi[r][0] * off[0] + Mi[r][1] * off[1] + Mi[r][2] * off[2]);
  return { A, c };
}

/** Apply a transform in place to RGBA bytes in a Uint8ClampedArray (which rounds and clamps on assignment). */
export function applyTransform(rgba, { A, c }) {
  for (let p = 0; p < rgba.length; p += 4) {
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    rgba[p] = A[0][0] * r + A[0][1] * g + A[0][2] * b + c[0];
    rgba[p + 1] = A[1][0] * r + A[1][1] * g + A[1][2] * b + c[1];
    rgba[p + 2] = A[2][0] * r + A[2][1] * g + A[2][2] * b + c[2];
  }
  return rgba;
}

/**
 * Match a clip's frames (RGBA, in place) to its first and last keyframes.
 * @param {Uint8ClampedArray[]} frames
 * @param {Uint8ClampedArray} first keyframe at the clip's start
 * @param {Uint8ClampedArray} last keyframe at its end
 */
export function matchClip(frames, first, last, strength = 1) {
  const a = colorStats(first, 4), b = colorStats(last, 4);
  frames.forEach((f, i) => applyTransform(f, colorTransform(colorStats(f, 4), blendStats(a, b, i, frames.length), strength)));
  return frames;
}

/**
 * Keep a keyframe painted from another (SDEdit) from piling up contrast: its spread on each
 * YCbCr axis moves back toward the source's (`strength`), its means stay (a new light, night,
 * snow still shows). Each SDEdit step adds a little contrast; down a chain of keyframes it
 * compounds (measured 51 → 72 over two steps). In place, RGBA bytes.
 */
export function anchorSpread(rgba, source, strength = 0.8) {
  const a = colorStats(rgba, 4), b = colorStats(source, 4);
  const to = { mean: a.mean, std: a.std.map((v, k) => v + strength * (b.std[k] - v)) };
  return applyTransform(rgba, colorTransform(a, to));
}
