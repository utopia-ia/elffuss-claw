// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Progress of a load, in bytes, computed from the registry's sizes and the model
// store's progress messages (never from the runtime's own callbacks, which would
// trigger extra metadata requests).
//
// Every event is { status, loaded?, total?, file?, fromStore? } with status one of
// checking · downloading · loading · ready · running · done.

/** The statuses a progress event can carry, in the order they happen. */
export const STATUSES = Object.freeze(['checking', 'downloading', 'loading', 'ready', 'running', 'done']);

/**
 * @typedef {{ status: 'checking'|'downloading'|'loading'|'ready'|'running'|'done', loaded?: number, total?: number, file?: string, fromStore?: boolean }} ProgressEvent
 */

/**
 * Track the download of a known set of files.
 * @param {{ files: { url: string, size: number }[], onProgress?: (p: ProgressEvent) => void, throttle?: number, now?: () => number }} opts
 */
export function createProgress({ files, onProgress, throttle = 100, now = () => Date.now() }) {
  const sizes = new Map(files.map(f => [f.url, f.size]));
  const total = files.reduce((s, f) => s + f.size, 0);
  const loaded = new Map();
  const stored = new Map();
  let last = 0;
  const sum = () => [...loaded.values()].reduce((s, v) => s + v, 0);
  const emit = (p, force) => {
    if (!onProgress) return;
    const t = now();
    if (!force && t - last < throttle) return;
    last = t;
    try { onProgress(p); } catch { /* a listener's error is not the load's */ }
  };
  return {
    total,
    /** Emit a status change (always delivered). */
    status(status, extra = {}) {
      emit({ status, loaded: sum(), total, ...extra }, true);
    },
    /** Bytes received so far for one file (from the store's progress messages). */
    file(url, bytes) {
      if (!sizes.has(url)) return;
      loaded.set(url, Math.min(sizes.get(url), Math.max(0, bytes || 0)));
      emit({ status: 'downloading', loaded: sum(), total, file: url });
    },
    /** A file is complete. `fromStore` when the store already had it. */
    done(url, { fromStore = false } = {}) {
      if (!sizes.has(url)) return;
      loaded.set(url, sizes.get(url));
      stored.set(url, fromStore);
      emit({ status: 'downloading', loaded: sum(), total, file: url, fromStore }, sum() === total);
    },
    /** True when every file came from the store without a download. */
    get fromStore() {
      return files.length > 0 && files.every(f => stored.get(f.url) === true);
    },
    get loaded() { return sum(); },
  };
}

/** Bytes still to download for a set of files, given which ones the store has. */
export function missingBytes(files, has) {
  return files.reduce((s, f) => s + (has.get(f.url) ? 0 : f.size), 0);
}
