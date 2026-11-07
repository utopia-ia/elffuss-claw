// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The page side of a task Worker. It creates the Worker through the Trusted
// Types policy, answers its store requests with the page's store client, and
// replaces it after any failure of the runtime: Transformers.js 4.3.1 keeps
// session creation and runs on global promise chains that stay broken after one
// rejection, so a Worker whose runtime failed is never reused. The files come
// back from the store, so a new Worker does not download anything again. A run
// refused for its input (a file that is not an image, or that cannot be decoded)
// never reached the runtime, so that Worker and its model are kept.
//
// Cancelling a call cancels the downloads it started (elffuss-model-cancel) and
// terminates the Worker, because ONNX Runtime cannot stop a run halfway.

import { AiError, INPUT_ERROR_CODES, deserializeError, toAiError } from './errors.js';
import { serveStore } from './store-bridge.js';
import { scriptUrl } from './tt.js';

/**
 * @param {{ workerUrl: string|URL, store: import('./store-client.js').StoreClient,
 *   onCspViolation?: (v: object) => void, readyTimeout?: number, name?: string }} opts
 */
export function createWorkerHost({ workerUrl, store, onCspViolation, readyTimeout = 30000, name = 'elffuss-ai-task' }) {
  let worker = null;
  let bridge = null;
  let readyP = null;
  let seq = 0;
  let generation = 0;
  const calls = new Map(); // id → { resolve, reject, onProgress }

  function failAll(err) {
    for (const c of calls.values()) c.reject(err);
    calls.clear();
  }

  function kill(reason = 'replaced') {
    bridge?.detach();
    bridge = null;
    if (worker) { try { worker.terminate(); } catch { /* gone */ } }
    worker = null;
    readyP = null;
    failAll(new AiError(reason === 'aborted' ? 'aborted' : 'run-failed', `the task worker was ${reason}`));
  }

  function spawn() {
    generation++;
    const w = new Worker(scriptUrl(workerUrl), { type: 'module', name });
    worker = w;
    bridge = serveStore(w, store);
    readyP = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new AiError('run-failed', 'the task worker did not start')), readyTimeout);
      const onReady = e => { if (e.data?.type === 'ready') { clearTimeout(timer); w.removeEventListener('message', onReady); resolve(); } };
      w.addEventListener('message', onReady);
      w.addEventListener('error', e => { clearTimeout(timer); e.preventDefault?.(); reject(new AiError('run-failed', 'the task worker failed to start: ' + (e.message || 'error'))); }, { once: true });
    });
    readyP.catch(() => {});
    w.addEventListener('message', e => {
      const d = e.data;
      if (!d) return;
      if (d.type === 'csp-violation') { try { onCspViolation?.(d.violation); } catch { /* listener */ } return; }
      const c = calls.get(d.id);
      if (!c) return;
      if (d.type === 'progress') { try { c.onProgress?.(d.progress); } catch { /* listener */ } return; }
      if (d.type === 'result') { calls.delete(d.id); c.resolve(d.value); return; }
      if (d.type === 'error') { calls.delete(d.id); c.reject(deserializeError(d.error)); }
    });
    w.addEventListener('error', e => { e.preventDefault?.(); if (worker === w) kill('lost'); });
    w.addEventListener('messageerror', () => { if (worker === w) kill('lost'); });
  }

  /**
   * One call to the Worker. Any failure replaces the Worker, except a run refused
   * for its input.
   * @param {'load'|'run'|'dispose'} type
   * @param {object} payload
   * @param {{ transfer?: Transferable[], signal?: AbortSignal, onProgress?: Function }} [opts]
   */
  async function call(type, payload, { transfer = [], signal, onProgress } = {}) {
    if (signal?.aborted) throw new AiError('aborted', 'cancelled');
    if (!worker) spawn();
    const w = worker;
    await readyP;
    const id = ++seq;
    let onAbort;
    try {
      return await new Promise((resolve, reject) => {
        calls.set(id, { resolve, reject, onProgress });
        onAbort = () => { bridge?.cancelAll(); calls.delete(id); reject(new AiError('aborted', 'cancelled')); kill('aborted'); };
        signal?.addEventListener('abort', onAbort, { once: true });
        try { w.postMessage({ type, id, ...payload }, transfer); }
        catch (err) { calls.delete(id); reject(toAiError(err)); }
      });
    } catch (err) {
      const inputOnly = type === 'run' && INPUT_ERROR_CODES.includes(err?.code) && !err?.details?.runtime;
      if (type !== 'dispose' && worker === w && !inputOnly) kill('replaced');
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    load: (opts, o) => call('load', { opts }, o),
    run: (input, opts, o) => call('run', { input, opts }, o),
    async dispose() {
      if (!worker) return;
      try { await call('dispose', {}); } catch { /* terminating anyway */ }
      kill('disposed');
    },
    kill,
    /** True while a Worker exists. */
    get alive() { return Boolean(worker); },
    /** How many Workers this host has started (a new one after each failure). */
    get generation() { return generation; },
  };
}
