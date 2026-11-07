// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The SAME-S decoder of Stable Audio 3 (with its limiter) holds four scalar
// constants in double precision, -1, 1, -32767 and 32767, each cast to float by
// the next node. ONNX Runtime Web's WebGPU build has no Cast from double, so the
// session cannot be created. Here they become int64 constants of the same value,
// in place: the tensor's type field (11 → 7) and its eight bytes, so no length in
// the protobuf changes and Cast(int64 → float) gives exactly the same floats.
// Only constants laid out as `data_type: DOUBLE, raw_data: <8 bytes>` with an
// integral value are touched. Pure.

const DOUBLE = 11, INT64 = 7;

/**
 * Rewrite integral double scalars of an ONNX model as int64, in place.
 * @param {Uint8Array} bytes the model
 * @param {{ values?: number[] }} [opts] the values allowed (all integral ones when left out)
 * @returns {number} how many were rewritten
 */
export function doubleScalarsToInt64(bytes, { values } = {}) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let n = 0;
  for (let i = 0; i + 12 <= bytes.length; i++) {
    // field 2 (data_type, varint) = 11, then field 9 (raw_data, 8 bytes)
    if (bytes[i] !== 0x10 || bytes[i + 1] !== DOUBLE || bytes[i + 2] !== 0x4a || bytes[i + 3] !== 0x08) continue;
    const v = view.getFloat64(i + 4, true);
    if (!Number.isInteger(v) || Math.abs(v) > 2 ** 52 || (values && !values.includes(v))) continue;
    bytes[i + 1] = INT64;
    view.setBigInt64(i + 4, BigInt(v), true);
    n++;
    i += 11;
  }
  return n;
}
