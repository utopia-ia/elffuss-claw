// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The exporter: frames (any frame source) and, if given, a soundtrack in, a
// video file out, with the browser's own encoders (WebCodecs) and the small
// writers of this module (mp4.js, webm.js). MP4 with H.264 where the browser
// encodes it, with AAC sound (or Opus where AAC is not offered); otherwise WebM
// with VP9 (or VP8) and Opus. It works in a Worker or in the page, and knows
// nothing of photos or cameras: any task that makes frames can use it (a video
// generated from text, for one).
//
//   import { encodeVideo } from '@elffuss/ai/video/encode';
//   const { blob, mime } = await encodeVideo({ width: 1280, height: 720, fps: 30, frames: 90,
//     frame: (i, us) => canvasOrBitmapOrVideoFrame, audio: { sampleRate: 48000, channels: [left, right] } });

import { AiError, throwIfAborted } from '../core/errors.js';
import { writeMp4 } from './mp4.js';
import { writeWebm, opusHead } from './webm.js';

/** Bits per second of the video by default: generous, for a clean picture after a platform re-encodes it. */
export function defaultBitrate(width, height, fps) {
  const px = width * height * Math.max(24, fps);
  return Math.round(Math.min(40e6, Math.max(4e6, px * 0.24)));
}

/** H.264 codec strings to try, best first (High profile; the level by size and rate). */
export function avcCandidates(width, height, fps) {
  const mbps = Math.ceil(width / 16) * Math.ceil(height / 16) * fps;
  const level = mbps <= 245760 ? '28' : mbps <= 522240 ? '2a' : '33';
  return [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.4200${level}`, 'avc1.640033'];
}

/**
 * The encoders this browser offers for a video: container, video and audio
 * codec configurations, or a reason why it cannot.
 * @param {{ width: number, height: number, fps: number, bitrate?: number, audio?: boolean, audioRate?: number, container?: 'auto'|'mp4'|'webm', scope?: any }} o
 * @returns {Promise<{ container: 'mp4'|'webm', video: VideoEncoderConfig, audio: AudioEncoderConfig|null } | { container: null, reason: string }>}
 */
export async function chooseCodecs({ width, height, fps, bitrate = defaultBitrate(width, height, fps), audio = false, audioRate = 48000, container = 'auto', scope = globalThis }) {
  const VE = scope.VideoEncoder, AE = scope.AudioEncoder;
  if (typeof VE !== 'function' || typeof scope.VideoFrame !== 'function') return { container: null, reason: 'webcodecs-unavailable' };
  const tryVideo = async codecs => {
    for (const codec of codecs) {
      for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
        const cfg = { codec, width, height, bitrate, framerate: fps, bitrateMode: 'variable', latencyMode: 'quality', hardwareAcceleration, ...(codec.startsWith('avc1') ? { avc: { format: 'avc' } } : {}) };
        try { const s = await VE.isConfigSupported(cfg); if (s?.supported) return s.config || cfg; } catch { /* next */ }
      }
    }
    return null;
  };
  const tryAudio = async codecs => {
    if (!audio || typeof AE !== 'function') return null;
    for (const codec of codecs) {
      const cfg = { codec, sampleRate: audioRate, numberOfChannels: 2, bitrate: codec === 'opus' ? 160000 : 192000 };
      try { const s = await AE.isConfigSupported(cfg); if (s?.supported) return s.config || cfg; } catch { /* next */ }
    }
    return null;
  };
  if (container !== 'webm') {
    const v = await tryVideo(avcCandidates(width, height, fps));
    if (v) return { container: 'mp4', video: v, audio: await tryAudio(['mp4a.40.2', 'opus']) };
    if (container === 'mp4') return { container: null, reason: 'h264-unavailable' };
  }
  const v = await tryVideo(['vp09.00.40.08', 'vp09.00.31.08', 'vp8']);
  if (v) return { container: 'webm', video: v, audio: await tryAudio(['opus']) };
  return { container: null, reason: 'encoder-unavailable' };
}

/** A copy of the bytes of a BufferSource. */
const bytesOf = b => (ArrayBuffer.isView(b) ? new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : new Uint8Array(b.slice(0)));

const nextTick = () => new Promise(r => setTimeout(r, 0));

/** Wait until an encoder's queue is short (the frames it holds are memory). */
async function drain(encoder, max) {
  while (encoder.encodeQueueSize > max) {
    await new Promise(r => {
      const done = () => { encoder.removeEventListener?.('dequeue', done); r(); };
      if (encoder.addEventListener) { encoder.addEventListener('dequeue', done); setTimeout(done, 50); } else setTimeout(r, 4);
    });
  }
}

/** A VideoFrame of a frame source (VideoFrame, canvas, ImageBitmap or ImageData). */
function toVideoFrame(src, timestamp, duration, scope) {
  if (src instanceof scope.VideoFrame) return new scope.VideoFrame(src, { timestamp, duration });
  if (typeof scope.ImageData === 'function' && src instanceof scope.ImageData) {
    return new scope.VideoFrame(src.data, { format: 'RGBA', codedWidth: src.width, codedHeight: src.height, timestamp, duration });
  }
  return new scope.VideoFrame(src, { timestamp, duration, alpha: 'discard' });
}

/** The colour box of MP4 from a WebCodecs colour space (BT.709 limited range when it says nothing). */
function colourOf(cs) {
  const P = { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9, smpte432: 12 };
  const T = { bt709: 1, smpte170m: 6, 'iec61966-2-1': 13, linear: 8, pq: 16, hlg: 18 };
  const M = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, 'bt2020-ncl': 9 };
  return { primaries: P[cs?.primaries] ?? 1, transfer: T[cs?.transfer] ?? 1, matrix: M[cs?.matrix] ?? 1, fullRange: Boolean(cs?.fullRange) };
}

/**
 * Encode a video.
 * @param {{ width: number, height: number, fps: number, frames: number,
 *   frame: (index: number, timestampUs: number) => (CanvasImageSource|VideoFrame|ImageData|Promise<CanvasImageSource|VideoFrame|ImageData>),
 *   audio?: { sampleRate: number, channels: Float32Array[] } | null, container?: 'auto'|'mp4'|'webm', bitrate?: number,
 *   keyEvery?: number, signal?: AbortSignal, onProgress?: (p: { stage: 'render'|'mux', frame?: number, frames?: number }) => void, scope?: any }} o
 *   `frame` gives frame `index` (0 based); a VideoFrame it returns is closed here. `audio` holds one array of
 *   samples (-1 to 1) per channel, already as long as the video; `keyEvery` is in seconds.
 * @returns {Promise<{ blob: Blob, mime: string, container: 'mp4'|'webm', videoCodec: string, audioCodec: string|null,
 *   width: number, height: number, fps: number, frames: number, seconds: number, bytes: number }>}
 */
export async function encodeVideo({ width, height, fps, frames, frame, audio = null, container = 'auto', bitrate, keyEvery = 2, signal, onProgress, scope = globalThis }) {
  if (!(width > 0 && height > 0 && width % 2 === 0 && height % 2 === 0)) throw new AiError('run-failed', 'the video size must be even and positive', { details: { width, height } });
  if (!(fps > 0) || !(frames > 0)) throw new AiError('run-failed', 'a video needs a frame rate and frames');
  const rate = bitrate || defaultBitrate(width, height, fps);
  const choice = await chooseCodecs({ width, height, fps, bitrate: rate, audio: Boolean(audio?.channels?.length), audioRate: audio?.sampleRate || 48000, container, scope });
  if (!choice.container) throw new AiError('device-unsupported', 'this browser cannot encode video', { details: { reason: choice.reason } });
  const say = p => { try { onProgress?.(p); } catch { /* listener */ } };

  // Video.
  const vchunks = [];
  let description = null, colour = null, failure = null;
  const venc = new scope.VideoEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      vchunks.push({ data, us: chunk.timestamp, dur: chunk.duration ?? Math.round(1e6 / fps), key: chunk.type === 'key' });
      if (meta?.decoderConfig?.description && !description) description = bytesOf(meta.decoderConfig.description);
      if (meta?.decoderConfig?.colorSpace && !colour) colour = meta.decoderConfig.colorSpace;
    },
    error: e => { failure = e; },
  });
  venc.configure(choice.video);
  const step = 1e6 / fps;
  const keyFrames = Math.max(1, Math.round(keyEvery * fps));
  try {
    for (let i = 0; i < frames; i++) {
      throwIfAborted(signal);
      if (failure) throw failure;
      const us = Math.round(i * step);
      const src = await frame(i, us);
      const vf = toVideoFrame(src, us, Math.round((i + 1) * step) - us, scope);
      if (src instanceof scope.VideoFrame) src.close();
      venc.encode(vf, { keyFrame: i % keyFrames === 0 });
      vf.close();
      say({ stage: 'render', frame: i + 1, frames });
      await drain(venc, 3);
      if (i % 8 === 7) await nextTick();
    }
    await venc.flush();
    if (failure) throw failure;
  } catch (err) {
    try { venc.close(); } catch { /* closed */ }
    if (err?.code) throw err;
    throw new AiError('run-failed', 'the video encoder failed: ' + (err?.message || err), { cause: err });
  }
  try { venc.close(); } catch { /* closed */ }

  // Sound.
  let achunks = [], adesc = null;
  if (choice.audio && audio?.channels?.length) {
    throwIfAborted(signal);
    const aenc = new scope.AudioEncoder({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        achunks.push({ data, us: chunk.timestamp, dur: chunk.duration });
        if (meta?.decoderConfig?.description && !adesc) adesc = bytesOf(meta.decoderConfig.description);
      },
      error: e => { failure = e; },
    });
    aenc.configure(choice.audio);
    const ch = choice.audio.numberOfChannels;
    const sr = audio.sampleRate;
    const total = audio.channels[0].length;
    const block = 4096;
    for (let s = 0; s < total; s += block) {
      const n = Math.min(block, total - s);
      const planar = new Float32Array(n * ch);
      for (let c = 0; c < ch; c++) planar.set(audio.channels[Math.min(c, audio.channels.length - 1)].subarray(s, s + n), c * n);
      const data = new scope.AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round(s * 1e6 / sr), data: planar });
      aenc.encode(data);
      data.close();
      if (failure) break;
    }
    await aenc.flush();
    try { aenc.close(); } catch { /* closed */ }
    if (failure) throw new AiError('run-failed', 'the audio encoder failed: ' + (failure?.message || failure), { cause: failure });
  }
  throwIfAborted(signal);
  say({ stage: 'mux' });

  const seconds = frames / fps;
  let parts, mime;
  const audioCodec = achunks.length ? choice.audio.codec : null;
  if (choice.container === 'mp4') {
    if (!description) throw new AiError('run-failed', 'the H.264 encoder gave no decoder configuration');
    const ts = Math.round(fps) * 1000;
    const vt = { kind: 'video', codec: 'avc1', width, height, timescale: ts, description, colour: colourOf(colour),
      samples: vchunks.map(c => ({ data: c.data, pts: Math.round(c.us * ts / 1e6), duration: Math.round(c.dur * ts / 1e6) || Math.round(ts / fps), key: c.key })) };
    let at = null;
    if (achunks.length) {
      const sr = choice.audio.sampleRate;
      const t0 = Math.min(...achunks.map(c => c.us));
      at = { kind: 'audio', codec: audioCodec === 'opus' ? 'opus' : 'mp4a', sampleRate: sr, channels: choice.audio.numberOfChannels, timescale: sr,
        description: audioCodec === 'opus' ? null : adesc, bitrate: choice.audio.bitrate,
        samples: achunks.map(c => ({ data: c.data, pts: Math.round((c.us - t0) * sr / 1e6), duration: Math.round((c.dur || 0) * sr / 1e6) || (audioCodec === 'opus' ? 960 : 1024), key: true })) };
    }
    parts = writeMp4({ video: vt, audio: at });
    mime = `video/mp4; codecs="${[choice.video.codec, audioCodec].filter(Boolean).join(', ')}"`;
  } else {
    parts = writeWebm({
      video: { codec: choice.video.codec.startsWith('vp8') ? 'vp8' : 'vp9', width, height, blocks: vchunks.map(c => ({ data: c.data, us: c.us, key: c.key })) },
      audio: achunks.length ? { sampleRate: choice.audio.sampleRate, channels: choice.audio.numberOfChannels, head: adesc?.length >= 19 ? adesc : opusHead(choice.audio.numberOfChannels, choice.audio.sampleRate), blocks: achunks.map(c => ({ data: c.data, us: c.us, key: true })) } : null,
      durationUs: Math.round(seconds * 1e6),
    });
    mime = `video/webm; codecs="${[choice.video.codec.startsWith('vp8') ? 'vp8' : 'vp9', audioCodec].filter(Boolean).join(', ')}"`;
  }
  const blob = new Blob(parts, { type: mime.split(';')[0] });
  return { blob, mime, container: choice.container, videoCodec: choice.video.codec, audioCodec, width, height, fps, frames, seconds, bytes: blob.size };
}
