// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// A small MP4 (ISO BMFF) writer for what WebCodecs encodes: one H.264 video
// track and at most one audio track (AAC or Opus), every sample in memory, the
// index (moov) before the data so the file plays while it downloads. Samples
// come in decode order with their presentation time; when the encoder reorders
// frames the writer adds composition offsets and an edit list. Pure: no browser
// API, Node tests it by reading the boxes back.

const enc = new TextEncoder();

/** A box: type and payload parts (Uint8Array, or arrays of them). */
function box(type, ...parts) {
  const flat = parts.flat(Infinity).filter(Boolean);
  const size = 8 + flat.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, size);
  out.set(enc.encode(type), 4);
  let o = 8;
  for (const p of flat) { out.set(p, o); o += p.length; }
  return out;
}
const full = (type, version, flags, ...parts) => box(type, u8(version), u24(flags), ...parts);
const u8 = v => Uint8Array.of(v & 255);
const u16 = v => Uint8Array.of((v >>> 8) & 255, v & 255);
const u24 = v => Uint8Array.of((v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const u32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return b; };
const i32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v); return b; };
const zeros = n => new Uint8Array(n);
const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32);

/**
 * @typedef {{ data: Uint8Array, pts: number, duration: number, key: boolean }} Mp4Sample
 *   `pts` and `duration` in the track's timescale; samples in decode order.
 * @typedef {{ kind: 'video', codec: 'avc1', width: number, height: number, timescale: number, description: Uint8Array,
 *   colour?: { primaries: number, transfer: number, matrix: number, fullRange: boolean }, samples: Mp4Sample[] }} Mp4Video
 * @typedef {{ kind: 'audio', codec: 'mp4a'|'opus', sampleRate: number, channels: number, timescale: number,
 *   description?: Uint8Array, preSkip?: number, bitrate?: number, samples: Mp4Sample[] }} Mp4Audio
 */

/** Decode times and composition offsets of samples given in decode order with their presentation times. */
export function timing(samples) {
  const sorted = samples.map(s => s.pts).sort((a, b) => a - b);
  let delay = 0;
  for (let i = 0; i < samples.length; i++) delay = Math.max(delay, sorted[i] - samples[i].pts);
  const dts = sorted.map(t => t - delay);
  const cts = samples.map((s, i) => s.pts - dts[i]);
  const start = dts[0] ?? 0;
  return { dts: dts.map(t => t - start), cts, delay: (cts[0] ?? 0) + 0, shift: start };
}

/** Run-length pairs of a list of numbers. */
function runs(values) {
  const out = [];
  for (const v of values) { const last = out.at(-1); if (last && last[1] === v) last[0]++; else out.push([1, v]); }
  return out;
}

function avcEntry(t) {
  const compressor = zeros(32);
  const colr = t.colour ? box('colr', enc.encode('nclx'), u16(t.colour.primaries), u16(t.colour.transfer), u16(t.colour.matrix), u8(t.colour.fullRange ? 0x80 : 0)) : null;
  return box('avc1', zeros(6), u16(1), zeros(16), u16(t.width), u16(t.height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), compressor, u16(0x18), u16(0xffff),
    box('avcC', t.description), colr, box('pasp', u32(1), u32(1)));
}

/** The MPEG-4 descriptor length, in four bytes. */
const descLen = n => Uint8Array.of(0x80 | ((n >>> 21) & 127), 0x80 | ((n >>> 14) & 127), 0x80 | ((n >>> 7) & 127), n & 127);
const descriptor = (tag, ...parts) => { const flat = parts.flat().filter(Boolean); const n = flat.reduce((s, p) => s + p.length, 0); return [u8(tag), descLen(n), ...flat]; };

function audioEntry(t) {
  const head = [zeros(6), u16(1), zeros(8), u16(t.channels), u16(16), zeros(4), u32(t.sampleRate << 16 >>> 0)];
  if (t.codec === 'mp4a') {
    const asc = t.description || audioSpecificConfig(t.sampleRate, t.channels);
    const dec = descriptor(4, u8(0x40), u8(0x15), u24(0), u32(t.bitrate || 0), u32(t.bitrate || 0), descriptor(5, asc));
    const es = descriptor(3, u16(1), u8(0), dec, descriptor(6, u8(2)));
    return box('mp4a', ...head, full('esds', 0, 0, es));
  }
  const dops = box('dOps', u8(0), u8(t.channels), u16(t.preSkip ?? 312), u32(t.sampleRate), u16(0), u8(0));
  return box('Opus', ...head, dops);
}

/** AAC-LC AudioSpecificConfig for a rate and channel count (when the encoder gives none). */
export function audioSpecificConfig(rate, channels) {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const idx = Math.max(0, rates.indexOf(rate));
  return Uint8Array.of((2 << 3) | (idx >> 1), ((idx & 1) << 7) | (channels << 3));
}

function trak(t, id, chunks, movieTimescale, offsetsAt) {
  const n = t.samples.length;
  const { dts, cts } = timing(t.samples);
  const durations = t.samples.map((s, i) => (i + 1 < n ? dts[i + 1] - dts[i] : s.duration));
  const mediaDuration = durations.reduce((s, d) => s + d, 0);
  const presentation = t.samples.reduce((m, s) => Math.max(m, s.pts + s.duration), 0) - Math.min(...t.samples.map(s => s.pts));
  const movieDuration = Math.round(presentation * movieTimescale / t.timescale);
  const video = t.kind === 'video';
  const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(movieDuration), zeros(8), u16(0), u16(video ? 0 : 1), u16(video ? 0 : 0x0100), u16(0), MATRIX,
    u32(video ? t.width * 65536 : 0), u32(video ? t.height * 65536 : 0));
  const reorder = cts.some(c => c !== 0);
  const edts = reorder || cts[0] ? box('edts', full('elst', 0, 0, u32(1), u32(movieDuration), u32(cts[0] || 0), u16(1), u16(0))) : null;
  const stts = full('stts', 0, 0, (() => { const r = runs(durations); return [u32(r.length), ...r.flatMap(([c, v]) => [u32(c), u32(v)])]; })());
  const ctts = reorder ? full('ctts', 0, 0, (() => { const r = runs(cts); return [u32(r.length), ...r.flatMap(([c, v]) => [u32(c), u32(v)])]; })()) : null;
  const keys = t.samples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
  const stss = video && keys.length < n ? full('stss', 0, 0, u32(keys.length), keys.map(u32)) : null;
  const stsc = full('stsc', 0, 0, (() => { const r = runs(chunks.map(c => c.count)); let first = 1; const rows = []; for (const [c, v] of r) { rows.push([first, v]); first += c; } return [u32(rows.length), ...rows.flatMap(([f, v]) => [u32(f), u32(v), u32(1)])]; })());
  const stsz = full('stsz', 0, 0, u32(0), u32(n), t.samples.map(s => u32(s.data.length)));
  const stco = full('stco', 0, 0, u32(chunks.length), chunks.map(c => u32(offsetsAt(c))));
  const stsd = full('stsd', 0, 0, u32(1), video ? avcEntry(t) : audioEntry(t));
  const stbl = box('stbl', stsd, stts, ctts, stss, stsc, stsz, stco);
  const minf = box('minf', video ? full('vmhd', 0, 1, zeros(8)) : full('smhd', 0, 0, zeros(4)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stbl);
  const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(t.timescale), u32(mediaDuration), u16(0x55c4), u16(0));
  const hdlr = full('hdlr', 0, 0, u32(0), enc.encode(video ? 'vide' : 'soun'), zeros(12), enc.encode(video ? 'VideoHandler\0' : 'SoundHandler\0'));
  return { box: box('trak', tkhd, edts, box('mdia', mdhd, hdlr, minf)), movieDuration };
}

/**
 * Write an MP4 file.
 * @param {{ video: Mp4Video, audio?: Mp4Audio|null, chunkSeconds?: number }} o
 * @returns {Uint8Array[]} the file, in parts (for a Blob)
 */
export function writeMp4({ video, audio = null, chunkSeconds = 0.5 }) {
  if (!video?.samples?.length) throw new RangeError('a video needs at least one frame');
  const tracks = [video, ...(audio?.samples?.length ? [audio] : [])];
  // Chunks: runs of samples of one track spanning chunkSeconds, interleaved by time.
  const chunks = [];
  for (const [ti, t] of tracks.entries()) {
    const span = chunkSeconds * t.timescale;
    let cur = null;
    t.samples.forEach((s, i) => {
      if (!cur || s.pts - cur.start >= span) { cur = { track: ti, first: i, count: 0, start: s.pts, time: s.pts / t.timescale, bytes: 0 }; chunks.push(cur); }
      cur.count++; cur.bytes += s.data.length;
    });
  }
  chunks.sort((a, b) => a.time - b.time || a.track - b.track);
  const ftyp = box('ftyp', enc.encode('isom'), u32(0x200), enc.encode('isomiso2avc1mp41'));
  const movieTimescale = 1000;
  const build = base => {
    let off = base + 8; // after the mdat header
    const at = new Map();
    for (const c of chunks) { at.set(c, off); off += c.bytes; }
    const traks = tracks.map((t, i) => trak(t, i + 1, chunks.filter(c => c.track === i), movieTimescale, c => at.get(c)));
    const duration = Math.max(...traks.map(x => x.movieDuration));
    const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(movieTimescale), u32(duration), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(tracks.length + 1));
    return box('moov', mvhd, traks.map(x => x.box));
  };
  // The index's size does not depend on the offsets it holds (32-bit each): build it twice.
  const probe = build(0);
  const moov = build(ftyp.length + probe.length);
  const dataBytes = chunks.reduce((s, c) => s + c.bytes, 0);
  const parts = [ftyp, moov, u32(dataBytes + 8), enc.encode('mdat')];
  for (const c of chunks) for (let i = c.first; i < c.first + c.count; i++) parts.push(tracks[c.track].samples[i].data);
  return parts;
}

/**
 * Read the boxes of an MP4 back (tests and checks): type, size, offset and the
 * children of the container boxes.
 */
export function readBoxes(bytes, start = 0, end = bytes.length) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts']);
  for (let o = start; o + 8 <= end;) {
    const size = dv.getUint32(o);
    const type = String.fromCharCode(...bytes.subarray(o + 4, o + 8));
    if (size < 8 || o + size > end) throw new RangeError(`bad box ${type} at ${o}`);
    out.push({ type, size, offset: o, children: containers.has(type) ? readBoxes(bytes, o + 8, o + size) : null });
    o += size;
  }
  return out;
}
