// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// A small ZIP writer for exports (text only, built in memory): "store" method,
// UTF-8 names (general purpose bit 11), CRC-32 by table, central directory.
// No ZIP64, so at most 65,535 entries and 4 GiB. Names are sanitised: NFC,
// forward slashes, no leading slash, no `..` segments, no control characters,
// `<>:"|?*` replaced by `_`, and repeated names get " (2)", " (3)"…

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE) of bytes, optionally continuing a previous value. */
export function crc32(bytes, crc = 0) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A safe relative path for a ZIP entry. */
export function sanitizeZipPath(name) {
  const parts = String(name).normalize('NFC').replace(/\\/g, '/').split('/')
    .map(p => p.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[<>:"|?*]/g, '_').trim())
    .filter(p => p && p !== '.' && p !== '..');
  return parts.join('/') || '_';
}

/** Make every name unique by adding " (2)", " (3)"… before the extension. */
export function uniquePaths(names) {
  const seen = new Map();
  return names.map(n => {
    const key = n.toLowerCase();
    if (!seen.has(key)) { seen.set(key, 1); return n; }
    let i = seen.get(key);
    let candidate;
    do {
      i++;
      const slash = n.lastIndexOf('/');
      const dot = n.lastIndexOf('.');
      candidate = dot > slash + 1 ? `${n.slice(0, dot)} (${i})${n.slice(dot)}` : `${n} (${i})`;
    } while (seen.has(candidate.toLowerCase()));
    seen.set(key, i);
    seen.set(candidate.toLowerCase(), 1);
    return candidate;
  });
}

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Build a ZIP archive.
 * @param {{ name: string, data: Uint8Array|string }[]} entries
 * @param {{ date?: Date }} [opts] the modification time of every entry
 * @returns {Uint8Array}
 */
export function createZip(entries, { date = new Date() } = {}) {
  if (entries.length > 0xffff) throw new RangeError('too many entries for a ZIP without ZIP64');
  const enc = new TextEncoder();
  const names = uniquePaths(entries.map(e => sanitizeZipPath(e.name)));
  const { time, date: dday } = dosDateTime(date);
  const locals = [];
  const centrals = [];
  let offset = 0;
  entries.forEach((e, i) => {
    const name = enc.encode(names[i]);
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    const crc = crc32(data);
    if (data.length > 0xfffffffe || offset > 0xfffffffe) throw new RangeError('too large for a ZIP without ZIP64');
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true); lh.setUint16(12, dday, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    locals.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true); ch.setUint16(14, dday, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true);
    ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
    centrals.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  });
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(4, 0, true); end.setUint16(6, 0, true);
  end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true); end.setUint16(20, 0, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((s, b) => s + b.length, 0));
  let o = 0;
  for (const b of parts) { out.set(b, o); o += b.length; }
  return out;
}

/**
 * Read back a ZIP written by createZip (store method only).
 * @param {Uint8Array} bytes
 * @returns {{ name: string, data: Uint8Array, crc: number, flags: number, method: number }[]}
 */
export function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('no end of central directory');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = [];
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad central directory');
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 20, true), nameLen = dv.getUint16(p + 28, true), extra = dv.getUint16(p + 30, true), comment = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const lName = dv.getUint16(local + 26, true), lExtra = dv.getUint16(local + 28, true);
    const data = bytes.subarray(local + 30 + lName + lExtra, local + 30 + lName + lExtra + size);
    out.push({ name, data, crc, flags, method });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}
