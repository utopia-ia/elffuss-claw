// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The arithmetic of Stable Audio 3 Small around its networks, as Stability AI's
// own MLX pipeline does it (github.com/Stability-AI/stable-audio-3,
// optimized/mlx/models/defs/sa3_pipeline.py; no code is copied): the latent
// length of a duration, the sampling schedule (linear in t, warped through
// log-SNR) and one step of the ping-pong sampler of the rf_denoiser models:
//
//   denoised = x - t · v(x, t)
//   x        = (1 - t_next) · denoised + t_next · noise      (the last step keeps denoised)
//
// Pure, no DOM.

/** Sample rate of Stable Audio 3 (stereo). */
export const SAMPLE_RATE = 44100;
/** Audio samples per latent position. */
export const SAMPLES_PER_LATENT = 4096;
/** Channels of a latent position. */
export const LATENT_CHANNELS = 256;
/** Steps the distilled models were tuned for. */
export const DEFAULT_STEPS = 8;

/** Latent positions for a duration in seconds (natural ceiling, at least 1). */
export function latentLength(seconds) {
  return Math.max(1, Math.ceil((seconds * SAMPLE_RATE) / SAMPLES_PER_LATENT));
}

/**
 * The SAME-S decoder needs an even number of positions: the length it is given
 * (the last position repeated when needed). Its windows are local, so the
 * repeated position only adds audio after the end, which is cut.
 */
export function decoderLength(length) {
  return length % 2 ? length + 1 : length;
}

/** log-SNR shift of t in [0, 1] (rate 0: the same for every length). Ends are kept. */
export function logsnrShift(t, anchor = -6.2, end = 2.0) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const logsnr = end - t * (end - anchor);
  return 1 / (1 + Math.exp(logsnr));
}

/**
 * The noise levels of a run: steps + 1 values from 1 down to 0.
 * @param {number} steps
 * @returns {Float32Array}
 */
export function schedule(steps) {
  if (!(Number.isInteger(steps) && steps >= 1)) throw new RangeError('steps must be an integer of at least 1');
  const out = new Float32Array(steps + 1);
  for (let i = 0; i <= steps; i++) out[i] = logsnrShift(1 - i / steps);
  out[0] = 1;
  return out;
}

/**
 * One ping-pong step, in place on `x`.
 * @param {Float32Array} x the latent
 * @param {Float32Array} v the velocity the DiT gave at t
 * @param {number} t this step's level
 * @param {number} tNext the next level (0 on the last step)
 * @param {Float32Array|null} noise fresh normal noise of x's size (null on the last step)
 */
export function pingpongStep(x, v, t, tNext, noise) {
  if (v.length !== x.length || (noise && noise.length !== x.length)) throw new RangeError('x, v and noise must have the same size');
  const last = !noise || !(tNext > 0);
  for (let i = 0; i < x.length; i++) {
    const d = x[i] - t * v[i];
    x[i] = last ? d : (1 - tNext) * d + tNext * noise[i];
  }
  return x;
}

/**
 * The decoder's PCM ([1, frames, 2] int32 at full scale ±32767) as planar float
 * channels in [-1, 1], cut to `frames`.
 * @param {Int32Array} pcm
 * @param {number} frames
 * @returns {Float32Array[]}
 */
export function pcmToChannels(pcm, frames, channels = 2) {
  const n = Math.min(frames, Math.floor(pcm.length / channels));
  const out = Array.from({ length: channels }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) out[c][i] = pcm[i * channels + c] / 32767;
  return out;
}
