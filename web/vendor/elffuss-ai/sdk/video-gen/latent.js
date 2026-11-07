// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The latent video of Wan 2.1 and what the transformer reads from it. The VAE
// turns 1 + 4k frames of W × H pixels into 1 + k latent frames of 16 channels at
// W/8 × H/8; the transformer cuts each latent frame into 2 × 2 patches (one
// token each, 64 values). Patchify and unpatchify are plain reorderings, done
// here and not in the graphs, so the sampler works on a flat array in the
// latent's own order [16, F, H, W]. The rotary position tables and the
// timestep's sinusoid are computed here too, in double precision.

/** Frames per second of Wan 2.1 videos. */
export const FPS = 16;
/** Channels of the latent. */
export const LATENT_CHANNELS = 16;
/** Values per token (16 channels × 2 × 2 pixels of the latent). */
export const TOKEN_VALUES = 64;
/** Hidden size and heads of the 1.3B transformer. */
export const DIM = 1536;
export const HEADS = 12;

/**
 * Sizes of a generation: pixels, frames, latent and tokens.
 * @param {{ width: number, height: number, frames: number }} o width and height multiples of 16, frames 1 + 4k
 */
export function grid({ width, height, frames }) {
  if (!(Number.isInteger(width) && Number.isInteger(height) && width >= 16 && height >= 16 && width % 16 === 0 && height % 16 === 0)) {
    throw new RangeError(`width and height must be multiples of 16, not ${width} × ${height}`);
  }
  if (!(Number.isInteger(frames) && frames >= 1 && (frames - 1) % 4 === 0)) throw new RangeError(`frames must be 1 + 4k, not ${frames}`);
  const f = (frames - 1) / 4 + 1, h = height / 8, w = width / 8;
  return { width, height, frames, f, h, w, ph: h / 2, pw: w / 2, tokensPerFrame: (h / 2) * (w / 2), tokens: f * (h / 2) * (w / 2), latentSize: LATENT_CHANNELS * f * h * w };
}

/** Frames of a video of about `seconds` (FPS frames a second): 1 + 4k, at least 5. */
export function framesFor(seconds) {
  const k = Math.max(1, Math.round((seconds * FPS) / 4));
  return 1 + 4 * k;
}

/**
 * Tokens of latent frames [f0, f0 + nf) in the patch embedding's order: per token
 * (frame, row, column), its 64 values as (channel, dy, dx).
 * @param {Float32Array} z latent [16, F, H, W]
 * @param {{ f: number, h: number, w: number }} g
 * @param {number} [f0] first frame
 * @param {number} [nf] frames
 */
export function patchify(z, g, f0 = 0, nf = g.f - f0) {
  const { f: F, h: H, w: W } = g, ph = H / 2, pw = W / 2;
  const out = new Float32Array(nf * ph * pw * 64);
  let o = 0;
  for (let t = f0; t < f0 + nf; t++) for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    for (let c = 0; c < 16; c++) {
      const base = ((c * F + t) * H + 2 * y) * W + 2 * x;
      out[o++] = z[base]; out[o++] = z[base + 1]; out[o++] = z[base + W]; out[o++] = z[base + W + 1];
    }
  }
  return out;
}

/**
 * The transformer's output tokens (64 values as (dy, dx, channel)) written back
 * into latent frames [f0, f0 + nf) of `into` [16, F, H, W].
 * @param {Float32Array} tokens
 * @param {{ f: number, h: number, w: number }} g
 * @param {Float32Array} [into]
 */
export function unpatchify(tokens, g, f0 = 0, nf = g.f - f0, into = new Float32Array(16 * g.f * g.h * g.w)) {
  const { f: F, h: H, w: W } = g, ph = H / 2, pw = W / 2;
  let o = 0;
  for (let t = f0; t < f0 + nf; t++) for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) for (let c = 0; c < 16; c++) {
      into[((c * F + t) * H + 2 * y + dy) * W + 2 * x + dx] = tokens[o++];
    }
  }
  return into;
}

/** Inverse frequencies of one axis of the rotary embedding (dimension `n`). */
function inverse(n) {
  return Array.from({ length: n / 2 }, (_, j) => 1 / Math.pow(10000, (2 * j) / n));
}
const HEAD = DIM / HEADS;
const AXES = [HEAD - 4 * Math.floor(HEAD / 6), 2 * Math.floor(HEAD / 6), 2 * Math.floor(HEAD / 6)].map(inverse); // 22, 21, 21

/**
 * Rotary tables of Wan's 3D position embedding for `nf` latent frames from
 * frame `f0`: per token, 64 angles (22 for time, 21 for rows, 21 for columns).
 * @returns {{ cos: Float32Array, sin: Float32Array }} each [tokens, 64]
 */
export function ropeTables(g, f0 = 0, nf = g.f - f0) {
  const ph = g.h / 2, pw = g.w / 2, S = nf * ph * pw;
  const cos = new Float32Array(S * 64), sin = new Float32Array(S * 64);
  let r = 0;
  for (let t = 0; t < nf; t++) for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++, r++) {
    let k = r * 64;
    for (const v of AXES[0]) { const a = (f0 + t) * v; cos[k] = Math.cos(a); sin[k++] = Math.sin(a); }
    for (const v of AXES[1]) { const a = y * v; cos[k] = Math.cos(a); sin[k++] = Math.sin(a); }
    for (const v of AXES[2]) { const a = x * v; cos[k] = Math.cos(a); sin[k++] = Math.sin(a); }
  }
  return { cos, sin };
}

/** The timestep's sinusoid, 256 values (cosines then sines), as Wan computes it in float64. */
export function timeFrequencies(t) {
  const out = new Float32Array(256);
  for (let i = 0; i < 128; i++) {
    const a = t * Math.pow(10000, -i / 128);
    out[i] = Math.cos(a);
    out[128 + i] = Math.sin(a);
  }
  return out;
}
