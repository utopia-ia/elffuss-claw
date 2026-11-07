// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The Gaussian noise of a generation, drawn the same way in any language: every
// value comes from (seed, stream, index) through a 32-bit integer hash and the
// Box-Muller transform, so the browser and a reference run elsewhere start
// from the very same latent. A stream is one use of noise: 0 the starting
// latent, 1, 2, … the noise added back between steps.

/** A 32-bit integer hash (an avalanche mix of shifts and odd multiplications). */
export function hash32(x) {
  x >>>= 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/** The base key of a (seed, stream) pair. */
function baseKey(seed, stream) {
  return hash32((seed >>> 0) ^ hash32(Math.imul(stream >>> 0, 0x9e3779b9) >>> 0));
}

/**
 * `count` standard normal values of one stream, from value `offset` on.
 * Values come in pairs, so a run that starts at an odd offset recomputes the
 * pair it starts in; any slice equals the same slice of the whole stream.
 * @param {number} seed 32-bit seed
 * @param {number} stream which use of noise (0 the start, 1… the steps)
 * @param {number} count how many values
 * @param {{ offset?: number, out?: Float32Array }} [opts]
 * @returns {Float32Array}
 */
export function gaussian(seed, stream, count, { offset = 0, out = new Float32Array(count) } = {}) {
  const base = baseKey(seed, stream);
  const baseB = hash32((base ^ 0x68e31da4) >>> 0);
  const TWO_PI = 2 * Math.PI, INV = 1 / 4294967296;
  for (let j = 0; j < count; j++) {
    const k = offset + j;
    const i = k >>> 1;
    const a = hash32(((i * 2) >>> 0) ^ base);
    const b = hash32(((i * 2 + 1) >>> 0) ^ baseB);
    const r = Math.sqrt(-2 * Math.log((a + 1) * INV));
    const th = TWO_PI * (b * INV);
    out[j] = k & 1 ? r * Math.sin(th) : r * Math.cos(th);
  }
  return out;
}

/** A seed for a generation when the caller gives none: 31 random bits. */
export function randomSeed() {
  const u = new Uint32Array(1);
  globalThis.crypto.getRandomValues(u);
  return u[0] >>> 1;
}
