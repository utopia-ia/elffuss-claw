// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The model store needs a document (its iframe), and the models run in a
// Worker. The page owns the store client; the Worker asks it for files through
// these messages, and gets the File back by reference (structured clone of a
// Blob does not copy its bytes).
//
//   Worker → page   { type: 'store-has', id, url, bytes }
//                   { type: 'store-get', id, url, bytes }
//   page → Worker   { type: 'store-progress', id, loaded, total }
//                   { type: 'store-reply', id, ok: true, value }   (boolean for has, Blob for get)
//                   { type: 'store-reply', id, ok: false, error }  (serialised AiError)

import { serializeError, deserializeError, AiError } from './errors.js';

/**
 * The store as seen from inside a Worker.
 * @param {{ postMessage(m: any): void, addEventListener(t: string, f: (e: MessageEvent) => void): void }} [port] defaults to the Worker scope
 * @returns {{ has(url: string, bytes: number): Promise<boolean>, get(url: string, opts: { bytes: number, onProgress?: Function }): Promise<Blob> }}
 */
export function createWorkerStore(port = globalThis) {
  let seq = 0;
  const pending = new Map();
  port.addEventListener('message', e => {
    const d = e.data;
    if (!d || (d.type !== 'store-reply' && d.type !== 'store-progress')) return;
    const p = pending.get(d.id);
    if (!p) return;
    if (d.type === 'store-progress') { try { p.onProgress?.({ loaded: d.loaded, total: d.total }); } catch { /* listener */ } return; }
    pending.delete(d.id);
    if (d.ok) p.resolve(d.value); else p.reject(deserializeError(d.error));
  });
  const ask = (type, url, bytes, onProgress) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, onProgress });
    port.postMessage({ type, id, url, bytes });
  });
  return {
    has: (url, bytes) => ask('store-has', url, bytes),
    get: (url, { bytes, onProgress } = {}) => ask('store-get', url, bytes, onProgress),
  };
}

/**
 * Answer a Worker's store requests with a store client of the page.
 * @param {Worker} worker
 * @param {import('./store-client.js').StoreClient} store
 * @param {{ signal?: AbortSignal }} [opts] aborting cancels every download this Worker asked for
 * @returns {{ inflight(): string[], cancelAll(): void, detach(): void }}
 */
export function serveStore(worker, store, { signal } = {}) {
  const controllers = new Map(); // id → { ac, url }
  const onMessage = async e => {
    const d = e.data;
    if (!d || (d.type !== 'store-has' && d.type !== 'store-get')) return;
    const reply = msg => { try { worker.postMessage({ type: 'store-reply', id: d.id, ...msg }); } catch { /* terminated */ } };
    if (typeof d.url !== 'string') { reply({ ok: false, error: serializeError(new AiError('not-in-registry', 'bad store request')) }); return; }
    try {
      if (d.type === 'store-has') { reply({ ok: true, value: await store.has(d.url, d.bytes) }); return; }
      const ac = new AbortController();
      controllers.set(d.id, { ac, url: d.url });
      const file = await store.get(d.url, {
        bytes: d.bytes,
        signal: ac.signal,
        onProgress: p => { try { worker.postMessage({ type: 'store-progress', id: d.id, loaded: p.loaded, total: p.total }); } catch { /* terminated */ } },
      });
      reply({ ok: true, value: file });
    } catch (err) {
      reply({ ok: false, error: serializeError(err) });
    } finally {
      controllers.delete(d.id);
    }
  };
  worker.addEventListener('message', onMessage);
  const cancelAll = () => { for (const { ac } of controllers.values()) ac.abort(); controllers.clear(); };
  signal?.addEventListener('abort', cancelAll, { once: true });
  return {
    inflight: () => [...controllers.values()].map(c => c.url),
    cancelAll,
    detach() { cancelAll(); worker.removeEventListener('message', onMessage); signal?.removeEventListener('abort', cancelAll); },
  };
}
