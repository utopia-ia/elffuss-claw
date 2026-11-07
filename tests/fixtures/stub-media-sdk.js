// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
// A stand-in for the media task modules of the elffuss-ai SDK, served ONLY by the local test server in place of
// /vendor/elffuss-ai/sdk/{text-to-image,audio,video,video-gen}/index.js: the same classes, static estimate(),
// run()/generate(), onProgress by stage, signal and dispose(), with no model, no download and no GPU. The shipped page
// never contains it.
//
// The test steers it through globalThis.__mediaStub = { fits, reason, slow, failRun } and reads what happened in
// globalThis.__media: [{ ev: 'estimate'|'construct'|'run'|'abort'|'dispose', task, args, input }]. A module counts as
// downloaded after its first run, so estimate() then says missingBytes 0, as the model store would.

const log = (globalThis.__media = globalThis.__media || []);
const stub = () => (globalThis.__mediaStub = globalThis.__mediaStub || {});
const stored = (globalThis.__mediaStored = globalThis.__mediaStored || new Set());
const SIZES = { 'text-to-image': 1_200_000_000, 'text-to-music': 1_800_000_000, 'text-to-sfx': 1_800_000_000, 'text-to-speech': 330_000_000, 'image-to-video': 120_000_000, 'text-to-video': 4_300_000_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const aborted = () => Object.assign(new Error('cancelled'), { name: 'AiError', code: 'aborted' });

async function estimateOf(task) {
  log.push({ ev: 'estimate', task });
  const s = stub();
  const bytes = SIZES[task];
  if (s.fits === false) return { fits: false, reason: s.reason || 'memory', device: null, downloadBytes: bytes, missingBytes: bytes };
  return { fits: true, reason: null, device: 'webgpu', downloadBytes: bytes, missingBytes: stored.has(task) ? 0 : bytes };
}

async function png(w, h) {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#c0392b'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff'; g.fillRect(w / 4, h / 4, w / 2, h / 2);
  return c.convertToBlob({ type: 'image/png' });
}
function wav(seconds = 1, rate = 8000) {
  const n = Math.round(seconds * rate), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / 8) * 8000, true);
  return new Blob([buf], { type: 'audio/wav' });
}

class StubTask {
  constructor(task, options = {}) {
    this.task = task; this.options = options; this.disposed = false;
    log.push({ ev: 'construct', task, hasStore: !!options.store, runtime: options.runtime?.variant || null });
  }
  async _run(input, args = {}) {
    const { signal, ...rest } = args;
    log.push({ ev: 'run', task: this.task, args: rest, input: input instanceof Blob ? { type: input.type, size: input.size } : input });
    const on = this.options.onProgress || (() => {});
    const s = stub();
    const total = SIZES[this.task];
    if (!stored.has(this.task)) {
      for (let k = 1; k <= 4; k++) { on({ status: 'downloading', loaded: (total * k) / 4, total }); await sleep(20); }
    }
    on({ status: 'loading' });
    const steps = 4;
    for (let k = 1; k <= steps; k++) {
      if (signal?.aborted) { log.push({ ev: 'abort', task: this.task }); throw aborted(); }
      on({ status: 'running', stage: 'step', step: k, steps });
      await sleep(s.slow ? 600 : 20);
      if (signal?.aborted) { log.push({ ev: 'abort', task: this.task }); throw aborted(); }
    }
    if (s.failRun) throw Object.assign(new Error('the stub was told to fail'), { code: 'run-failed' });
    stored.add(this.task);
    on({ status: 'done' });
    if (this.task === 'text-to-image') return { blob: await png(64, 36), mime: 'image/png', width: 64, height: 36, seed: 7, steps: 2, prompt: rest.prompt, model: 'stub', device: 'webgpu' };
    if (this.task.startsWith('text-to-') && this.task !== 'text-to-video') return { blob: wav(1), mime: 'audio/wav', seconds: 1, sampleRate: 8000, channels: 1, seed: 3, model: 'stub', device: 'webgpu' };
    return { blob: new Blob([new Uint8Array([26, 69, 223, 163, 1, 0, 0, 0])], { type: 'video/webm' }), mime: 'video/webm', width: 64, height: 36, seconds: 2, fps: 30, model: 'stub', device: 'webgpu' };
  }
  run(input, args) { return this._run(input, args); }
  async dispose() { if (!this.disposed) { this.disposed = true; log.push({ ev: 'dispose', task: this.task }); } }
}

// text-to-image
export class TextToImage extends StubTask {
  constructor(o) { super('text-to-image', o); }
  generate(request, { signal } = {}) { return this._run(null, { ...request, signal }); }
  static estimate() { return estimateOf('text-to-image'); }
}
// audio
export class Music extends StubTask { constructor(o) { super('text-to-music', o); } static estimate() { return estimateOf('text-to-music'); } }
export class Sfx extends StubTask { constructor(o) { super('text-to-sfx', o); } static estimate() { return estimateOf('text-to-sfx'); } }
export class Speech extends StubTask { constructor(o) { super('text-to-speech', o); } static estimate() { return estimateOf('text-to-speech'); } }
// video
export class Video extends StubTask { constructor(o) { super('image-to-video', o); } static estimate() { return estimateOf('image-to-video'); } }
// video-gen
export class TextToVideo extends StubTask { constructor(o) { super('text-to-video', o); } }
export function estimate() { return estimateOf('text-to-video'); }
