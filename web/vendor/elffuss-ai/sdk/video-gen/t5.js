// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// What the UMT5 encoder graphs need from JavaScript: the token embeddings,
// gathered from the 4-bit table (blocks of 32 with a scale and a zero each),
// and the relative-position buckets of T5's attention bias (bidirectional, 32
// buckets, distances up to 128), as Wan's T5RelativeEmbedding computes them.

import { fromHalfBits } from './half.js';

/** Width of the encoder. */
export const T5_DIM = 4096;
/** Rows of the embedding table (umt5-xxl's padded vocabulary). */
export const T5_VOCAB = 256384;
/** Length the transformer reads: the encoder's output padded with zeros. */
export const TEXT_LEN = 512;

/** Bytes of one row of the embedding table: 4-bit values, then fp16 scales, then 4-bit zeros (blocks of 32). */
export const ROW_BYTES = T5_DIM / 2 + (T5_DIM / 32) * 2 + T5_DIM / 64;

/**
 * Embeddings of `ids`, [ids.length × 4096] float32, from the 4-bit table. A
 * row holds 2048 bytes of values (low nibble first), 128 fp16 scales and 64
 * bytes of zero points (low nibble first): value = (q - zero) × scale.
 * @param {ArrayBuffer|Uint8Array} table `T5_VOCAB` rows of `ROW_BYTES`
 * @param {number[]} ids
 */
export function gatherEmbeddings(table, ids, { dim = T5_DIM, vocab = T5_VOCAB } = {}) {
  const bytes = table instanceof Uint8Array ? table : new Uint8Array(table);
  const rowBytes = dim / 2 + (dim / 32) * 2 + dim / 64;
  if (bytes.byteLength !== vocab * rowBytes) throw new RangeError(`the embedding table has ${bytes.byteLength} bytes, not ${vocab * rowBytes}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(ids.length * dim);
  ids.forEach((id, t) => {
    if (!(Number.isInteger(id) && id >= 0 && id < vocab)) throw new RangeError(`token id ${id} is outside the vocabulary`);
    const row = id * rowBytes, scales = row + dim / 2, zeros = scales + (dim / 32) * 2;
    for (let b = 0; b < dim / 32; b++) {
      const scale = fromHalfBits(view.getUint16(scales + b * 2, true));
      const zb = bytes[zeros + (b >> 1)];
      const zero = b & 1 ? zb >> 4 : zb & 15;
      for (let j = 0; j < 16; j++) {
        const q = bytes[row + b * 16 + j], o = t * dim + b * 32 + 2 * j;
        out[o] = ((q & 15) - zero) * scale;
        out[o + 1] = ((q >> 4) - zero) * scale;
      }
    }
  });
  return out;
}

/**
 * Relative-position buckets [L × L] (BigInt64Array, row q, column k) of a
 * bidirectional T5 attention bias.
 */
export function relativeBuckets(L, { buckets = 32, maxDistance = 128 } = {}) {
  const nb = buckets / 2, exact = nb / 2;
  const out = new BigInt64Array(L * L);
  for (let q = 0; q < L; q++) for (let k = 0; k < L; k++) {
    const rel = k - q;
    let b = rel > 0 ? nb : 0;
    const d = Math.abs(rel);
    if (d < exact) b += d;
    else b += Math.min(nb - 1, exact + Math.trunc((Math.log(d / exact) / Math.log(maxDistance / exact)) * (nb - exact)));
    out[q * L + k] = BigInt(b);
  }
  return out;
}

/** The encoder's output [L × 4096] padded with zeros to 512 rows (what Wan feeds the transformer). */
export function padContext(hidden, L, { len = TEXT_LEN, dim = T5_DIM } = {}) {
  const out = new Float32Array(len * dim);
  out.set(hidden.subarray(0, Math.min(L, len) * dim));
  return out;
}
