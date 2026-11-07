// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// WAV files: 16-bit PCM (what the tasks give) or 32-bit float, read back for
// the page's player and history. Pure, no DOM.

/**
 * Encode planar channels as a WAV file.
 * @param {Float32Array[]} channels one array per channel, same length, values -1..1
 * @param {number} sampleRate
 * @param {{ float?: boolean }} [opts] `float`: 32-bit float instead of 16-bit PCM
 * @returns {ArrayBuffer}
 */
export function encodeWav(channels, sampleRate, { float = false } = {}) {
  if (!channels.length) throw new RangeError('no channels');
  const n = channels[0].length;
  if (channels.some(c => c.length !== n)) throw new RangeError('channels of different lengths');
  const ch = channels.length, bytes = float ? 4 : 2;
  const data = n * ch * bytes;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + data, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, float ? 3 : 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * ch * bytes, true); v.setUint16(32, ch * bytes, true); v.setUint16(34, bytes * 8, true);
  str(36, 'data'); v.setUint32(40, data, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      let s = channels[c][i];
      if (!Number.isFinite(s)) s = 0;
      s = s > 1 ? 1 : s < -1 ? -1 : s;
      if (float) { v.setFloat32(o, s, true); o += 4; }
      else { v.setInt16(o, Math.round(s * 32767), true); o += 2; }
    }
  }
  return buf;
}

/**
 * Read a WAV file (PCM 16, 24 or 32 bits, or 32-bit float).
 * @param {ArrayBuffer} buf
 * @returns {{ sampleRate: number, channels: Float32Array[] }}
 */
export function decodeWav(buf) {
  const v = new DataView(buf);
  const tag = o => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (buf.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new TypeError('not a WAV file');
  let o = 12, fmt = null;
  while (o + 8 <= buf.byteLength) {
    const id = tag(o), size = v.getUint32(o + 4, true), body = o + 8;
    if (id === 'fmt ') fmt = { format: v.getUint16(body, true), ch: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    if (id === 'data') {
      if (!fmt) throw new TypeError('WAV data before its format');
      const { format, ch, rate, bits } = fmt;
      const bps = bits / 8, n = Math.floor(Math.min(size, buf.byteLength - body) / (bps * ch));
      const out = Array.from({ length: ch }, () => new Float32Array(n));
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < ch; c++) {
          const p = body + (i * ch + c) * bps;
          let s;
          if (format === 3 && bits === 32) s = v.getFloat32(p, true);
          else if (bits === 16) s = v.getInt16(p, true) / 32768;
          else if (bits === 24) s = ((v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getInt8(p + 2) << 16))) / 8388608;
          else if (bits === 32) s = v.getInt32(p, true) / 2147483648;
          else throw new TypeError(`unsupported WAV: format ${format}, ${bits} bits`);
          out[c][i] = s;
        }
      }
      return { sampleRate: rate, channels: out };
    }
    o = body + size + (size & 1);
  }
  throw new TypeError('WAV without data');
}
