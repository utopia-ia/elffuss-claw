// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// What runs where the model runs (a Worker, or the page with worker: false):
// read the registry, pick the backend and variant, ask the store what it has,
// and hand the task's implementation a context with everything it may use.
//
// A task implementation (sdk/<task>/impl.js) exports:
//   task                         the task name of the registry ('depth', 'ocr', …)
//   load(ctx)        → state     create sessions or pipelines through ctx
//   run(state, input, opts, ctx) → value | { value, transfer }
//   dispose(state)               release what load created
// and never fetches, never touches the DOM and never reads files by itself.

import { AiError, toAiError } from './errors.js';
import { loadRegistry, getModel, defaultModelId, variantFiles, resolveRef } from './registry.js';
import { probeWebGPU, chooseVariant } from './device.js';
import { createProgress } from './progress.js';
import { createVerifiedMemo, verifyFile } from './integrity.js';
import { loadTransformers, createStoreFetch, createPipeline } from './tf-env.js';
import { loadOrt, createSession } from './ort-env.js';
import { PINS } from './runtime-pins.js';

/**
 * @typedef {{ model?: string, device?: import('./device.js').DeviceRequest, registry?: import('./registry.js').Registry,
 *   registryUrl?: string, runtime: import('./runtimes.js').RuntimeUrls, test?: TestFlags | null }} LoadOptions
 * @typedef {{ pins?: Partial<typeof PINS>, failLoad?: boolean, failRun?: boolean }} TestFlags
 *   Test builds only: `pins` replaces the expected runtime versions (to prove the check fails);
 *   `failLoad` asks impl.load to create a session from bytes that are not a model, and `failRun`
 *   asks impl.run to feed the model an input of an impossible shape, both inside the runtime.
 *   The Task passes each of them to the first load or run only.
 * @typedef {{ model: string, task: string, device: 'webgpu'|'wasm', dtype: string, fromStore: boolean, bytes: number, files: string[] }} LoadInfo
 */

/**
 * Load a task implementation. Realm-independent: `store` is the page's store
 * client or the Worker's bridge to it.
 * @param {any} impl
 * @param {LoadOptions} opts
 * @param {{ store: { has(u: string, b: number): Promise<boolean>, get(u: string, o: object): Promise<Blob> }, onProgress?: Function, memo?: any, log?: Function }} env
 * @returns {Promise<{ state: any, ctx: TaskContext, info: LoadInfo }>}
 */
export async function loadTask(impl, opts, { store, onProgress, memo = createVerifiedMemo(), log }) {
  const registry = opts.registry || await loadRegistry(opts.registryUrl);
  if (!opts.model && impl.task == null) throw new AiError('not-in-registry', 'a model id is needed');
  const modelId = opts.model || defaultModelId(registry, impl.task);
  const model = getModel(registry, modelId);
  // impl.task null accepts any model (diagnostic implementations such as the test smoke).
  if (impl.task != null && model.task !== impl.task) throw new AiError('not-in-registry', `${modelId} is not a ${impl.task} model`);
  const probe = await probeWebGPU();
  const choice = chooseVariant(model, opts.device || 'auto', probe);
  const files = variantFiles(model, choice.variant);
  const progress = createProgress({ files, onProgress });
  progress.status('checking');
  let cached;
  try {
    cached = new Map(await Promise.all(files.map(async f => [f.url, await store.has(f.url, f.size)])));
  } catch (err) {
    throw toAiError(err, 'store-unavailable');
  }
  const missing = files.filter(f => !cached.get(f.url)).reduce((s, f) => s + f.size, 0);
  progress.status(missing ? 'downloading' : 'loading', { missing });
  const pins = { ...PINS, ...(opts.test?.pins || {}) };
  const ctx = new TaskContext({ registry, modelId, model, choice, files, store, progress, memo, cached, runtime: opts.runtime, pins, test: opts.test || null, log });
  let state;
  try {
    state = await impl.load(ctx);
  } catch (err) {
    throw toAiError(err, 'run-failed');
  }
  progress.status('ready');
  const info = { model: modelId, task: impl.task, device: choice.device, dtype: choice.dtype, fromStore: missing === 0, bytes: choice.variant.bytes, files: files.map(f => f.url) };
  return { state, ctx, info };
}

/** What a task implementation may use. One per load. */
export class TaskContext {
  constructor({ registry, modelId, model, choice, files, store, progress, memo, cached, runtime, pins, test, log }) {
    this.registry = registry;
    this.modelId = modelId;
    this.model = model;
    this.device = choice.device;
    this.dtype = choice.dtype;
    this.variant = choice.variant;
    this.files = files;
    this.test = test;
    this.#store = store;
    this.#progress = progress;
    this.#memo = memo;
    this.#cached = cached;
    this.#runtime = runtime;
    this.#pins = pins;
    this.#log = log;
  }
  #store; #progress; #memo; #cached; #runtime; #pins; #log;

  /** Report a status of the run (`running`, `done`). */
  report(status, extra) { this.#progress.status(status, extra); }

  /** Transformers.js, pinned and set up. */
  transformers() {
    if (!this.#runtime?.transformers) throw new AiError('runtime-mismatch', 'this site does not ship Transformers.js');
    return loadTransformers(this.#runtime, { pins: this.#pins });
  }

  /** The Transformers.js pipeline of this model and variant, fed by the store. */
  async pipeline() {
    const tf = await this.transformers();
    const fetch = createStoreFetch({ model: this.model, files: this.files, store: this.#store, memo: this.#memo, progress: this.#progress, cached: this.#cached, log: this.#log });
    this.#progress.status('loading');
    return createPipeline({ tf, model: this.model, choice: { device: this.device, dtype: this.dtype }, fetch });
  }

  /** ONNX Runtime Web, pinned and set up (direct use). */
  ort() {
    return loadOrt(this.#runtime, { pins: this.#pins });
  }

  /**
   * The bytes of one file of the variant, from the store, checked against the registry.
   * @param {string} ref `<part>:<path>`
   * @returns {Promise<ArrayBuffer>}
   */
  async bytes(ref) {
    const f = resolveRef(this.model, ref);
    if (!this.files.some(x => x.url === f.url)) throw new AiError('not-in-registry', `${ref} is not a file of this variant`);
    const blob = await this.#store.get(f.url, { bytes: f.size, onProgress: p => this.#progress.file(f.url, p.loaded) });
    const read = await verifyFile(blob, f, f.url, this.#memo);
    this.#progress.done(f.url, { fromStore: Boolean(this.#cached?.get(f.url)) });
    this.#log?.({ kind: 'file', url: f.url });
    return read || blob.arrayBuffer();
  }

  /** Text of one small file of the variant (UTF-8). */
  async text(ref) {
    return new TextDecoder('utf-8').decode(await this.bytes(ref));
  }

  /**
   * An ONNX Runtime session of one file of the variant, on this load's backend.
   * @param {string} ref
   * @param {{ providers?: string[] }} [opts]
   */
  async session(ref, opts) {
    const [ort, bytes] = await Promise.all([this.ort(), this.bytes(ref)]);
    this.#progress.status('loading');
    return createSession(ort, bytes, this.device, opts);
  }
}
