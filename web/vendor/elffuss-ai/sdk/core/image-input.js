// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Images in and out of a task. On the page, anything image-like becomes what a
// Worker can receive without copying (Blob, ImageBitmap, ImageData). In the
// Worker, a Blob is sniffed by its first bytes (never by its name), decoded with
// its EXIF orientation applied, and scaled down when it is too large.
//
// Browsers decode a file at its full size even when asked for a smaller bitmap
// (createImageBitmap's resize options scale after decoding), so the size is read
// from the file's header first and a file of more than MAX_INPUT_PIXELS is
// refused with too-large before anything is decoded. A small file can declare a
// huge picture (a PNG of one colour compresses to almost nothing).

import { AiError } from './errors.js';
import { encodePngSamples } from './png.js';

/**
 * The most pixels an input may have (8192 × 8192). It covers the photos of
 * today's cameras; above it, a single decode would take more memory than a page
 * should, so the file is refused (too-large) before it is decoded.
 */
export const MAX_INPUT_PIXELS = 8192 * 8192;

/** Image types the tasks decode, by their first bytes. */
export function sniffImageType(head) {
  const b = head instanceof Uint8Array ? head : new Uint8Array(head);
  const at = (i, ...v) => v.every((x, k) => b[i + k] === x);
  const ascii = (i, s) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, 'BM')) return 'image/bmp';
  if (ascii(4, 'ftyp')) {
    const brand = String.fromCharCode(...b.subarray(8, 12));
    if (/^avi[fs]$/.test(brand)) return 'image/avif';
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return 'image/heic';
  }
  if (at(0, 0x49, 0x49, 0x2a, 0x00) || at(0, 0x4d, 0x4d, 0x00, 0x2a)) return 'image/tiff';
  if (ascii(0, '%PDF-')) return 'application/pdf';
  return null;
}

/** Types the browser decodes for the tasks. HEIC and TIFF are refused on purpose. */
export const DECODABLE = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']);

/**
 * Width and height of an image from the first bytes of its file, without
 * decoding it (the size as stored: an EXIF rotation swaps them but does not
 * change the number of pixels). Null when the header does not say, or is cut.
 * @param {Uint8Array|ArrayBuffer} head the start of the file (the first megabyte is plenty)
 * @returns {{ width: number, height: number } | null}
 */
export function imageSize(head) {
  const b = head instanceof Uint8Array ? head : new Uint8Array(head);
  const type = sniffImageType(b.subarray(0, 32));
  const u16be = i => (b[i] << 8) | b[i + 1];
  const u16le = i => b[i] | (b[i + 1] << 8);
  const u24le = i => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const u32be = i => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const i32le = i => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
  const ok = (width, height) => (width > 0 && height > 0 ? { width, height } : null);
  const has = n => b.length >= n;
  if (type === 'image/png') {
    // Only a header that PNG allows: a 13-byte IHDR, sides up to 2^31 − 1, a known
    // bit depth and colour type. Anything else is left to the decoder, which fails.
    if (!has(26) || u32be(8) !== 13 || !(b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52)) return null;
    const w = u32be(16), h = u32be(20);
    if (w > 0x7fffffff || h > 0x7fffffff || ![1, 2, 4, 8, 16].includes(b[24]) || ![0, 2, 3, 4, 6].includes(b[25])) return null;
    return ok(w, h);
  }
  if (type === 'image/gif') return has(10) ? ok(u16le(6), u16le(8)) : null;
  if (type === 'image/bmp') {
    if (!has(26)) return null;
    const dib = i32le(14);
    if (dib === 12) return ok(u16le(18), u16le(20));
    return [16, 40, 52, 56, 64, 108, 124].includes(dib) ? ok(Math.abs(i32le(18)), Math.abs(i32le(22))) : null;
  }
  if (type === 'image/webp') {
    if (!has(30)) return null;
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === 'VP8X') return ok(u24le(24) + 1, u24le(27) + 1);
    if (chunk === 'VP8 ') return b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a ? ok(u16le(26) & 0x3fff, u16le(28) & 0x3fff) : null;
    if (chunk === 'VP8L') {
      if (b[20] !== 0x2f) return null;
      const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
      return ok((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    return null;
  }
  if (type === 'image/jpeg') {
    // Walk the segments up to the frame header (SOF0…SOF15, but not DHT, JPG or DAC).
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      if (m === 0xd9 || m === 0xda) return null;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return ok(u16be(i + 7), u16be(i + 5));
      i += 2 + u16be(i + 2);
    }
    return null;
  }
  if (type === 'image/avif') {
    // The largest image spatial extent ('ispe') in the header: the primary image.
    let best = null;
    for (let i = 4; i + 16 <= b.length; i++) {
      if (b[i] === 0x69 && b[i + 1] === 0x73 && b[i + 2] === 0x70 && b[i + 3] === 0x65) {
        const s = ok(u32be(i + 8), u32be(i + 12));
        if (s && (!best || s.width * s.height > best.width * best.height)) best = s;
      }
    }
    return best;
  }
  return null;
}

/** How much of a file to read to find its size. */
const HEADER_BYTES = 1 << 20;

/**
 * Refuse an image file whose picture has more than `maxPixels` pixels, from its
 * header, before anything decodes it. Files whose header does not say are left
 * to the decoder (and checked again after it).
 * @param {Blob} blob
 * @param {number} [maxPixels]
 * @returns {Promise<{ width: number, height: number } | null>} the size the header gives
 */
export async function checkPixelBudget(blob, maxPixels = MAX_INPUT_PIXELS) {
  const size = imageSize(new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer()));
  if (size && size.width * size.height > maxPixels) {
    throw new AiError('too-large', `the image has ${size.width} × ${size.height} pixels`, { details: { width: size.width, height: size.height, maxPixels } });
  }
  return size;
}

/**
 * On the page: a small copy of an image file to show, at most `maxSide` on its
 * longest side, with its EXIF orientation applied. The full-size decode it needs
 * is released at once, and a file over the pixel budget is refused first
 * (too-large), so showing a photo never keeps a full-size copy alive.
 * @param {Blob} blob
 * @param {{ maxSide?: number, maxPixels?: number }} [opts]
 * @returns {Promise<{ bitmap: ImageBitmap, sourceWidth: number, sourceHeight: number }>} the small copy, and the
 *   size of the picture (as shown, after its EXIF orientation)
 */
export async function previewBitmap(blob, { maxSide = 2048, maxPixels = MAX_INPUT_PIXELS } = {}) {
  if (blob.size === 0) throw new AiError('decode-failed', 'the file is empty');
  const type = sniffImageType(new Uint8Array(await blob.slice(0, 32).arrayBuffer()));
  if (!type || !DECODABLE.includes(type)) throw new AiError('unsupported-format', 'not an image this site reads', { details: { type } });
  await checkPixelBudget(blob, maxPixels);
  let full;
  try { full = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch (err) { throw new AiError('decode-failed', 'the image could not be decoded', { cause: err, details: { type } }); }
  try {
    const sourceWidth = full.width, sourceHeight = full.height;
    if (sourceWidth * sourceHeight > maxPixels) throw new AiError('too-large', `the image has ${sourceWidth} × ${sourceHeight} pixels`, { details: { maxPixels } });
    const k = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
    if (k === 1) { const bitmap = full; full = null; return { bitmap, sourceWidth, sourceHeight }; }
    const bitmap = await createImageBitmap(full, { resizeWidth: Math.max(1, Math.round(sourceWidth * k)), resizeHeight: Math.max(1, Math.round(sourceHeight * k)), resizeQuality: 'high' });
    return { bitmap, sourceWidth, sourceHeight };
  } finally {
    full?.close();
  }
}

/**
 * On the page: a small PNG of an image file, for an <img> (see previewBitmap).
 * @param {Blob} blob
 * @param {{ maxSide?: number, maxPixels?: number }} [opts]
 * @returns {Promise<{ blob: Blob, width: number, height: number, sourceWidth: number, sourceHeight: number }>}
 */
export async function previewImage(blob, opts) {
  const { bitmap, sourceWidth, sourceHeight } = await previewBitmap(blob, opts);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return { blob: await canvas.convertToBlob({ type: 'image/png' }), width: bitmap.width, height: bitmap.height, sourceWidth, sourceHeight };
  } finally {
    bitmap.close();
  }
}

/**
 * On the page: turn an image-like input into something a Worker takes without
 * copying. Returns the value and the list of objects to transfer.
 * @param {Blob|ImageBitmap|ImageData|HTMLImageElement|HTMLCanvasElement|OffscreenCanvas|HTMLVideoElement|VideoFrame} input
 * @returns {Promise<{ value: Blob|ImageBitmap|ImageData, transfer: Transferable[] }>}
 */
export async function toTransferable(input) {
  if (typeof Blob !== 'undefined' && input instanceof Blob) return { value: input, transfer: [] };
  if (typeof ImageBitmap !== 'undefined' && input instanceof ImageBitmap) return { value: input, transfer: [input] };
  if (typeof ImageData !== 'undefined' && input instanceof ImageData) return { value: input, transfer: [] };
  if (input && typeof input === 'object' && ('naturalWidth' in input || 'videoWidth' in input || 'getContext' in input || 'displayWidth' in input)) {
    try {
      const bmp = await createImageBitmap(input);
      return { value: bmp, transfer: [bmp] };
    } catch (err) {
      throw new AiError('decode-failed', 'the image could not be read', { cause: err });
    }
  }
  throw new AiError('unsupported-format', 'not an image');
}

/**
 * In the Worker (or the page): decode an input to RGBA pixels.
 * @param {Blob|ImageBitmap|ImageData} input
 * @param {{ maxSide?: number, close?: boolean, maxPixels?: number }} [opts] `maxSide` scales the longest
 *   side down to it; a file whose picture has more than `maxPixels` pixels is refused (too-large) before decoding
 * @returns {Promise<{ width: number, height: number, data: Uint8ClampedArray, scaled: boolean, sourceWidth: number, sourceHeight: number }>}
 */
export async function decodeImage(input, { maxSide = 0, close = true, maxPixels = MAX_INPUT_PIXELS } = {}) {
  let source = input;
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    if (input.size === 0) throw new AiError('decode-failed', 'the file is empty');
    const type = sniffImageType(new Uint8Array(await input.slice(0, 32).arrayBuffer()));
    if (!type) throw new AiError('unsupported-format', 'not an image this site reads');
    if (!DECODABLE.includes(type)) throw new AiError('unsupported-format', `${type} is not supported`, { details: { type } });
    await checkPixelBudget(input, maxPixels);
    try { source = await createImageBitmap(input, { imageOrientation: 'from-image' }); }
    catch (err) { throw new AiError('decode-failed', 'the image could not be decoded', { cause: err, details: { type } }); }
  } else if (typeof ImageData !== 'undefined' && input instanceof ImageData) {
    const { width, height } = input;
    if (!maxSide || Math.max(width, height) <= maxSide) return { width, height, data: input.data, scaled: false, sourceWidth: width, sourceHeight: height };
    source = await createImageBitmap(input);
  } else if (!(typeof ImageBitmap !== 'undefined' && input instanceof ImageBitmap)) {
    throw new AiError('unsupported-format', 'not an image');
  }
  const sw = source.width, sh = source.height;
  if (!sw || !sh) throw new AiError('decode-failed', 'the image has no pixels');
  if (sw * sh > maxPixels) {
    // A header that did not say: the decode is done, but nothing goes further.
    if (close && source !== input) source.close?.();
    throw new AiError('too-large', `the image has ${sw} × ${sh} pixels`, { details: { width: sw, height: sh, maxPixels } });
  }
  const k = maxSide && Math.max(sw, sh) > maxSide ? maxSide / Math.max(sw, sh) : 1;
  const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  if (close && source !== input) source.close?.();
  else if (close && typeof ImageBitmap !== 'undefined' && input instanceof ImageBitmap) input.close();
  return { width: w, height: h, data, scaled: k !== 1, sourceWidth: sw, sourceHeight: sh };
}

/**
 * Encode RGBA pixels as PNG, exactly as given. An image with any pixel that is
 * not fully opaque is written without a canvas, so those pixels keep their
 * colour (a canvas stores premultiplied alpha and would change it); a fully
 * opaque one goes through the browser's own encoder, which is faster and loses
 * nothing there. The colours are those the browser decoded the input to, sRGB.
 * @param {{ width: number, height: number, data: Uint8ClampedArray|Uint8Array }} img
 * @returns {Promise<Blob>}
 */
export async function encodePng({ width, height, data }) {
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { opaque = false; break; }
  if (opaque && typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const pixels = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);
    canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
  }
  return encodePngSamples({ width, height, channels: 4, bitDepth: 8, data, srgb: true });
}
