// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
// A stand-in for vendor/elffuss-asr/index.js (Whisper in this browser), served ONLY by the local test server: the same
// SpeechToText API with no model. It writes down «hola desde la nota de voz» and records each call in
// globalThis.__media as { ev: 'asr', language, samples }. The first estimate() says the model is still to download.
const log = (globalThis.__media = globalThis.__media || []);
let stored = false;
export const registry = async () => ({ schema: 1, tasks: {}, models: {} });
export const preferredDevice = () => 'auto';
export class SpeechToText {
  constructor(o = {}) { this.o = o; log.push({ ev: 'construct', task: 'speech-to-text' }); }
  static async estimate() { log.push({ ev: 'estimate', task: 'speech-to-text' }); return { fits: true, reason: null, device: 'webgpu', downloadBytes: 293759168, missingBytes: stored ? 0 : 293759168 }; }
  async run(samples, { language, signal } = {}) {
    log.push({ ev: 'asr', language, samples: samples?.length || 0, rate16k: samples instanceof Float32Array });
    this.o.onProgress?.({ status: 'running', stage: 'transcribe' });
    await new Promise((r) => setTimeout(r, 50));
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'aborted' });
    stored = true;
    return { text: language === 'es' ? 'hola desde la nota de voz' : 'hello from the voice note' };
  }
  async dispose() { log.push({ ev: 'dispose', task: 'speech-to-text' }); }
}
