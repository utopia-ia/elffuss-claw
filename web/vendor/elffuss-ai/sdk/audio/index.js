// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Audio from text in the browser: music and sound effects with Stable Audio 3
// Small (Stability AI, Stability AI Community License; its text encoder T5Gemma
// is also under the Gemma Terms of Use) on WebGPU, and speech in Spanish and
// English with Kokoro 82M (hexgrad, Apache-2.0) on WebGPU or WebAssembly. The
// models come from their Hugging Face repositories at pinned revisions, through
// the Elffuss model store. Each task class runs its model in a module Worker of
// this module (its URL is relative to this file, so the module can be served
// from any origin together with the core and the runtimes).
//
// The options of run() are plain JSON, so a chat or an agent can pass a tool
// call straight through: { prompt, seconds, seed } for music and sound effects,
// { text, voice, lang, speed } for speech. A run gives a WAV Blob and what it is.

import { Task, oneShot, TASK_OPTIONS } from '../core/task.js';
import { AiError, toAiError } from '../core/errors.js';
import { loadRegistry, getModel, defaultModelId, variantFiles } from '../core/registry.js';
import { probeWebGPU, chooseVariant } from '../core/device.js';
import { DURATION, STEPS, MAX_PROMPT } from './stable-audio.js';
import { MAX_TEXT } from './speech.impl.js';
import { VOICES, DEFAULT_VOICE, SPEED } from './kokoro.js';

export { encodeWav, decodeWav } from './wav.js';
export { peaks, measure, fadeIn, fadeOut } from './signal.js';
export { MAX_SEED, randomSeed } from './rng.js';
export { VOICES, DEFAULT_VOICE, SPEED, DURATION, STEPS, MAX_PROMPT, MAX_TEXT };

/**
 * @typedef {{ blob: Blob, mime: 'audio/wav', seconds: number, sampleRate: number, channels: number, seed?: number,
 *   model: string, device: 'webgpu'|'wasm', dtype: string, stats: { peakDb: number, rmsDb: number, clipped: number, silent: number } } & Record<string, any>} AudioResult
 *   What `run()` gives: `blob` is a 16-bit PCM WAV of `seconds` at `sampleRate` (44 100 Hz stereo for music and
 *   sound effects, 24 000 Hz mono for speech); `seed` reproduces a music or sound clip; `stats` measures it.
 * @typedef {{ status: string, stage?: 'download'|'load'|'encode'|'step'|'decode'|'phonemes'|'chunk', step?: number, steps?: number,
 *   chunk?: number, chunks?: number, loaded?: number, total?: number }} AudioProgress
 *   Progress events: `download` (loaded/total bytes), `load`, then for music and sound `encode`, `step` (step of steps)
 *   and `decode`; for speech `phonemes` and `chunk` (chunk of chunks); finally status `done`.
 * @typedef {{ fits: boolean, reason: string|null, device: 'webgpu'|'wasm'|null, downloadBytes: number, missingBytes: number }} AudioEstimate
 *   What a run would need here, without downloading anything: `reason` is null when it fits, otherwise
 *   `webgpu-unavailable`, `no-shader-f16`, `gpu-limits`, `memory` or `device-unsupported`.
 */

const STAGES = { downloading: 'download', loading: 'load', checking: 'load', ready: 'load' };
/** Options of a task, with progress events named by stage. */
function withStages(options = {}) {
  const on = options.onProgress;
  if (!on) return options;
  return { ...options, onProgress: p => on(p && !p.stage && STAGES[p.status] ? { ...p, stage: STAGES[p.status] } : p) };
}

/** Plain JSON options go to the Worker as they are. */
async function prepare(input) {
  if (!input || typeof input !== 'object') throw new AiError('unsupported-format', 'run() takes an object of options');
  return { value: JSON.parse(JSON.stringify(input)), transfer: [] };
}

/** Largest single weight (bytes) a WebGPU buffer must hold, per task. */
const BIGGEST_TENSOR = { 'text-to-music': 400e6, 'text-to-sfx': 400e6, 'text-to-speech': 50e6 };

/**
 * What a run of `task` would need in this browser (no download): whether it fits, and
 * what it would download. `opts.store` (any object with has(url, bytes)) tells what is
 * already in this browser; without one, everything counts as missing.
 * @param {string} task
 * @param {{ registry?: object, registryUrl?: string, model?: string, store?: { has(url: string, bytes: number): Promise<boolean> } }} [opts]
 * @param {'auto'|'webgpu'|'wasm'} [device]
 * @returns {Promise<AudioEstimate>}
 */
export async function estimateTask(task, opts = {}, device = 'auto') {
  const registry = opts.registry || await loadRegistry(opts.registryUrl);
  const model = getModel(registry, opts.model || defaultModelId(registry, task));
  const probe = await probeWebGPU();
  let choice;
  try { choice = chooseVariant(model, device, probe); } catch (err) {
    const e = toAiError(err);
    const all = Object.values(model.devices).flat().map(v => v.bytes);
    const reason = e.code === 'device-unsupported' && probe.available && !probe.shaderF16 && model.devices.webgpu?.every(v => v.when === 'shader-f16') ? 'no-shader-f16' : e.code;
    return { fits: false, reason, device: null, downloadBytes: Math.min(...all), missingBytes: Math.min(...all) };
  }
  const files = variantFiles(model, choice.variant);
  const downloadBytes = files.reduce((s, f) => s + f.size, 0);
  let missingBytes = downloadBytes;
  if (opts.store) {
    try {
      const has = await Promise.all(files.map(f => opts.store.has(f.url, f.size)));
      missingBytes = files.reduce((s, f, i) => s + (has[i] ? 0 : f.size), 0);
    } catch { /* the store did not answer: count everything */ }
  }
  let reason = null;
  if (choice.device === 'webgpu') {
    try {
      const adapter = await globalThis.navigator?.gpu?.requestAdapter();
      const lim = adapter?.limits;
      if (lim && (lim.maxStorageBufferBindingSize < BIGGEST_TENSOR[task] || lim.maxBufferSize < BIGGEST_TENSOR[task])) reason = 'gpu-limits';
    } catch { /* the probe already said WebGPU works */ }
  }
  const mem = globalThis.navigator?.deviceMemory;
  if (!reason && mem && task !== 'text-to-speech' && mem < 4) reason = 'memory';
  return { fits: !reason, reason, device: choice.device, downloadBytes, missingBytes };
}

const spec = (task, name) => ({ task, workerUrl: new URL(`./${name}.worker.js`, import.meta.url), impl: () => import(`./${name}.impl.js`), prepare });

/**
 * Music from a text description, with Stable Audio 3 Small Music, on WebGPU with
 * shader-f16. The first load asks the model store for its files (about 1.8 GB,
 * shared with `Sfx` but its DiT) and checks their hashes.
 *
 * ```js
 * import { Music } from '@elffuss/ai/audio';
 * const music = new Music({ onProgress: p => console.log(p.stage, p.step, p.steps) });
 * const { blob, seconds, seed } = await music.run({ prompt: 'Lo-fi hip hop, mellow piano, 80 BPM', seconds: 30, seed: 7 });
 * await music.dispose();   // frees every WebGPU buffer and the Worker
 * ```
 *
 * `run({ prompt, seconds, seed, steps }, { signal })`: `seconds` 2 to 120 (30), `seed`
 * 0 to 2147483647 (random when left out, and given back), `steps` 4 to 16 (8).
 * Resolves to an `AudioResult` (44 100 Hz stereo WAV).
 * @extends Task
 */
export class Music extends Task {
  /** @param {import('../core/task.js').TaskOptions} [options] */
  constructor(options) { super(spec('text-to-music', 'music'), withStages(options)); }
  /** What a run would need here; see `estimateTask`. */
  static estimate(opts, device) { return estimateTask('text-to-music', opts, device); }
}

/**
 * Sound effects from a text description, with Stable Audio 3 Small SFX, on WebGPU
 * with shader-f16. Same options and result as `Music`; `seconds` 0.5 to 30 (5).
 * @extends Task
 */
export class Sfx extends Task {
  /** @param {import('../core/task.js').TaskOptions} [options] */
  constructor(options) { super(spec('text-to-sfx', 'sfx'), withStages(options)); }
  /** What a run would need here; see `estimateTask`. */
  static estimate(opts, device) { return estimateTask('text-to-sfx', opts, device); }
}

/**
 * Speech from text in Spanish or English, with Kokoro 82M, on WebGPU or WebAssembly.
 * Long texts are read sentence by sentence and joined with natural pauses.
 *
 * `run({ text, voice, lang, speed }, { signal })`: `voice` one of `VOICES` (by
 * default `ef_dora` in Spanish, `af_heart` in English), `lang` 'es' or 'en' (by
 * default the voice's), `speed` 0.5 to 2 (1). Resolves to an `AudioResult`
 * (24 000 Hz mono WAV) with the voice, language and chunks read.
 * @extends Task
 */
export class Speech extends Task {
  /** @param {import('../core/task.js').TaskOptions} [options] */
  constructor(options) { super(spec('text-to-speech', 'speech'), withStages(options)); }
  /** What a run would need here; see `estimateTask`. */
  static estimate(opts, device) { return estimateTask('text-to-speech', opts, device); }
}

/**
 * Load, run once and dispose, for tool calls: `await music({ prompt, seconds, seed })`.
 * Options of the task (device, store, onProgress, signal…) may go in the same object.
 * @type {(input: { prompt: string, seconds?: number, seed?: number, steps?: number } & import('../core/task.js').TaskOptions) => Promise<AudioResult>}
 */
export const music = splitCall(Music);
/** Load, run once and dispose: `await sfx({ prompt, seconds, seed })`. @type {typeof music} */
export const sfx = splitCall(Sfx);
/**
 * Load, run once and dispose: `await speak({ text, voice, lang, speed })`.
 * @type {(input: { text: string, voice?: string, lang?: 'es'|'en', speed?: number } & import('../core/task.js').TaskOptions) => Promise<AudioResult>}
 */
export const speak = splitCall(Speech);

/** The one-call form: task options and run options in one object. */
function splitCall(TaskClass) {
  const once = oneShot(TaskClass);
  return (input = {}) => {
    const ctor = {}, run = {};
    for (const [k, v] of Object.entries(input)) (TASK_OPTIONS.includes(k) ? ctor : run)[k] = v;
    const { signal, ...rest } = ctor;
    return once(run, { ...rest, ...(signal ? { signal } : {}) });
  };
}

/** The audio tools as a chat or an agent calls them: `audio.music`, `audio.sfx`, `audio.speak`. */
export const audio = Object.freeze({ music, sfx, speak });
