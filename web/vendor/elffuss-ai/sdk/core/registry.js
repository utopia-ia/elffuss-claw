// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Reading registry/tasks.json: which model a task uses, which files a variant
// needs, their pinned URLs, sizes and hashes. Pure functions over the parsed
// JSON, plus one loader for the browser.

import { AiError } from './errors.js';
import { pinnedUrl } from './hub-url.js';

/**
 * @typedef {{ size: number, sha256?: string, gitOid?: string }} RegistryFileMeta
 * @typedef {{ repo: string, revision: string, license: string, author: string, files: Record<string, RegistryFileMeta> }} RegistryPart
 * @typedef {{ when?: 'shader-f16', dtype: string, files: string[], lazy?: string[], bytes: number }} RegistryVariant
 *   `lazy`: files of `files` read only when a feature needs them (SANA's image encoder, for a
 *   picture from a picture): the store may serve them, but `bytes` and the first download leave them out.
 * @typedef {{ name: string, author: string, url: string, license: string, part?: string }} RegistryBase
 * @typedef {{ task: string, name: { es: string, en: string }, license: string, author: string,
 *   base: RegistryBase, bases?: RegistryBase[], flag: string|null, redistributes: boolean,
 *   runtime: 'transformers.js'|'onnxruntime-web', pipeline: string|null, parts: Record<string, RegistryPart>,
 *   devices: { webgpu?: RegistryVariant[], wasm?: RegistryVariant[] }, notes: { es: string|null, en: string|null } }} RegistryModel
 *   `bases` is there when a model joins the work of several authors (one per part it names); `base` is then the first.
 * @typedef {{ schema: 1, tasks: Record<string, { default: string, module?: string }>, models: Record<string, RegistryModel> }} Registry
 *   A task's `module` is the directory of its module under sdk/ (the task's own name when absent).
 * @typedef {{ ref: string, part: string, path: string, url: string, size: number, sha256?: string, gitOid?: string, lazy?: boolean }} ResolvedFile
 */

const loaded = new Map();

/**
 * Fetch and parse tasks.json (once per URL). By default, the copy that ships
 * next to the SDK in the same build.
 * @param {string|URL} [url]
 * @returns {Promise<Registry>}
 */
export function loadRegistry(url = new URL('../../registry/tasks.json', import.meta.url)) {
  const key = String(url);
  if (!loaded.has(key)) {
    const p = fetch(key, { credentials: 'same-origin' }).then(r => {
      if (!r.ok) throw new AiError('not-in-registry', `registry not found (HTTP ${r.status})`);
      return r.json();
    }).then(validateShape);
    p.catch(() => loaded.delete(key));
    loaded.set(key, p);
  }
  return loaded.get(key);
}

/** Minimal shape check of a parsed registry. Returns it, or throws. */
export function validateShape(reg) {
  if (!reg || reg.schema !== 1 || typeof reg.tasks !== 'object' || typeof reg.models !== 'object') {
    throw new AiError('not-in-registry', 'registry has an unknown shape');
  }
  return reg;
}

/**
 * The model entry for an id.
 * @param {Registry} registry
 * @param {string} id
 * @returns {RegistryModel}
 */
export function getModel(registry, id) {
  const m = registry.models[id];
  if (!m) throw new AiError('not-in-registry', `model ${id} is not in the registry`, { details: { id } });
  return m;
}

/** The default model id of a task. */
export function defaultModelId(registry, task) {
  const t = registry.tasks[task];
  if (!t) throw new AiError('not-in-registry', `task ${task} is not in the registry`, { details: { task } });
  return t.default;
}

/** The directory under sdk/ of a task's module: its `module`, or the task's own name. */
export function taskModule(registry, task) {
  const t = registry.tasks[task];
  if (!t) throw new AiError('not-in-registry', `task ${task} is not in the registry`, { details: { task } });
  return t.module || task;
}

/**
 * Every base model a registry model credits, in order: `bases` when the model
 * joins several, else its one `base`.
 * @param {RegistryModel} model
 * @returns {RegistryBase[]}
 */
export function modelBases(model) {
  return Array.isArray(model.bases) && model.bases.length ? model.bases : [model.base];
}

/**
 * Resolve a `<part>:<path>` reference of a model.
 * @param {RegistryModel} model
 * @param {string} ref
 * @returns {ResolvedFile}
 */
export function resolveRef(model, ref) {
  const i = ref.indexOf(':');
  const part = ref.slice(0, i), path = ref.slice(i + 1);
  const p = model.parts[part];
  const meta = p?.files[path];
  if (!p || !meta) throw new AiError('not-in-registry', `${ref} is not in the registry`, { details: { ref } });
  return { ref, part, path, url: pinnedUrl(p.repo, p.revision, path), size: meta.size, sha256: meta.sha256, gitOid: meta.gitOid };
}

/**
 * Files of one variant, resolved.
 * @param {RegistryModel} model
 * @param {RegistryVariant} variant
 * @returns {ResolvedFile[]}
 */
export function variantFiles(model, variant) {
  const lazy = new Set(variant.lazy || []);
  return variant.files.map(ref => (lazy.has(ref) ? { ...resolveRef(model, ref), lazy: true } : resolveRef(model, ref)));
}

/** The files a variant downloads up front: all but the lazy ones. */
export function eagerFiles(model, variant) {
  return variantFiles(model, variant).filter(f => !f.lazy);
}

/**
 * Find a pinned file of a model by repo, revision and path (what a runtime asks for).
 * @param {RegistryModel} model
 * @returns {{ part: string, file: ResolvedFile } | null}
 */
export function findFile(model, repo, revision, path) {
  for (const [part, p] of Object.entries(model.parts)) {
    if (p.repo !== repo || p.revision !== revision) continue;
    if (!p.files[path]) return null;
    return { part, file: resolveRef(model, `${part}:${path}`) };
  }
  return null;
}

/** The part of a model that lives in this repo, or null. */
export function partOfRepo(model, repo) {
  for (const [part, p] of Object.entries(model.parts)) if (p.repo === repo) return { part, ...p };
  return null;
}

/** Every Hugging Face repo the registry pins, sorted. */
export function registryRepos(registry) {
  const set = new Set();
  for (const m of Object.values(registry.models)) for (const p of Object.values(m.parts)) set.add(p.repo);
  return [...set].sort();
}

/**
 * The files the tool sites may ask the store for: those of every variant of every
 * model, each pinned URL once, with its size, sorted by URL. The model store's
 * rule for the tools lists exactly these (scripts/broker-repos.mjs prints it).
 * @param {Registry} registry
 * @returns {{ url: string, size: number }[]}
 */
export function toolFiles(registry) {
  const seen = new Map();
  for (const m of Object.values(registry.models)) {
    for (const list of Object.values(m.devices)) for (const v of list) for (const f of variantFiles(m, v)) seen.set(f.url, f.size);
  }
  return [...seen].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([url, size]) => ({ url, size }));
}

/**
 * Every pinned URL of the registry with its size (what the catalog asks the store
 * about), each once: two models may share a part (the same repo at the same commit).
 */
export function registryUrls(registry) {
  const seen = new Map();
  for (const m of Object.values(registry.models)) {
    for (const p of Object.values(m.parts)) {
      for (const [path, meta] of Object.entries(p.files)) {
        const url = pinnedUrl(p.repo, p.revision, path);
        if (!seen.has(url)) seen.set(url, { url, size: meta.size });
      }
    }
  }
  return [...seen.values()];
}
