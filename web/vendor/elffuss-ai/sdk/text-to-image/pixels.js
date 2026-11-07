// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// From the decoder's output to pixels, as the reference pipeline does it: an
// image of three planes in [-1, 1] (channels first), scaled and centre-cropped to
// the asked size when it differs from the generated one (bilinear, corners not
// aligned, like torch's interpolate), then mapped to 0-255 with rounding.

/**
 * Scale planes so that they cover width × height, then crop the middle.
 * @param {Float32Array} planes channels × h × w
 * @param {number} channels
 * @param {number} h
 * @param {number} w
 * @param {number} width
 * @param {number} height
 * @returns {Float32Array} channels × height × width
 */
export function resizeCrop(planes, channels, h, w, width, height) {
  if (h === height && w === width) return planes;
  const ratio = Math.max(height / h, width / w);
  const rw = Math.trunc(w * ratio), rh = Math.trunc(h * ratio);
  const x0 = Math.trunc((rw - width) / 2), y0 = Math.trunc((rh - height) / 2);
  const out = new Float32Array(channels * width * height);
  const sy = h / rh, sx = w / rw;
  const coord = (o, scale, size) => {
    const src = Math.max(0, (o + 0.5) * scale - 0.5);
    const i0 = Math.min(Math.floor(src), size - 1);
    const i1 = Math.min(i0 + 1, size - 1);
    return [i0, i1, src - i0];
  };
  const xs = Array.from({ length: width }, (_, x) => coord(x + x0, sx, w));
  for (let y = 0; y < height; y++) {
    const [a0, a1, ly] = coord(y + y0, sy, h);
    for (let c = 0; c < channels; c++) {
      const p = c * h * w, q = c * width * height + y * width;
      for (let x = 0; x < width; x++) {
        const [b0, b1, lx] = xs[x];
        const top = planes[p + a0 * w + b0] * (1 - lx) + planes[p + a0 * w + b1] * lx;
        const bottom = planes[p + a1 * w + b0] * (1 - lx) + planes[p + a1 * w + b1] * lx;
        out[q + x] = top * (1 - ly) + bottom * ly;
      }
    }
  }
  return out;
}

/**
 * RGBA bytes of an RGB image of planes in [-1, 1].
 * @param {Float32Array} planes 3 × height × width
 * @returns {Uint8ClampedArray} width × height × 4, opaque
 */
export function toRgba(planes, width, height) {
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = Math.min(1, Math.max(0, planes[c * n + i] * 0.5 + 0.5));
      out[i * 4 + c] = Math.round(v * 255);
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}

/**
 * The token embeddings of `ids` from a table of 4-bit values in blocks of 32 per
 * row: two values per byte (the even column in the low nibble, stored plus 8) and
 * one float16 scale per block.
 * @param {Uint8Array} packed rows × dim / 2 bytes
 * @param {Uint16Array} scales rows × dim / 32 float16 values
 * @param {number[]} ids
 * @param {number} dim
 * @returns {Float32Array} ids.length × dim
 */
export function embedRows(packed, scales, ids, dim) {
  const out = new Float32Array(ids.length * dim);
  const blocks = dim / 32;
  for (let r = 0; r < ids.length; r++) {
    const id = ids[r];
    for (let b = 0; b < blocks; b++) {
      const s = halfToFloat(scales[id * blocks + b]);
      for (let k = 0; k < 16; k++) {
        const byte = packed[id * (dim / 2) + b * 16 + k];
        out[r * dim + b * 32 + 2 * k] = ((byte & 15) - 8) * s;
        out[r * dim + b * 32 + 2 * k + 1] = ((byte >> 4) - 8) * s;
      }
    }
  }
  return out;
}

/** A float16 (as its 16 bits) to a number. */
export function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}
