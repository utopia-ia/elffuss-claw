// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// What Wan 2.1 VACE is told is known: the "control" of a clip. Frames the clip
// must show (keyframes, the last frames of the clip before, a photo) are given
// as pixels with a mask (0 where a pixel is known, 1 where the model paints).
// VACE reads three things per latent position, 96 channels:
//   16  the latents of the known pixels (grey, 0, elsewhere): "inactive"
//   16  the latents of the pixels to paint (the video × mask; with nothing to
//       repaint, all grey): "reactive"
//   64  the mask, each 8 × 8 pixel block folded into 64 channels, and frames to
//       latent frames by the nearest frame (PyTorch's nearest-exact)
// and the transformer embeds them in 2 × 2 patches like the video: 384 values a
// token, in (channel, dy, dx) order. Pure functions over Float32Arrays.

import { grid } from '../latent.js';

/** Channels of the control: inactive, reactive, mask. */
export const CONTROL_CHANNELS = 96;
/** Values of a control token. */
export const CONTROL_VALUES = CONTROL_CHANNELS * 4;

/**
 * Which video frame each latent frame's mask is taken from (nearest-exact over time).
 * @param {number} frames video frames (1 + 4k)
 * @returns {number[]} one index per latent frame
 */
export function maskFrameIndex(frames) {
  const F = (frames - 1) / 4 + 1;
  return Array.from({ length: F }, (_, i) => Math.min(frames - 1, Math.floor((i + 0.5) * (frames / F))));
}

/**
 * The 64-channel mask [64, F, h, w] from per-frame pixel masks.
 * @param {(Uint8Array|null)[]} masks one per video frame: null for a frame to paint
 *   whole, or W × H bytes (0 known, 1 to paint)
 * @param {{ frames: number, width: number, height: number }} size
 * @returns {Float32Array}
 */
export function foldMask(masks, { frames, width, height }) {
  const g = grid({ width, height, frames });
  const { f: F, h, w } = g;
  const out = new Float32Array(64 * F * h * w);
  const idx = maskFrameIndex(frames);
  for (let lf = 0; lf < F; lf++) {
    const m = masks[idx[lf]];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < 8; dx++) {
      const v = m ? m[(8 * y + dy) * width + 8 * x + dx] : 1;
      out[(((dy * 8 + dx) * F + lf) * h + y) * w + x] = v;
    }
  }
  return out;
}

/**
 * Control tokens [S × 384] from the inactive and reactive latents [16, F, h, w]
 * and the folded mask [64, F, h, w].
 */
export function controlTokens(inactive, reactive, mask, { f: F, h, w }) {
  const ph = h / 2, pw = w / 2;
  const out = new Float32Array(F * ph * pw * CONTROL_VALUES);
  const planes = [[inactive, 16], [reactive, 16], [mask, 64]];
  let o = 0;
  for (let t = 0; t < F; t++) for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    for (const [src, C] of planes) {
      for (let c = 0; c < C; c++) {
        const base = ((c * F + t) * h + 2 * y) * w + 2 * x;
        out[o++] = src[base]; out[o++] = src[base + 1]; out[o++] = src[base + w]; out[o++] = src[base + w + 1];
      }
    }
  }
  return out;
}

/**
 * The pixels of a clip's known frames for the encoder, in [0, 1] planar [T, 3, H, W]
 * (grey, 0.5, where nothing is known), and the per-frame masks.
 * @param {{ frame: number, rgba: Uint8ClampedArray, rect?: { x: number, y: number, w: number, h: number } }[]} known
 *   `rect`: only that part of the frame is known (a photo that does not fill it)
 * @param {{ frames: number, width: number, height: number }} size
 * @returns {{ pixels: Float32Array, masks: (Uint8Array|null)[] }}
 */
export function knownFrames(known, { frames, width, height }) {
  const px = width * height;
  const pixels = new Float32Array(frames * 3 * px).fill(0.5);
  const masks = new Array(frames).fill(null);
  for (const k of known) {
    if (!(k.frame >= 0 && k.frame < frames)) throw new RangeError(`known frame ${k.frame} is outside the clip`);
    const r = k.rect || { x: 0, y: 0, w: width, h: height };
    const m = new Uint8Array(px).fill(1);
    const o = k.frame * 3 * px;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      const p = y * width + x;
      m[p] = 0;
      pixels[o + p] = k.rgba[p * 4] / 255;
      pixels[o + px + p] = k.rgba[p * 4 + 1] / 255;
      pixels[o + 2 * px + p] = k.rgba[p * 4 + 2] / 255;
    }
    masks[k.frame] = m;
  }
  return { pixels, masks };
}
