// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Client of the shared model store of the Elffuss sites: a hidden iframe of
// https://models.elffuss.com/ that keeps model files in its own origin's storage
// and downloads what it does not have from the pinned Hugging Face URL. The page
// never talks to Hugging Face itself, so its CSP keeps connect-src 'self'.
//
// The tools only ask three things: whether a file is there (`has`), the file
// (`get`, always with its exact size) and to stop a download (`cancel`). They
// never empty the store, never save copies into it and never list it.
//
// Needs a document (the iframe); a Worker reaches it through store-bridge.js.

import { AiError, fromStoreError } from './errors.js';

/** The model store of the Elffuss sites. */
export const DEFAULT_STORE_URL = 'https://models.elffuss.com/';

const MSG = Object.freeze({ get: 'elffuss-model-get', has: 'elffuss-model-has', cancel: 'elffuss-model-cancel', ready: 'elffuss-broker-ready' });

/**
 * @typedef {{ loaded: number, total: number, resumedFrom?: number, retry?: number, waiting?: boolean }} StoreProgress
 * @typedef {{ readonly origin: string, ready(): Promise<{ version: number, can: string[] }>,
 *   has(url: string, bytes: number): Promise<boolean>,
 *   get(url: string, opts: { bytes: number, signal?: AbortSignal, onProgress?: (p: StoreProgress) => void }): Promise<Blob>,
 *   cancel(url: string): void, pending(): string[], dispose(): void }} StoreClient
 */

/**
 * Open the model store.
 * @param {{ url?: string, document?: Document, readyTimeout?: number, answerTimeout?: number, idleTimeout?: number }} [opts]
 * @returns {StoreClient}
 */
export function createStoreClient({ url = DEFAULT_STORE_URL, document: doc = globalThis.document, readyTimeout = 15000, answerTimeout = 15000, idleTimeout = 90000 } = {}) {
  const origin = new URL(url).origin;
  let iframe = null;
  let readyPromise = null;
  let seq = 0;
  const waiting = new Map(); // id → { onMessage }
  const inflight = new Map(); // url → count of gets

  const listener = e => {
    if (!iframe || e.source !== iframe.contentWindow || e.origin !== origin) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d.id == null) return;
    waiting.get(d.id)?.onMessage(d);
  };

  /**
   * Open the store once. A store that does not open is not remembered: its frame
   * is removed and the next question opens a new one, so a store that was down
   * when the page loaded works as soon as it is back, without a reload.
   */
  function ready() {
    if (readyPromise) return readyPromise;
    if (!doc?.createElement) return Promise.reject(new AiError('store-unavailable', 'the model store needs a document'));
    const frame = doc.createElement('iframe');
    iframe = frame;
    const p = new Promise((resolve, reject) => {
      frame.hidden = true;
      frame.setAttribute('aria-hidden', 'true');
      frame.setAttribute('tabindex', '-1');
      frame.referrerPolicy = 'no-referrer';
      const fail = err => { cleanup(); forget(frame); reject(err); };
      const timer = setTimeout(() => fail(new AiError('store-unavailable', 'the model store did not open', { details: { origin } })), readyTimeout);
      const onReady = e => {
        if (e.source !== frame.contentWindow || e.origin !== origin || e.data?.kind !== MSG.ready) return;
        const can = Array.isArray(e.data.puede) ? e.data.puede : [];
        if (!can.includes('get') || !can.includes('has')) { fail(new AiError('store-unavailable', 'the model store does not offer get and has')); return; }
        cleanup();
        globalThis.addEventListener('message', listener);
        resolve({ version: e.data.v, can });
      };
      const cleanup = () => { clearTimeout(timer); globalThis.removeEventListener('message', onReady); };
      globalThis.addEventListener('message', onReady);
      frame.src = url;
      (doc.body || doc.documentElement).appendChild(frame);
    });
    readyPromise = p;
    p.catch(() => {});
    return p;
  }

  /** Drop a frame that never became ready, so that the next call starts again. */
  function forget(frame) {
    try { frame.remove(); } catch { /* gone */ }
    if (iframe === frame) { iframe = null; readyPromise = null; }
  }

  /** Send one request and wait for its answer. `onId` learns the request id. */
  function request(type, payload, { onMessage, timeout, idle, onId }) {
    const id = ++seq;
    onId?.(id);
    return new Promise((resolve, reject) => {
      let timer;
      const arm = ms => { clearTimeout(timer); timer = setTimeout(() => { finish(); reject(new AiError(type === MSG.get ? 'store-network' : 'store-unavailable', 'the model store stopped answering', { details: { type } })); }, ms); };
      const finish = () => { clearTimeout(timer); waiting.delete(id); };
      waiting.set(id, {
        onMessage: d => {
          arm(idle || timeout);
          const r = onMessage(d);
          if (r === undefined) return;
          finish();
          if (r instanceof Error) reject(r); else resolve(r.value);
        },
        abort: err => { finish(); reject(err); },
      });
      arm(timeout);
      try { iframe.contentWindow.postMessage({ type, id, ...payload }, origin); }
      catch (err) { finish(); reject(new AiError('store-unavailable', 'could not reach the model store', { cause: err })); }
    });
  }

  async function has(fileUrl, bytes) {
    await ready();
    return request(MSG.has, { url: fileUrl, bytes }, {
      timeout: answerTimeout,
      onMessage: d => {
        if (d.kind === 'has') return { value: Boolean(d.cached) && (!bytes || d.size === bytes) };
        if (d.kind === 'error') return fromStoreError(d, { url: fileUrl });
        return undefined;
      },
    });
  }

  async function get(fileUrl, { bytes, signal, onProgress } = {}) {
    if (!(Number.isInteger(bytes) && bytes > 0)) throw new AiError('not-in-registry', 'a file is only asked for with its exact size', { details: { url: fileUrl } });
    if (signal?.aborted) throw new AiError('aborted', 'cancelled');
    await ready();
    inflight.set(fileUrl, (inflight.get(fileUrl) || 0) + 1);
    let reqId = null;
    const onAbort = () => {
      cancel(fileUrl);
      const w = reqId != null && waiting.get(reqId);
      if (w) w.abort(new AiError('aborted', 'cancelled', { details: { url: fileUrl } }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await request(MSG.get, { url: fileUrl, bytes }, {
        timeout: answerTimeout,
        idle: idleTimeout,
        onId: id => { reqId = id; },
        onMessage: d => {
          if (d.kind === 'progress') {
            try { onProgress?.({ loaded: d.loaded || 0, total: d.total || bytes, resumedFrom: d.reanudadoDesde, retry: d.reintento, waiting: d.esperandoTurno }); } catch { /* listener */ }
            return undefined;
          }
          if (d.kind === 'file') {
            if (!(d.file instanceof Blob)) return new AiError('store-network', 'the model store answered without a file');
            if (d.file.size !== bytes) return new AiError('integrity', `the stored file has ${d.file.size} bytes, the registry says ${bytes}`, { details: { url: fileUrl } });
            return { value: d.file };
          }
          if (d.kind === 'error') return fromStoreError(d, { url: fileUrl });
          return undefined;
        },
      });
    } finally {
      signal?.removeEventListener('abort', onAbort);
      const n = (inflight.get(fileUrl) || 1) - 1;
      if (n) inflight.set(fileUrl, n); else inflight.delete(fileUrl);
    }
  }

  function cancel(fileUrl) {
    if (!iframe?.contentWindow) return;
    try { iframe.contentWindow.postMessage({ type: MSG.cancel, id: ++seq, url: fileUrl }, origin); } catch { /* gone */ }
  }

  function dispose() {
    for (const u of inflight.keys()) cancel(u);
    for (const w of waiting.values()) w.abort?.(new AiError('aborted', 'store closed'));
    waiting.clear();
    globalThis.removeEventListener('message', listener);
    iframe?.remove();
    iframe = null;
    readyPromise = null;
  }

  return { origin, ready, has, get, cancel, pending: () => [...inflight.keys()], dispose };
}
