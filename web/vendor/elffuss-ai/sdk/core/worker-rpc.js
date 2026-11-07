// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The Worker side of a task. sdk/<task>/worker.js is two lines:
//
//   import { serveTask } from '../core/worker-rpc.js';
//   import * as impl from './impl.js';
//   serveTask(impl);
//
// Messages, page → Worker: { type: 'load', id, opts } · { type: 'run', id, input, opts } · { type: 'dispose', id }
// Worker → page: { type: 'ready' } once · { type: 'progress', id, progress } · { type: 'result', id, value }
//   · { type: 'error', id, error } · { type: 'csp-violation', violation } · and the store requests of store-bridge.js.
// After an error the page replaces this Worker (see worker-host.js), so nothing
// here tries to recover a runtime that failed.

import { createWorkerStore } from './store-bridge.js';
import { loadTask } from './task-runtime.js';
import { createQueue } from './queue.js';
import { AiError, serializeError, toAiError } from './errors.js';

/** Normalise what impl.run returns: always `{ value, transfer }`. */
export function runResult(out) {
  if (!out || typeof out !== 'object' || !('value' in out)) throw new AiError('run-failed', 'a task run must return { value, transfer? }');
  return { value: out.value, transfer: Array.isArray(out.transfer) ? out.transfer : [] };
}

/**
 * Serve one task implementation from this Worker.
 * @param {{ task: string, load: Function, run: Function, dispose?: Function }} impl
 * @param {{ port?: any }} [opts]
 */
export function serveTask(impl, { port = globalThis } = {}) {
  const store = createWorkerStore(port);
  const queue = createQueue();
  let loaded = null;
  // Progress goes to the call in progress: the load's statuses to the load, and
  // what ctx.report() says during a run to that run (the page has forgotten
  // the load's call by then).
  let current = null;
  const post = (m, transfer) => port.postMessage(m, transfer || []);
  const onProgress = p => { if (current != null) post({ type: 'progress', id: current, progress: p }); };
  globalThis.addEventListener?.('securitypolicyviolation', e => post({
    type: 'csp-violation',
    violation: { directive: e.effectiveDirective || e.violatedDirective || '', blocked: String(e.blockedURI || ''), sample: String(e.sample || '').slice(0, 80), where: 'worker' },
  }));
  port.addEventListener('message', async e => {
    const d = e.data;
    if (!d || typeof d.type !== 'string') return;
    if (d.type === 'load') {
      try {
        if (!loaded) {
          current = d.id;
          try { loaded = await loadTask(impl, d.opts || {}, { store, onProgress }); } finally { if (current === d.id) current = null; }
        }
        post({ type: 'result', id: d.id, value: loaded.info });
      } catch (err) {
        post({ type: 'error', id: d.id, error: serializeError(toAiError(err)) });
      }
      return;
    }
    if (d.type === 'run') {
      try {
        if (!loaded) throw new AiError('run-failed', 'the task is not loaded');
        const out = await queue.run(async () => {
          current = d.id;
          try { return await impl.run(loaded.state, d.input, d.opts || {}, loaded.ctx); } finally { if (current === d.id) current = null; }
        });
        const { value, transfer } = runResult(out);
        post({ type: 'result', id: d.id, value }, transfer);
      } catch (err) {
        post({ type: 'error', id: d.id, error: serializeError(toAiError(err)) });
      }
      return;
    }
    if (d.type === 'dispose') {
      try { await queue.idle(); if (loaded) await impl.dispose?.(loaded.state); } catch { /* releasing */ }
      loaded = null;
      post({ type: 'result', id: d.id, value: true });
    }
  });
  post({ type: 'ready' });
}
