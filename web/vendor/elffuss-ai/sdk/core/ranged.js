// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Reading parts of a file that is already here: a model's weights file from the
// store (a Blob), or its bytes once read. A runtime that takes its tensors one
// by one (the Elffuss Engine) reads each from its offset, without a second
// download and without holding the whole file once more. Pure, no DOM.

import { AiError } from './errors.js';

/**
 * @typedef {{ size: number, slice(offset: number, length: number): Promise<ArrayBuffer> }} RangedFile
 *   `slice` gives a new ArrayBuffer of exactly `length` bytes from `offset`.
 */

/**
 * Ranged reads over a Blob, an ArrayBuffer or a typed array. A read outside the
 * file is refused, never cut short.
 * @param {Blob | ArrayBuffer | ArrayBufferView} src
 * @param {string} [name] for the error
 * @returns {RangedFile}
 */
export function rangedFile(src, name = 'file') {
  const isBlob = typeof Blob !== 'undefined' && src instanceof Blob;
  const view = isBlob ? null : ArrayBuffer.isView(src) ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength) : src instanceof ArrayBuffer ? new Uint8Array(src) : null;
  if (!isBlob && !view) throw new AiError('run-failed', `${name}: not a Blob or bytes`);
  const size = isBlob ? src.size : view.byteLength;
  return {
    size,
    async slice(offset, length) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size) {
        throw new AiError('run-failed', `${name}: bytes ${offset}+${length} are outside its ${size}`, { details: { offset, length, size } });
      }
      if (isBlob) {
        const out = await src.slice(offset, offset + length).arrayBuffer();
        if (out.byteLength !== length) throw new AiError('run-failed', `${name}: read ${out.byteLength} bytes of ${length}`);
        return out;
      }
      return view.slice(offset, offset + length).buffer;
    },
  };
}
