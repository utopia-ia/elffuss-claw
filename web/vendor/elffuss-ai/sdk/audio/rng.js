// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Seeded random numbers for the diffusion noise: the same seed gives the same
// noise in every run of this module, so a seed reproduces a clip. xoshiro128**
// for uniform numbers (seeded through SplitMix32) and the Box-Muller transform
// for normal ones. Pure, no DOM.

/** Largest seed a page offers (31 bits, so it fits any number field). */
export const MAX_SEED = 2 ** 31 - 1;

/** A seed for a caller that gave none: 0..MAX_SEED. */
export function randomSeed() {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return a[0] & MAX_SEED;
}

/** True for an integer seed in 0..MAX_SEED. */
export function isSeed(seed) {
  return Number.isInteger(seed) && seed >= 0 && seed <= MAX_SEED;
}

function splitmix32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/**
 * A generator of uniform numbers in [0, 1) and standard normal numbers.
 * @param {number} seed integer
 */
export function createRng(seed) {
  const sm = splitmix32(seed);
  let a = sm(), b = sm(), c = sm(), d = sm();
  if (!(a | b | c | d)) a = 1;
  const next = () => {
    const r = Math.imul(((Math.imul(b, 5) << 7) | (Math.imul(b, 5) >>> 25)), 9) >>> 0;
    const t = (b << 9) >>> 0;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t;
    d = ((d << 11) | (d >>> 21)) >>> 0;
    return r;
  };
  let spare = null;
  return {
    /** Uniform in [0, 1), 32 bits. */
    uniform: () => next() / 4294967296,
    /** Standard normal (mean 0, variance 1). */
    normal() {
      if (spare !== null) { const s = spare; spare = null; return s; }
      let u = 0;
      while (u <= 0) u = next() / 4294967296;
      const v = next() / 4294967296;
      const r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(2 * Math.PI * v);
      return r * Math.cos(2 * Math.PI * v);
    },
    /** Fill a Float32Array with standard normal numbers. */
    fillNormal(out) {
      for (let i = 0; i < out.length; i++) out[i] = this.normal();
      return out;
    },
  };
}
