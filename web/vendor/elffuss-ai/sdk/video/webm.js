// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// A small WebM (Matroska) writer, the fallback when this browser cannot encode
// H.264: one VP9 or VP8 video track and at most one Opus audio track, every
// block in memory, clusters that start at key frames, and cues so a player can
// seek. Pure: Node tests it by reading the elements back.

const enc = new TextEncoder();

/** EBML variable-size integer of a size (8 bytes when it does not matter). */
function vsize(n) {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const out = new Uint8Array(len);
      let v = n;
      for (let i = len - 1; i >= 0; i--) { out[i] = v & 255; v = Math.floor(v / 256); }
      out[0] |= 1 << (8 - len);
      return out;
    }
  }
  throw new RangeError('element too large');
}

/** An element: id (as bytes) and payload parts. */
function el(id, ...parts) {
  const flat = parts.flat(Infinity).filter(Boolean);
  const n = flat.reduce((s, p) => s + p.length, 0);
  const idb = Uint8Array.from(id);
  const sz = vsize(n);
  const out = new Uint8Array(idb.length + sz.length + n);
  out.set(idb, 0); out.set(sz, idb.length);
  let o = idb.length + sz.length;
  for (const p of flat) { out.set(p, o); o += p.length; }
  return out;
}
const uint = v => { const b = []; let x = Math.max(0, Math.round(v)); do { b.unshift(x & 255); x = Math.floor(x / 256); } while (x > 0); return Uint8Array.from(b); };
const f64 = v => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return b; };
const str = s => enc.encode(s);

const ID = {
  EBML: [0x1a, 0x45, 0xdf, 0xa3], EBMLVersion: [0x42, 0x86], EBMLReadVersion: [0x42, 0xf7], EBMLMaxIDLength: [0x42, 0xf2], EBMLMaxSizeLength: [0x42, 0xf3],
  DocType: [0x42, 0x82], DocTypeVersion: [0x42, 0x87], DocTypeReadVersion: [0x42, 0x85],
  Segment: [0x18, 0x53, 0x80, 0x67], Info: [0x15, 0x49, 0xa9, 0x66], TimecodeScale: [0x2a, 0xd7, 0xb1], Duration: [0x44, 0x89], MuxingApp: [0x4d, 0x80], WritingApp: [0x57, 0x41],
  Tracks: [0x16, 0x54, 0xae, 0x6b], TrackEntry: [0xae], TrackNumber: [0xd7], TrackUID: [0x73, 0xc5], TrackType: [0x83], CodecID: [0x86], CodecPrivate: [0x63, 0xa2],
  CodecDelay: [0x56, 0xaa], SeekPreRoll: [0x56, 0xbb], Video: [0xe0], PixelWidth: [0xb0], PixelHeight: [0xba], Audio: [0xe1], SamplingFrequency: [0xb5], Channels: [0x9f],
  Cluster: [0x1f, 0x43, 0xb6, 0x75], Timecode: [0xe7], SimpleBlock: [0xa3],
  Cues: [0x1c, 0x53, 0xbb, 0x6b], CuePoint: [0xbb], CueTime: [0xb3], CueTrackPositions: [0xb7], CueTrack: [0xf7], CueClusterPosition: [0xf1],
};

/** OpusHead for a stream (the codec's own header, as WebM carries it). */
export function opusHead(channels, sampleRate, preSkip = 312) {
  const b = new Uint8Array(19);
  b.set(str('OpusHead'), 0);
  const dv = new DataView(b.buffer);
  b[8] = 1; b[9] = channels;
  dv.setUint16(10, preSkip, true); dv.setUint32(12, sampleRate, true); dv.setInt16(16, 0, true); b[18] = 0;
  return b;
}

/**
 * @typedef {{ data: Uint8Array, us: number, key: boolean }} WebmBlock `us`: presentation time in microseconds
 */

/**
 * Write a WebM file.
 * @param {{ video: { codec: 'vp9'|'vp8', width: number, height: number, blocks: WebmBlock[] },
 *   audio?: { sampleRate: number, channels: number, head?: Uint8Array, blocks: WebmBlock[] } | null, durationUs: number }} o
 * @returns {Uint8Array[]}
 */
export function writeWebm({ video, audio = null, durationUs }) {
  if (!video?.blocks?.length) throw new RangeError('a video needs at least one frame');
  const header = el(ID.EBML, el(ID.EBMLVersion, uint(1)), el(ID.EBMLReadVersion, uint(1)), el(ID.EBMLMaxIDLength, uint(4)), el(ID.EBMLMaxSizeLength, uint(8)),
    el(ID.DocType, str('webm')), el(ID.DocTypeVersion, uint(4)), el(ID.DocTypeReadVersion, uint(2)));
  const info = el(ID.Info, el(ID.TimecodeScale, uint(1e6)), el(ID.Duration, f64(durationUs / 1000)), el(ID.MuxingApp, str('elffuss-ai')), el(ID.WritingApp, str('elffuss-ai')));
  const tracks = [el(ID.TrackEntry, el(ID.TrackNumber, uint(1)), el(ID.TrackUID, uint(1)), el(ID.TrackType, uint(1)), el(ID.CodecID, str(video.codec === 'vp8' ? 'V_VP8' : 'V_VP9')),
    el(ID.Video, el(ID.PixelWidth, uint(video.width)), el(ID.PixelHeight, uint(video.height))))];
  const hasAudio = Boolean(audio?.blocks?.length);
  if (hasAudio) {
    tracks.push(el(ID.TrackEntry, el(ID.TrackNumber, uint(2)), el(ID.TrackUID, uint(2)), el(ID.TrackType, uint(2)), el(ID.CodecID, str('A_OPUS')),
      el(ID.CodecPrivate, audio.head || opusHead(audio.channels, audio.sampleRate)), el(ID.CodecDelay, uint(6500000)), el(ID.SeekPreRoll, uint(80000000)),
      el(ID.Audio, el(ID.SamplingFrequency, f64(audio.sampleRate)), el(ID.Channels, uint(audio.channels)))));
  }
  const trackEl = el(ID.Tracks, tracks);
  // Blocks of both tracks by time; a new cluster at each video key frame, and before the
  // 16-bit relative timecode of a block could overflow.
  const all = [...video.blocks.map(b => ({ ...b, track: 1 })), ...(hasAudio ? audio.blocks.map(b => ({ ...b, track: 2 })) : [])]
    .sort((a, b) => a.us - b.us || a.track - b.track);
  const clusters = [];
  let cur = null;
  for (const b of all) {
    const ms = Math.round(b.us / 1000);
    if (!cur || (b.track === 1 && b.key && ms > cur.ms) || ms - cur.ms > 30000) { cur = { ms, blocks: [] }; clusters.push(cur); }
    cur.blocks.push({ ...b, ms });
  }
  const clusterEls = clusters.map(c => el(ID.Cluster, el(ID.Timecode, uint(c.ms)), c.blocks.map(b => {
    const head = new Uint8Array(4);
    head[0] = 0x80 | b.track;
    new DataView(head.buffer).setInt16(1, b.ms - c.ms);
    head[3] = b.key ? 0x80 : 0;
    return el(ID.SimpleBlock, head, b.data);
  })));
  // Cues: each cluster's position from the start of the Segment's payload.
  const cuesFor = base => {
    let pos = base;
    const points = clusters.map((c, i) => { const p = el(ID.CuePoint, el(ID.CueTime, uint(c.ms)), el(ID.CueTrackPositions, el(ID.CueTrack, uint(1)), el(ID.CueClusterPosition, uint(pos)))); pos += clusterEls[i].length; return p; });
    return el(ID.Cues, points);
  };
  const before = info.length + trackEl.length;
  let cues = cuesFor(before);
  cues = cuesFor(before); // positions come before the cues: they do not move
  const body = [info, trackEl, ...clusterEls, cues];
  const size = body.reduce((s, p) => s + p.length, 0);
  const seg = new Uint8Array([...ID.Segment, ...vsize(size)]);
  return [header, seg, ...body];
}

/** Read top-level elements back (tests): id in hex, size, offset of the payload. */
export function readElements(bytes, start = 0, end = bytes.length) {
  const out = [];
  let o = start;
  const vint = (keepMarker) => {
    const first = bytes[o];
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    let v = keepMarker ? first : first & (0xff >> len);
    for (let i = 1; i < len; i++) v = v * 256 + bytes[o + i];
    o += len;
    return { v, len };
  };
  while (o < end) {
    const id = vint(true), size = vint(false);
    out.push({ id: id.v.toString(16), size: size.v, at: o });
    o += size.v;
  }
  return out;
}
