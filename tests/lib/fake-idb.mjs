// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// A tiny IndexedDB for Node tests of code that keeps a connection open: just
// enough of open / transaction / objectStore / requests, plus the two ways a
// browser takes a connection away from a page:
//   closeAll()        the browser closes every open connection (WebKit does it on
//                     its own: tab asleep, memory pressure, storage evicted).
//                     `onclose` fires and `transaction()` throws InvalidStateError.
//   versionChangeAll() another tab asks for a newer version: `onversionchange` fires.
//   abortNext(n = 1)  the next n transactions are aborted with AbortError before
//                     they commit, and the connection is closed (closed under a
//                     transaction that had already started).
// `writes` counts the write requests that were COMMITTED, so a test can prove a
// write was not applied twice. Data is committed only when a transaction completes.

const later = (fn) => setTimeout(fn, 0);
const domError = (name, message = name) => Object.assign(new Error(message), { name });

export function fakeIndexedDB() {
  const dbs = new Map();               // name -> { version, stores: Map(name -> { keyPath, data: Map }) }
  const live = new Set();              // open connections
  let toAbort = 0;
  const stats = { opens: 0, writes: 0, transactions: 0 };

  function request(tx, op) {
    const r = { result: undefined, error: null, onsuccess: null, onerror: null };
    tx._requests.push(r);
    tx._queue.push(() => {
      if (tx._aborted) return;
      try { r.result = op(); } catch (e) { r.error = e; r.onerror?.({ target: r }); tx._abort(e); return; }
      r.onsuccess?.({ target: r });
    });
    tx._pump();
    return r;
  }

  function connection(name) {
    const meta = dbs.get(name);
    const db = {
      name, version: meta.version, onclose: null, onversionchange: null, _closing: false,
      objectStoreNames: { contains: (n) => meta.stores.has(n) },
      createObjectStore(n, { keyPath } = {}) { meta.stores.set(n, { keyPath, data: new Map() }); return { createIndex() {} }; },
      close() { db._closing = true; live.delete(db); },
      transaction(names, mode = 'readonly') {
        if (db._closing) throw domError('InvalidStateError', "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.");
        const list = Array.isArray(names) ? names : [names];
        for (const n of list) if (!meta.stores.has(n)) throw domError('NotFoundError');
        stats.transactions++;
        const staged = [];             // writes applied on commit
        const view = (n) => {          // committed data + this transaction's staged writes
          const m = new Map(meta.stores.get(n).data);
          for (const w of staged) if (w.n === n) w.apply(m);
          return m;
        };
        const tx = {
          error: null, oncomplete: null, onerror: null, onabort: null,
          _queue: [], _requests: [], _busy: false, _done: false, _aborted: false, _doom: toAbort > 0 ? (toAbort--, true) : false,
          _pump() {
            if (tx._busy || tx._done) return;
            tx._busy = true;
            later(() => {
              tx._busy = false;
              if (tx._done) return;
              if (tx._doom) {           // the browser takes the connection away under this transaction
                const e = domError('AbortError', 'The connection was closed.');
                db.close();
                for (const r of tx._requests) { r.error = e; r.onerror?.({ target: r }); }
                tx._abort(e);
                later(() => db.onclose?.());
                return;
              }
              const step = tx._queue.shift();
              if (step) { step(); tx._pump(); return; }
              tx._done = true;
              for (const w of staged) { w.apply(meta.stores.get(w.n).data); stats.writes++; }
              tx.oncomplete?.({ target: tx });
            });
          },
          _abort(e) {
            if (tx._aborted) return;
            tx._aborted = true; tx._done = true; tx.error = e;
            if (e) tx.onerror?.({ target: tx });
            later(() => tx.onabort?.({ target: tx }));
          },
          abort() { tx._abort(null); },
          objectStore(n) {
            if (!list.includes(n)) throw domError('NotFoundError');
            const { keyPath } = meta.stores.get(n);
            const keyOf = (v, k) => (k !== undefined ? k : v[keyPath]);
            const write = (apply) => { if (mode !== 'readwrite') throw domError('ReadOnlyError'); return request(tx, () => { staged.push({ n, apply }); }); };
            return {
              get: (k) => request(tx, () => structuredClone(view(n).get(k))),
              getAll: () => request(tx, () => [...view(n).values()].map((v) => structuredClone(v))),
              getAllKeys: () => request(tx, () => [...view(n).keys()]),
              put: (v, k) => { const c = structuredClone(v); return write((m) => m.set(keyOf(c, k), c)); },
              delete: (k) => write((m) => m.delete(k)),
              clear: () => write((m) => m.clear()),
            };
          },
        };
        later(() => tx._pump());
        return tx;
      },
    };
    live.add(db);
    return db;
  }

  const idb = {
    stats,
    closeAll() { for (const db of [...live]) { db.close(); db.onclose?.(); } },
    versionChangeAll() { for (const db of [...live]) db.onversionchange?.({ oldVersion: db.version, newVersion: db.version + 1 }); },
    abortNext(n = 1) { toAbort += n; },
    get liveConnections() { return live.size; },
    data(name, store) { return dbs.get(name)?.stores.get(store)?.data; },
    open(name, version) {
      const r = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, transaction: null };
      later(() => {
        stats.opens++;
        let meta = dbs.get(name);
        const fresh = !meta;
        if (fresh) dbs.set(name, meta = { version: 0, stores: new Map() });
        const v = version ?? (fresh ? 1 : meta.version);
        if (v < meta.version) { r.error = domError('VersionError'); r.onerror?.({ target: r }); return; }
        const upgrade = v > meta.version;
        meta.version = v;
        r.result = connection(name);
        if (upgrade) r.onupgradeneeded?.({ target: r });
        r.onsuccess?.({ target: r });
      });
      return r;
    },
  };
  return idb;
}
