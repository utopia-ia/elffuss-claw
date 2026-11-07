// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Gaussian noise drawn exactly as PyTorch draws it on the CPU, so that a seed gives
// here the same starting noise as the reference pipeline (diffusers with
// `torch.Generator('cpu').manual_seed(seed)`): the same picture for the same prompt
// and seed. PyTorch seeds a 32-bit Mersenne Twister (MT19937) with the seed, fills a
// float tensor of 16 or more values with uniforms of 24 bits, and turns them into
// normals in blocks of 16 with the Box-Muller transform (value j with value j + 8);
// a size that is not a multiple of 16 redraws the last 16. The arithmetic is done
// in float32 as PyTorch does (Math.fround), which matches it to the last bit or
// one unit in the last place.

const N = 624, M = 397;

/** A Mersenne Twister of 32 bits, seeded as PyTorch seeds its CPU generator. */
export class Mt19937 {
  /** @param {number} seed an integer; only its low 32 bits count, as in PyTorch */
  constructor(seed) {
    const mt = new Uint32Array(N);
    mt[0] = seed >>> 0;
    for (let i = 1; i < N; i++) {
      const x = mt[i - 1] ^ (mt[i - 1] >>> 30);
      // 1812433253 * x + i, modulo 2^32, without losing bits to doubles.
      mt[i] = ((((x & 0xffff0000) >>> 16) * 1812433253) << 16) + (x & 0x0000ffff) * 1812433253 + i;
    }
    this.mt = mt;
    this.i = N;
  }

  /** The next 32-bit unsigned integer. */
  next() {
    const mt = this.mt;
    if (this.i >= N) {
      for (let k = 0; k < N; k++) {
        const y = (mt[k] & 0x80000000) | (mt[(k + 1) % N] & 0x7fffffff);
        mt[k] = mt[(k + M) % N] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.i = 0;
    }
    let y = mt[this.i++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** A uniform float in [0, 1) from 24 random bits, as PyTorch makes a float one. */
  uniform() {
    return Math.fround((this.next() & 0xffffff) / 16777216);
  }
}

const f = Math.fround;
const TWO_PI = 2 * Math.PI;

/** Box-Muller over 16 uniforms in place: value j pairs with value j + 8. */
function normal16(data, at) {
  for (let j = 0; j < 8; j++) {
    const u1 = f(1 - data[at + j]);
    const u2 = data[at + j + 8];
    const radius = f(Math.sqrt(f(-2 * f(Math.log(u1)))));
    const theta = f(TWO_PI * u2);
    data[at + j] = f(radius * f(Math.cos(theta)));
    data[at + j + 8] = f(radius * f(Math.sin(theta)));
  }
}

/**
 * `torch.randn(n, generator=g)` for a float tensor of n ≥ 16 values, from the
 * generator's current state (later calls continue the same sequence, as the
 * pipeline's noise for each step does).
 * @param {Mt19937} gen
 * @param {number} n
 * @returns {Float32Array}
 */
export function randn(gen, n) {
  if (!(Number.isInteger(n) && n >= 16)) throw new RangeError('randn here draws 16 or more values, as the pipeline does');
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = gen.uniform();
  for (let i = 0; i + 16 <= n; i += 16) normal16(data, i);
  if (n % 16 !== 0) {
    for (let i = n - 16; i < n; i++) data[i] = gen.uniform();
    normal16(data, n - 16);
  }
  return data;
}

/** The largest seed: PyTorch keeps the low 32 bits of a seed. */
export const MAX_SEED = 0xffffffff;

/** A random seed, for a picture nobody asked to repeat. */
export function randomSeed() {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return a[0];
}
