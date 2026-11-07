// SPDX-License-Identifier: Apache-2.0 AND MIT
// Copyright (c) 2026 UtopiaIA
// Portions Copyright (c) 2026 Miguel Ángel Durán (runonweb.ai, MIT; see LICENSES/MIT-runonweb.txt):
//   the single-thread rule (packages/runonweb/src/core/pipeline.ts:54-58), used here
//   through threadCount().
//
// Transformers.js, set up once per Worker and only ever fed through the model
// store. Two facts of 4.3.1 shape this module:
//  - pipeline() asks for config.json and probes preprocessor_config.json at the
//    branch head even when a revision is given. Every request goes through
//    env.fetch, so storeFetch answers them all from the pinned commit: the page
//    never talks to Hugging Face and a single pin holds.
//  - session creation and runs are queued on two global promise chains that do
//    not recover from a rejection. After any failure the Worker is replaced
//    (worker-host.js); nothing here tries to repair that state.

import { AiError, toAiError } from './errors.js';
import { parseResolveUrl, pinnedUrl, isHubUrl } from './hub-url.js';
import { partOfRepo } from './registry.js';
import { verifyFile } from './integrity.js';
import { threadCount } from './device.js';
import { assertTransformersRuntime } from './runtimes.js';
import { PINS } from './runtime-pins.js';

let loaded = null; // { tf, ort } once per realm

/**
 * Import the pinned ONNX Runtime bundle and the Transformers.js copy that points
 * at it, set Transformers.js up, and check the versions. Once per realm.
 * @param {{ ortBundle: string, ortMjs: string, ortWasm: string, transformers: string }} runtime same-origin URLs
 * @param {{ pins?: typeof PINS }} [opts] `pins` replaces the expected versions (test builds only)
 */
export async function loadTransformers(runtime, { pins = PINS } = {}) {
  if (!loaded) {
    loaded = (async () => {
      const abs = u => new URL(u, globalThis.location?.href).href;
      const ort = await import(abs(runtime.ortBundle));
      const tf = await import(abs(runtime.transformers));
      configureTransformers(tf.env, { ortMjs: abs(runtime.ortMjs), ortWasm: abs(runtime.ortWasm) });
      return { tf, ort };
    })();
    loaded.catch(() => { loaded = null; });
  }
  const { tf, ort } = await loaded;
  assertTransformersRuntime(tf, ort, pins);
  return tf;
}

/**
 * The settings every site uses. Nothing is cached in the site's own storage,
 * no blob: URLs are made for the runtime, and the network path is storeFetch.
 */
export function configureTransformers(env, { ortMjs, ortWasm, fetch = null }) {
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = false;
  env.useCustomCache = false;
  env.useWasmCache = false;
  env.experimental_useCrossOriginStorage = false;
  env.useFSCache = false;
  if (fetch) env.fetch = fetch;
  const wasm = env.backends?.onnx?.wasm;
  if (wasm) {
    wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };
    wasm.numThreads = threadCount();
    wasm.proxy = false;
  }
  return env;
}

const headerOf = (headers, name) => {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return null;
};

/**
 * The only way out for Transformers.js: a fetch that serves Hub URLs of this
 * model from the model store, at the pinned commit.
 *  - same origin: the normal fetch;
 *  - a Hub URL of a repo of this model, at the branch head or at the pinned commit:
 *      · a path the registry does not list for this variant → 404 (what the Hub would say)
 *      · a one-byte probe → a 206 made here with the registry's size
 *      · the whole file → the store, checked, as a 200;
 *  - anything else → not-in-registry.
 * @param {{ model: import('./registry.js').RegistryModel, files: import('./registry.js').ResolvedFile[],
 *   store: { get(url: string, o: { bytes: number, onProgress?: Function }): Promise<Blob> },
 *   memo: ReturnType<import('./integrity.js').createVerifiedMemo>, progress?: ReturnType<import('./progress.js').createProgress>,
 *   cached?: Map<string, boolean>, baseFetch?: typeof fetch, log?: (entry: object) => void }} opts
 */
export function createStoreFetch({ model, files, store, memo, progress, cached, baseFetch = globalThis.fetch?.bind(globalThis), log }) {
  const allowed = new Set(files.map(f => f.url));
  // pinned url → Promise<Blob>: each file comes from the store once per load. A
  // Blob of the store is backed by its storage, so keeping it here costs nothing.
  const got = new Map();
  return async function storeFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    let u;
    try { u = new URL(url, globalThis.location?.href); } catch { throw new AiError('not-in-registry', 'bad URL'); }
    if (globalThis.location && u.origin === globalThis.location.origin) return baseFetch(input, init);
    const parsed = isHubUrl(u.href) ? parseResolveUrl(u.href) : null;
    if (!parsed) throw new AiError('not-in-registry', 'this site only fetches pinned model files', { details: { url: u.origin + u.pathname } });
    const part = partOfRepo(model, parsed.repo);
    if (!part) throw new AiError('not-in-registry', `${parsed.repo} is not a repo of this model`, { details: { repo: parsed.repo } });
    if (parsed.revision !== 'main' && parsed.revision !== part.revision) throw new AiError('not-in-registry', `revision ${parsed.revision} is not the pinned one`, { details: { repo: parsed.repo } });
    const pinned = pinnedUrl(part.repo, part.revision, parsed.path);
    const meta = part.files[parsed.path];
    const isWeight = /\.onnx(_data(_\d+)?)?$/.test(parsed.path);
    if (!meta || (isWeight && !allowed.has(pinned))) {
      log?.({ kind: 'absent', url: pinned });
      return new Response(null, { status: 404, statusText: 'Not Found' });
    }
    const range = headerOf(init.headers, 'range');
    if (range) {
      if (range !== 'bytes=0-0') throw new AiError('not-in-registry', 'only one-byte probes are answered', { details: { range } });
      log?.({ kind: 'probe', url: pinned });
      return new Response(new Uint8Array(1), { status: 206, headers: { 'Content-Range': `bytes 0-0/${meta.size}`, 'Content-Length': '1' } });
    }
    if (!got.has(pinned)) {
      const p = (async () => {
        const file = await store.get(pinned, { bytes: meta.size, onProgress: x => progress?.file(pinned, x.loaded) });
        await verifyFile(file, meta, pinned, memo); // the bytes it may have read are dropped: the runtime reads the Blob
        progress?.done(pinned, { fromStore: Boolean(cached?.get(pinned)) });
        log?.({ kind: 'file', url: pinned });
        return file;
      })();
      p.catch(() => got.delete(pinned));
      got.set(pinned, p);
    }
    const file = await got.get(pinned);
    return new Response(file, { status: 200, headers: { 'Content-Length': String(meta.size) } });
  };
}

/**
 * Create a Transformers.js pipeline for one model and variant, through the store.
 * @param {{ tf: any, model: import('./registry.js').RegistryModel, choice: import('./device.js').DeviceChoice,
 *   fetch: (input: any, init?: any) => Promise<Response> }} opts
 */
export async function createPipeline({ tf, model, choice, fetch }) {
  if (model.runtime !== 'transformers.js' || !model.pipeline) throw new AiError('model-mismatch', 'this model is not a Transformers.js pipeline');
  const main = model.parts.main;
  tf.env.fetch = fetch;
  try {
    return await tf.pipeline(model.pipeline, main.repo, { revision: main.revision, device: choice.device, dtype: choice.dtype });
  } catch (err) {
    throw toAiError(err, 'run-failed');
  }
}
