// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// IEEE half-precision bits from and to float32, for the fp16 inputs of the
// graphs (rotary tables) where the browser has no Float16Array.

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** The half-precision bits of a number, rounded to nearest even. */
export function toHalfBits(v) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    const half = mant >>> shift;
    const rest = mant & ((1 << shift) - 1), mid = 1 << (shift - 1);
    return sign | (half + (rest > mid || (rest === mid && (half & 1)) ? 1 : 0));
  }
  const half = (e << 10) | (mant >>> 13);
  const rest = mant & 0x1fff;
  return sign | (half + (rest > 0x1000 || (rest === 0x1000 && (half & 1)) ? 1 : 0));
}

/** Half-precision bits of every value. */
export function toHalf(values) {
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = toHalfBits(values[i]);
  return out;
}

/** The number half-precision bits stand for. */
export function fromHalfBits(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}
