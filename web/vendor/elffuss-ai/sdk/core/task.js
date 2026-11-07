// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The base of every task class of the SDK (RemoveBg, Depth, Detect, Ocr):
// options, load once, runs in order, cancel, dispose, and where the model runs.
//
//   const t = new Depth({ device: 'auto', onProgress, signal })
//   const info = await t.load()        // { model, device, dtype, fromStore, … }
//   const out = await t.run(image, { signal })
//   await t.dispose()
//
// With `worker: true` (the default in a browser) the model runs in a module
// Worker that is replaced after any failure; with `worker: false` it runs here,
// and a failure leaves the instance unusable (create another one).

import { AiError, toAiError, throwIfAborted } from './errors.js';
import { createQueue } from './queue.js';
import { createStoreClient, DEFAULT_STORE_URL } from './store-client.js';
import { createWorkerHost } from './worker-host.js';
import { loadTask } from './task-runtime.js';
import { runResult } from './worker-rpc.js';
import { loadRegistry, getModel, defaultModelId } from './registry.js';
import { ortVariantFor } from './device.js';
import { runtimeUrls } from './runtimes.js';
import { toTransferable } from './image-input.js';

/**
 * @typedef {{ device?: 'auto'|'webgpu'|'wasm', model?: string, onProgress?: (p: import('./progress.js').ProgressEvent) => void,
 *   signal?: AbortSignal, worker?: boolean, store?: import('./store-client.js').StoreClient, storeUrl?: string,
 *   runtime?: ReturnType<typeof runtimeUrls>, registryUrl?: string, registry?: import('./registry.js').Registry, onCspViolation?: (v: object) => void,
 *   test?: import('./task-runtime.js').TestFlags | null }} TaskOptions
 *   `store` is any object with has(url, bytes) and get(url, { bytes, signal, onProgress }); by default the
 *   Elffuss model store. `runtime` are the same-origin URLs of the runtimes (the site's build writes them).
 * @typedef {{ task: string, workerUrl: URL, impl: () => Promise<any>, prepare?: (input: any) => Promise<{ value: any, transfer: Transferable[] }> }} TaskSpec
 */

const anySignal = signals => {
  const list = signals.filter(Boolean);
  if (list.length <= 1) return list[0];
  if (AbortSignal.any) return AbortSignal.any(list);
  const ac = new AbortController();
  for (const s of list) s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
  return ac.signal;
};

/**
 * Base class of the task modules: one model, loaded once, runs one after another.
 * A task module passes its spec (task name, Worker URL, implementation) and the
 * caller's options.
 */
export class Task {
  #spec; #opts; #store; #ownStore = false; #host = null; #impl = null; #local = null;
  #loading = null; #info = null; #queue = createQueue(); #disposed = false; #broken = null; #failRunUsed = false; #failLoadUsed = false;

  /**
   * @param {TaskSpec} spec
   * @param {TaskOptions} [options]
   */
  constructor(spec, options = {}) {
    this.#spec = spec;
    this.#opts = { device: 'auto', worker: typeof Worker !== 'undefined' && typeof document !== 'undefined', ...options };
  }

  /** Backend used, after load(). */
  get device() { return this.#info?.device ?? null; }
  /** Variant dtype used, after load(). */
  get dtype() { return this.#info?.dtype ?? null; }
  /** Everything load() returned, or null. */
  get info() { return this.#info; }

  #storeClient() {
    if (this.#store) return this.#store;
    if (this.#opts.store) return (this.#store = this.#opts.store);
    this.#ownStore = true;
    return (this.#store = createStoreClient({ url: this.#opts.storeUrl || DEFAULT_STORE_URL }));
  }

  async #runtime(registry, modelId) {
    if (this.#opts.runtime) return this.#opts.runtime;
    return runtimeUrls({ variant: ortVariantFor([getModel(registry, modelId)]) });
  }

  /**
   * Download (through the store) and prepare the model. Idempotent; concurrent
   * calls share one load.
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<import('./task-runtime.js').LoadInfo>}
   */
  load({ signal } = {}) {
    if (this.#disposed) return Promise.reject(new AiError('disposed', 'this task was disposed'));
    if (this.#broken) return Promise.reject(this.#broken);
    if (this.#info) return Promise.resolve(this.#info);
    if (this.#loading) return this.#loading;
    const sig = anySignal([this.#opts.signal, signal]);
    this.#loading = (async () => {
      throwIfAborted(sig);
      const registry = this.#opts.registry || await loadRegistry(this.#opts.registryUrl);
      const modelId = this.#opts.model || defaultModelId(registry, this.#spec.task);
      let test = this.#opts.test || null;
      if (test) { test = { ...test, failLoad: Boolean(test.failLoad) && !this.#failLoadUsed }; if (this.#opts.test.failLoad) this.#failLoadUsed = true; }
      const opts = { model: modelId, device: this.#opts.device, registryUrl: this.#opts.registryUrl, registry: this.#opts.registry, runtime: await this.#runtime(registry, modelId), test };
      const onProgress = this.#opts.onProgress;
      if (this.#opts.worker) {
        if (!this.#host) this.#host = createWorkerHost({ workerUrl: this.#spec.workerUrl, store: this.#storeClient(), onCspViolation: this.#opts.onCspViolation });
        this.#info = await this.#host.load(opts, { signal: sig, onProgress });
      } else {
        this.#impl ||= await this.#spec.impl();
        const store = this.#storeClient();
        const abortable = { has: (u, b) => store.has(u, b), get: (u, o) => store.get(u, sig ? { ...o, signal: sig } : o) };
        try {
          this.#local = await loadTask(this.#impl, { ...opts, registry }, { store: abortable, onProgress });
        } catch (err) {
          const e = toAiError(err);
          if (e.code !== 'aborted' && e.code !== 'store-unavailable') this.#broken = new AiError('run-failed', 'this task failed to load; create a new one', { cause: e });
          throw e;
        }
        this.#info = this.#local.info;
      }
      return this.#info;
    })().finally(() => { this.#loading = null; });
    return this.#loading;
  }

  /**
   * Run the task once. Loads first if needed; runs of one instance go one after another.
   * @param {any} input
   * @param {{ signal?: AbortSignal } & Record<string, any>} [opts] task options
   */
  run(input, { signal, ...opts } = {}) {
    if (this.#disposed) return Promise.reject(new AiError('disposed', 'this task was disposed'));
    const sig = anySignal([this.#opts.signal, signal]);
    return this.#queue.run(async () => {
      if (this.#broken) throw this.#broken;
      throwIfAborted(sig);
      await this.load({ signal: sig });
      const prepared = await (this.#spec.prepare || toTransferable)(input);
      // Test builds: `failRun` breaks the first run only, inside the runtime; later runs must work.
      let runOpts = opts;
      if (this.#opts.test) {
        runOpts = { ...opts, test: { ...this.#opts.test, failRun: Boolean(this.#opts.test.failRun) && !this.#failRunUsed } };
        if (this.#opts.test.failRun) this.#failRunUsed = true;
      }
      if (this.#opts.worker) {
        try {
          return await this.#host.run(prepared.value, runOpts, { transfer: prepared.transfer, signal: sig, onProgress: this.#opts.onProgress });
        } catch (err) {
          // The Worker is gone after a failure of the runtime: the next run loads
          // again (from the store). After an input refused, it is still there.
          if (!this.#host?.alive) this.#info = null;
          throw toAiError(err);
        }
      }
      const exec = (async () => runResult(await this.#impl.run(this.#local.state, prepared.value, runOpts, this.#local.ctx)).value)();
      if (!sig) {
        try { return await exec; } catch (err) { this.#broken = new AiError('run-failed', 'this task failed; create a new one', { cause: err }); throw toAiError(err); }
      }
      // Without a Worker a run cannot be stopped: it finishes and its result is dropped.
      return await new Promise((resolve, reject) => {
        const onAbort = () => reject(new AiError('aborted', 'cancelled'));
        sig.addEventListener('abort', onAbort, { once: true });
        exec.then(resolve, err => { this.#broken = new AiError('run-failed', 'this task failed; create a new one', { cause: err }); reject(toAiError(err)); })
          .finally(() => sig.removeEventListener('abort', onAbort));
      });
    });
  }

  /** Release the model and the Worker. Idempotent; waits for a run in progress. */
  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#queue.idle();
    try { await this.#loading; } catch { /* the load failed: nothing to release */ }
    if (this.#host) await this.#host.dispose();
    if (this.#local) { try { await this.#impl.dispose?.(this.#local.state); } catch { /* releasing */ } }
    if (this.#ownStore) this.#store?.dispose?.();
    this.#host = null; this.#local = null; this.#info = null;
  }
}

/**
 * Make the one-call form of a task class: load, run, dispose.
 * @template T
 * @param {new (o?: TaskOptions) => Task} TaskClass
 * @returns {(input: any, options?: TaskOptions & Record<string, any>) => Promise<T>}
 */
export function oneShot(TaskClass) {
  return async (input, options = {}) => {
    const ctor = {}, run = {};
    for (const [k, v] of Object.entries(options)) (TASK_OPTIONS.includes(k) ? ctor : run)[k] = v;
    const t = new TaskClass(ctor);
    try { return await t.run(input, run); } finally { await t.dispose(); }
  };
}

/** Options that belong to the task instance; the rest go to run(). */
export const TASK_OPTIONS = Object.freeze(['device', 'model', 'onProgress', 'signal', 'worker', 'store', 'storeUrl', 'runtime', 'registryUrl', 'registry', 'onCspViolation', 'test']);
