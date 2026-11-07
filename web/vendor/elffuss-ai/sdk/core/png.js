// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// PNG files written and read without a canvas. A canvas stores premultiplied
// alpha, so a pixel that is not fully opaque comes back with other colours
// (the edge of a cut-out changed by up to half the range); and it only writes 8
// bits per channel. This writer puts the given samples in the file as they are:
// grey or RGB, with or without alpha, at 8 or 16 bits. Compression uses the
// browser's CompressionStream (also in Node), so nothing else is needed.

import { crc32 } from './zip.js';

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
/** PNG colour type of each number of channels, and back. */
const COLOR_TYPE = Object.freeze({ 1: 0, 2: 4, 3: 2, 4: 6 });
const CHANNELS = Object.freeze({ 0: 1, 2: 3, 4: 2, 6: 4 });

async function through(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

const ascii = s => Uint8Array.from(s, c => c.charCodeAt(0));

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(ascii(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * Filter one scanline (`prev` is the raw row above, or null) with each of the
 * five PNG filters and keep the one whose bytes, read as signed, add up to the
 * least (the usual heuristic). Returns the filter type byte and the row.
 */
export function filterRow(row, prev, bpp) {
  const n = row.length;
  let best = null, bestCost = Infinity;
  for (let type = 0; type <= 4; type++) {
    const out = new Uint8Array(n + 1);
    out[0] = type;
    let cost = 0;
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev ? prev[i] : 0, c = prev && i >= bpp ? prev[i - bpp] : 0;
      const pred = type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : paeth(a, b, c);
      const v = (row[i] - pred) & 0xff;
      out[i + 1] = v;
      cost += v < 128 ? v : 256 - v;
      if (cost >= bestCost) break;
    }
    if (cost < bestCost) { best = out; bestCost = cost; }
  }
  return best;
}

/**
 * A PNG of raw samples, row by row, with no change to them.
 * @param {{ width: number, height: number, channels: 1|2|3|4, bitDepth?: 8|16,
 *   data: Uint8Array|Uint8ClampedArray|Uint16Array, srgb?: boolean }} img
 *   `data` holds `channels` samples per pixel (16-bit samples in a Uint16Array);
 *   `srgb` marks the colours as sRGB (an sRGB chunk), as a browser decodes them.
 * @returns {Promise<Blob>} an `image/png` Blob
 */
export async function encodePngSamples({ width, height, channels, bitDepth = 8, data, srgb = false }) {
  if (!(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0)) throw new RangeError('a PNG needs a positive width and height');
  if (!(channels in COLOR_TYPE) || (bitDepth !== 8 && bitDepth !== 16)) throw new RangeError(`no PNG of ${channels} channels at ${bitDepth} bits`);
  if (data.length !== width * height * channels) throw new RangeError('the samples are not width × height × channels');
  const bps = bitDepth / 8, bpp = channels * bps, stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const row = new Uint8Array(stride);
  let prev = null;
  for (let y = 0; y < height; y++) {
    const at = y * width * channels;
    if (bitDepth === 8) row.set(data.subarray(at, at + width * channels));
    else for (let i = 0; i < width * channels; i++) { const v = data[at + i]; row[2 * i] = v >> 8; row[2 * i + 1] = v & 0xff; }
    raw.set(filterRow(row, prev, bpp), y * (stride + 1));
    prev = prev ? (prev.set(row), prev) : row.slice();
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([bitDepth, COLOR_TYPE[channels], 0, 0, 0], 8); // deflate, adaptive filters, no interlace
  const idat = await through(raw, new CompressionStream('deflate'));
  const parts = [SIGNATURE, chunk('IHDR', ihdr)];
  if (srgb) parts.push(chunk('sRGB', Uint8Array.of(0))); // perceptual rendering intent
  parts.push(chunk('IDAT', idat), chunk('IEND', new Uint8Array(0)));
  return new Blob(parts, { type: 'image/png' });
}

/**
 * Read a PNG: greyscale, grey with alpha, RGB or RGBA, at 8 or 16 bits, not
 * interlaced. Checks the signature and every chunk's CRC.
 * @param {ArrayBuffer|Uint8Array|Blob} input
 * @returns {Promise<{ width: number, height: number, bitDepth: 8|16, channels: number, data: Uint8Array|Uint16Array, srgb: boolean }>}
 *   `data` holds `channels` samples per pixel, row by row
 */
export async function decodePng(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input instanceof Blob ? await input.arrayBuffer() : input);
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new TypeError('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8, header = null, srgb = false;
  const idat = [];
  for (;;) {
    if (pos + 12 > bytes.length) throw new TypeError('PNG ends before IEND');
    const len = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    if (pos + 12 + len > bytes.length) throw new TypeError(`PNG chunk ${type} is cut`);
    if (crc32(bytes.subarray(pos + 4, pos + 8 + len)) !== view.getUint32(pos + 8 + len)) throw new TypeError(`PNG chunk ${type} has a bad CRC`);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      const h = new DataView(data.buffer, data.byteOffset, data.byteLength);
      header = { width: h.getUint32(0), height: h.getUint32(4), bitDepth: data[8], colorType: data[9], interlace: data[12] };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'sRGB') srgb = true;
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!header) throw new TypeError('PNG without IHDR');
  const { width, height, bitDepth, colorType, interlace } = header;
  const channels = CHANNELS[colorType];
  if (!channels || (bitDepth !== 8 && bitDepth !== 16) || interlace !== 0) throw new TypeError(`PNG kind not read here (colour type ${colorType}, ${bitDepth} bits, interlace ${interlace})`);
  const joined = new Uint8Array(idat.reduce((s, d) => s + d.length, 0));
  idat.reduce((o, d) => { joined.set(d, o); return o + d.length; }, 0);
  const raw = await through(joined, new DecompressionStream('deflate'));
  const bpp = channels * (bitDepth / 8);
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) throw new TypeError('PNG image data is short');
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev ? prev[i] : 0, c = prev && i >= bpp ? prev[i - bpp] : 0;
      const pred = type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : type === 4 ? paeth(a, b, c) : -1;
      if (pred < 0) throw new TypeError(`PNG row ${y} has filter ${type}`);
      cur[i] = (src[i] + pred) & 0xff;
    }
  }
  if (bitDepth === 8) return { width, height, bitDepth, channels, data: pixels, srgb };
  const data = new Uint16Array(width * height * channels);
  for (let i = 0; i < data.length; i++) data[i] = (pixels[2 * i] << 8) | pixels[2 * i + 1];
  return { width, height, bitDepth, channels, data, srgb };
}
