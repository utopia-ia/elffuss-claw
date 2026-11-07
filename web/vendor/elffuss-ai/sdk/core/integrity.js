// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The model store checks a file's size; this checks its content, the same two
// ways the store's `put` does: SHA-256 for LFS files and the git blob SHA-1 for
// the small ones, both pinned in the registry. Once a file passes in a browser,
// a note in this site's IndexedDB (`verified:<pinned url>:<size>`) saves the
// next check; with the note gone, it is checked again.

import { AiError } from './errors.js';

const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');

/** SHA-256 of bytes, as hex. */
export async function sha256Hex(bytes) {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

/** git blob SHA-1 of bytes (`blob <size>\0` + bytes), as hex. */
export async function gitBlobSha1(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const head = new TextEncoder().encode(`blob ${data.byteLength}\0`);
  const all = new Uint8Array(head.byteLength + data.byteLength);
  all.set(head);
  all.set(data, head.byteLength);
  return hex(await crypto.subtle.digest('SHA-1', all));
}

/**
 * A memo of verified files. IndexedDB when there is one, else memory.
 * @returns {{ has(key: string): Promise<boolean>, set(key: string): Promise<void> }}
 */
export function createVerifiedMemo({ dbName = 'elffuss-ai', indexedDB: idb = globalThis.indexedDB } = {}) {
  const mem = new Set();
  if (!idb) return { has: async k => mem.has(k), set: async k => { mem.add(k); } };
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((resolve, reject) => {
    const r = idb.open(dbName, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('verified');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }).catch(() => null));
  const tx = async (mode, fn) => {
    const d = await db();
    if (!d) return null;
    return new Promise(resolve => {
      try {
        const t = d.transaction('verified', mode);
        const req = fn(t.objectStore('verified'));
        t.oncomplete = () => resolve(req?.result ?? null);
        t.onerror = t.onabort = () => resolve(null);
      } catch { resolve(null); }
    });
  };
  return {
    async has(k) { if (mem.has(k)) return true; const v = await tx('readonly', s => s.get(k)); if (v) mem.add(k); return Boolean(v); },
    async set(k) { mem.add(k); await tx('readwrite', s => s.put(1, k)); },
  };
}

/**
 * Check one file against its registry entry.
 * Returns the bytes when it had to read them (so the caller does not read twice),
 * or null when a previous check in this browser already covers it.
 * @param {Blob} blob
 * @param {{ size: number, sha256?: string, gitOid?: string }} meta
 * @param {string} url the pinned URL (part of the memo key)
 * @param {ReturnType<typeof createVerifiedMemo>} memo
 * @returns {Promise<ArrayBuffer | null>}
 */
export async function verifyFile(blob, meta, url, memo) {
  if (blob.size !== meta.size) throw new AiError('integrity', `the file has ${blob.size} bytes, the registry says ${meta.size}`, { details: { url } });
  const key = `verified:${url}:${meta.size}`;
  if (await memo.has(key)) return null;
  const bytes = await blob.arrayBuffer();
  let ok;
  if (meta.sha256) ok = (await sha256Hex(bytes)) === meta.sha256;
  else if (meta.gitOid) ok = (await gitBlobSha1(bytes)) === meta.gitOid;
  else throw new AiError('integrity', 'the registry has no hash for this file', { details: { url } });
  if (!ok) throw new AiError('integrity', 'the downloaded file is not the pinned one', { details: { url } });
  await memo.set(key);
  return bytes;
}
