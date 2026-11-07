#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Copies the media task modules of the elffuss-ai SDK (text-to-image, video, video-gen, audio and the core they
// share) into this product from PINNED COMMITS, with the registry they read and the runtimes they run on, and records
// every file with its sha256 in <dest>/PIN.json. The same script lives in the chat (elffuss-home), Claw and Code.
//
//   node ai-sync.mjs                                  re-copy what PIN.json pins
//   node ai-sync.mjs --pin core=<rev> audio=<rev> …   pin new commits for those modules (the rest keep theirs), copy
//   node ai-sync.mjs --pin audio=none                 leave a module out (not copied, no registry): for a module the
//                                                     product does not offer yet; `core` cannot be left out
//   node ai-sync.mjs --check                          verify <dest> against PIN.json (no git needed)
//
// Where it lands: <dest> = site-chat/vendor/elffuss-ai (the chat) or web/vendor/elffuss-ai (Claw, Code). It has to
// be under /vendor/: the SDK starts its Workers only from same-origin URLs under /v/ or /vendor/ (sdk/core/tt.js).
//
//   <dest>/sdk/<module>/…        `git show <commit>:sdk/<module>/…`, byte for byte              (committed)
//   <dest>/registry/tasks.json   the registries of the pinned commits merged (tasks and models)  (committed)
//   <dest>/LICENSE, NOTICE       of the core's commit                                            (committed)
//   <dest>/runtimes/…            ONNX Runtime Web and Transformers.js, the webgpu variant, read from an elffuss-ai
//                                vendor/ directory and checked against vendor/manifest.json of the core's commit;
//                                Transformers.js rewritten to import that ONNX Runtime (the SDK's own rewrite,
//                                scripts/lib/rewrite-transformers.mjs of the same commit)          (git-ignored)
//
// Sources are read with `git show` only: no working tree of elffuss-ai is read or written, except the runtimes'
// vendor/ directory, whose every byte is checked. $ELFFUSS_AI_REPO (default ../elffuss-ai) is the repository,
// $ELFFUSS_AI_VENDOR (default <repo>/vendor) the runtimes. Output names repository-relative paths only.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync, mkdtempSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEST = ['site-chat/vendor/elffuss-ai', 'web/vendor/elffuss-ai'].map((d) => join(ROOT, d)).find((d) => existsSync(dirname(dirname(d))));
const PIN = join(DEST, 'PIN.json');
const REPO = resolve(process.env.ELFFUSS_AI_REPO || join(ROOT, '..', 'elffuss-ai'));
const VENDOR = resolve(process.env.ELFFUSS_AI_VENDOR || join(REPO, 'vendor'));
const GIT = '/usr/bin/git';
const shown = (p) => relative(ROOT, p).split(sep).join('/');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const die = (m) => { console.error('ai-sync: ' + m); process.exit(1); };

// The modules a product's media tools import, and the core they are built on. `core` first: the runtimes' manifest
// and the licence come from its commit.
const MODULES = ['core', 'text-to-image', 'video', 'video-gen', 'audio'];
// Registries merged into registry/tasks.json: each module's commit's tasks.json, and the entries a module ships as
// pending (video-gen keeps its model in registry/pending/ until its weights are published).
const RUNTIME_VARIANT = 'webgpu';   // brings WebGPU and WebAssembly; every media model declares WebGPU

function git(args, opts = {}) { return execFileSync(GIT, ['-C', REPO, ...args], { maxBuffer: 1 << 28, ...opts }); }
function rev(r) { try { return git(['rev-parse', '--verify', `${r}^{commit}`]).toString().trim(); } catch { return die(`commit ${r} not found in elffuss-ai`); } }
function lsTree(commit, dir) { return git(['ls-tree', '-r', '--name-only', commit, dir + '/']).toString().split('\n').filter(Boolean); }
function show(commit, path) { return git(['show', `${commit}:${path}`]); }
function exists(commit, path) { try { git(['cat-file', '-e', `${commit}:${path}`], { stdio: 'ignore' }); return true; } catch { return false; } }

function listFiles(dir, base = dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base)); else out.push(relative(base, p).split(sep).join('/'));
  }
  return out.sort();
}

if (!DEST) die('no site-chat/ or web/ here: run it from the product repository');

if (process.argv[2] === '--check') {
  if (!existsSync(PIN)) die(`${shown(PIN)} is missing`);
  const p = JSON.parse(readFileSync(PIN, 'utf8'));
  let bad = 0;
  const listed = new Set(['PIN.json']);
  for (const f of p.files) {
    listed.add(f.path);
    const file = join(DEST, f.path);
    if (!existsSync(file)) { console.error('missing: ' + shown(file)); bad++; continue; }
    if (sha(readFileSync(file)) !== f.sha256) { console.error('differs: ' + shown(file)); bad++; }
  }
  for (const f of listFiles(DEST)) if (!listed.has(f) && !/(^|\/)\.DS_Store$/.test(f)) { console.error('not pinned, would be served unchecked: ' + shown(join(DEST, f))); bad++; }
  if (bad) process.exit(1);
  console.log(`ai-sync: ${p.files.length} files match ${shown(PIN)} (${MODULES.map((m) => `${m} ${p.modules[m].omitted ? 'left out' : p.modules[m].commit.slice(0, 12)}`).join(', ')})`);
  process.exit(0);
}

// ---------- Which commits ----------
const prev = existsSync(PIN) ? JSON.parse(readFileSync(PIN, 'utf8')) : null;
const want = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--pin') die('unknown option ' + args[i]);
  while (args[i + 1] && !args[i + 1].startsWith('--')) {
    const [m, r] = args[++i].split('=');
    if (!MODULES.includes(m) || !r) die(`--pin takes <module>=<rev>, module one of ${MODULES.join(', ')}`);
    want[m] = r;
  }
}
const modules = {};
const left = (m) => modules[m].omitted;
for (const m of MODULES) {
  const r = want[m] || (prev?.modules?.[m]?.omitted ? 'none' : prev?.modules?.[m]?.commit);
  if (!r) die(`no commit for ${m}: pass --pin ${m}=<rev>`);
  if (r === 'none') {
    if (m === 'core') die('core cannot be left out');
    modules[m] = { dir: `sdk/${m}`, commit: null, omitted: true };
    continue;
  }
  const commit = rev(r);
  const dir = `sdk/${m}`;
  if (!exists(commit, dir)) die(`${commit.slice(0, 12)} has no ${dir}/`);
  modules[m] = { dir, commit };
}
const core = modules.core.commit;

// ---------- Copy ----------
const out = new Map();     // path under DEST → bytes
for (const m of MODULES) {
  if (left(m)) continue;
  const { dir, commit } = modules[m];
  for (const f of lsTree(commit, dir)) out.set(f, show(commit, f));
}

// The registry: one tasks.json with every task and model of the pinned commits. The same model id twice must be the
// same entry; a model the SDK has not published yet comes from the module's registry/pending/.
const registry = { schema: 1, tasks: {}, models: {} };
const registrySources = [];
const addRegistry = (commit, path) => {
  const r = JSON.parse(show(commit, path).toString());
  if (r.schema !== 1) die(`${path} at ${commit.slice(0, 12)} has schema ${r.schema}`);
  for (const [k, v] of Object.entries(r.tasks || {})) {
    if (registry.tasks[k] && JSON.stringify(registry.tasks[k]) !== JSON.stringify(v)) die(`task ${k} differs between pinned registries`);
    registry.tasks[k] = v;
  }
  for (const [k, v] of Object.entries(r.models || {})) {
    if (registry.models[k] && JSON.stringify(registry.models[k]) !== JSON.stringify(v)) die(`model ${k} differs between pinned registries`);
    registry.models[k] = v;
  }
  registrySources.push({ commit, path });
};
for (const commit of [...new Set(MODULES.filter((m) => !left(m)).map((m) => modules[m].commit))]) {
  addRegistry(commit, 'registry/tasks.json');
  for (const f of git(['ls-tree', '--name-only', commit, 'registry/pending/']).toString().split('\n').filter((x) => x.endsWith('.json'))) addRegistry(commit, f);
}
const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
registry.tasks = sortObj(registry.tasks); registry.models = sortObj(registry.models);
out.set('registry/tasks.json', Buffer.from(JSON.stringify(registry, null, 1) + '\n'));
out.set('LICENSE', show(core, 'LICENSE'));
out.set('NOTICE', show(core, 'NOTICE'));

// The runtimes: the files of the webgpu variant, checked against the manifest of the core's commit.
const manifest = JSON.parse(show(core, 'vendor/manifest.json').toString());
const pins = await import(pathToFileURL(writeTemp('runtime-pins.js', show(core, 'sdk/core/runtime-pins.js'))).href);
const rt = await import(pathToFileURL(writeTemp('runtimes.js', show(core, 'sdk/core/runtimes.js'), { './runtime-pins.js': 'runtime-pins.js', './errors.js': null })).href);
const { rewriteTransformers } = await import(pathToFileURL(writeTemp('rewrite-transformers.mjs', show(core, 'scripts/lib/rewrite-transformers.mjs'))).href);
const vendorFile = (pkgDir, file) => {
  const pkg = manifest.packages[pkgDir];
  if (!pkg) die(`the manifest of ${core.slice(0, 12)} has no ${pkgDir}`);
  const meta = pkg.files[file] || pkg.licenses?.[file];
  if (!meta) die(`the manifest has no ${pkgDir}/${file}`);
  const p = join(VENDOR, pkgDir, file);
  if (!existsSync(p)) die(`runtime file missing: ${pkgDir}/${file} (set ELFFUSS_AI_VENDOR, or run node scripts/vendor.mjs --fetch in elffuss-ai)`);
  const b = readFileSync(p);
  if (b.length !== meta.size || sha(b) !== meta.sha256) die(`runtime file does not match the manifest: ${pkgDir}/${file}`);
  return b;
};
const ORT = pins.VENDOR_DIRS.onnxruntimeWeb, TF = pins.VENDOR_DIRS.transformers;
const variant = rt.ORT_VARIANTS[RUNTIME_VARIANT];
for (const f of [variant.bundle, variant.mjs, variant.wasm]) out.set(`runtimes/${ORT}/${f}`, vendorFile(ORT, f));
for (const f of Object.keys(manifest.packages[ORT].licenses || {})) out.set(`runtimes/${ORT}/${f}`, vendorFile(ORT, f));
const tfDir = rt.transformersDir(RUNTIME_VARIANT);
out.set(`runtimes/${tfDir}/transformers.web.min.js`, Buffer.from(rewriteTransformers(vendorFile(TF, 'dist/transformers.web.min.js').toString('utf8'), rt.ortSpecifierFromTransformers(RUNTIME_VARIANT))));
for (const f of Object.keys(manifest.packages[TF].licenses || {})) out.set(`runtimes/${tfDir}/${f}`, vendorFile(TF, f));
// PDF.js, for the text of an attached PDF (read in this browser): the library, its worker and the character maps of
// fonts that need them; no fonts or image decoders (only the text is read).
const PDF = pins.VENDOR_DIRS.pdfjs;
for (const f of Object.keys(manifest.packages[PDF].files).filter((f) => f === rt.PDFJS_FILES.lib || f === rt.PDFJS_FILES.worker || f.startsWith(rt.PDFJS_FILES.cMapDir))) out.set(`runtimes/${PDF}/${f}`, vendorFile(PDF, f));
for (const f of ['LICENSE', `${rt.PDFJS_FILES.cMapDir}LICENSE`]) out.set(`runtimes/${PDF}/${f}`, vendorFile(PDF, f));

// Write: the destination is replaced whole, so a file a newer pin dropped does not linger.
rmSync(DEST, { recursive: true, force: true });
const files = [];
for (const [path, bytes] of [...out].sort(([a], [b]) => (a < b ? -1 : 1))) {
  const to = join(DEST, path);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, bytes);
  files.push({ path, sha256: sha(bytes) });
}
const pin = {
  schema: 'elffuss-ai-pin@1',
  note: 'Written by ai-sync.mjs. sdk/ is a byte copy of elffuss-ai at each module\'s commit (git show, never a working tree); registry/tasks.json merges the registries of those commits; runtimes/ (not committed) are checked against vendor/manifest.json of the core\'s commit. node ai-sync.mjs --check verifies every file.',
  repo: 'elffuss-ai',
  modules,
  registry: registrySources,
  runtimes: { variant: RUNTIME_VARIANT, manifestCommit: core, onnxruntimeWeb: pins.PINS.onnxruntimeWeb, transformers: pins.PINS.transformers },
  files,
};
writeFileSync(PIN, JSON.stringify(pin, null, 2) + '\n');
console.log(`ai-sync: ${files.length} files into ${shown(DEST)} (${MODULES.map((m) => `${m} ${left(m) ? 'left out' : modules[m].commit.slice(0, 12)}`).join(', ')})`);

// A source module of the pinned commit, written to a temporary directory so it can be imported; `deps` maps an import
// specifier to a sibling written there too (null: the import is cut, the functions used here do not need it).
function writeTemp(name, bytes, deps = {}) {
  const dir = writeTemp.dir ||= mkdtempSync(join(tmpdir(), 'ai-sync-'));
  let src = bytes.toString('utf8');
  for (const [spec, file] of Object.entries(deps)) {
    if (file === null) src = src.replace(new RegExp(`^import[^\\n]*['"]${spec.replace(/[.]/g, '\\.')}['"];?$`, 'm'), `const AiError = Error;`);
    else src = src.replaceAll(`'${spec}'`, `'./${file}'`);
  }
  const p = join(dir, name);
  writeFileSync(p, src);
  return p;
}
process.on('exit', () => { if (writeTemp.dir) rmSync(writeTemp.dir, { recursive: true, force: true }); });
