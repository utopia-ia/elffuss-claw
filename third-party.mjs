#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Third-party code the product runs (libraries, their WebAssembly, their styles), copied byte for byte from the
// published package of an EXACT version and served from this product's own origin. Nothing is loaded from a CDN at
// run time (Elffuss Link spec, §4.4, owner decision 2026-11-08). The same script lives in Claw and Code.
//
//   node third-party.mjs --check     no network: every file under web/vendor/third-party/ has the size and sha256 of
//                                    PIN.json, nothing is missing and nothing extra is there
//   node third-party.mjs --fetch     network: download each pinned package, require the tarball's sha512 to be the
//                                    one in PIN.json (and, for npm, the registry's), every file's sha256 to be the
//                                    one in PIN.json; then write the files
//   node third-party.mjs --ensure    --check, and --fetch when files are only missing (a fresh clone)
//   node third-party.mjs --pin       network: recompute PIN.json from what each entry selects (a new version, a new
//                                    file), then rewrite the import maps; review the diff before committing it
//   node third-party.mjs --write-importmap
//                                    rewrite the import map of the pages in PIN.json `importMapPages` from PIN.json:
//                                    each entry's `imports`, and the `integrity` of every pinned ES module
//
// --check also requires those import maps to be exactly the ones PIN.json implies. After rewriting one, the
// inline script's hash in the Content-Security-Policy changes too: node deploy/headers.mjs --write.
//
// web/vendor/third-party/PIN.json is in git; the files are not (web/vendor/third-party/*/ is git-ignored, like the
// media SDK's runtimes): deploy.sh runs --check before copying web/, a fresh clone runs --ensure.
//
// What an entry takes from its package:
//   select    paths inside the package (`*` matches inside one directory, `**` across directories)
//   closure   ES modules whose relative imports are followed and taken too (three.js addons)
//   rewrite   exact text replacements in a taken file (a bare import specifier made relative, so the module does
//             not depend on an import map); the result is what is pinned
//   wrap      a CommonJS/UMD build run inside a generated ES module (`module`, `exports` and `define` shadowed),
//             for libraries that publish no ES module build. The wrapper is ours: it is regenerated from the
//             package's bytes and its sha256 is pinned as well.
//   licenses  from the package, or from the upstream repository at a commit (pinned by sha256 and git blob hash)
//
// Tarballs are cached in $THIRD_PARTY_CACHE (default: a directory in the system's temporary folder).
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const VENDOR = join(ROOT, 'web', 'vendor', 'third-party');
const PIN = join(VENDOR, 'PIN.json');
const CACHE = process.env.THIRD_PARTY_CACHE || join(tmpdir(), 'elffuss-third-party');
const UA = { 'user-agent': 'elffuss-third-party' };

export const sha256 = (b) => createHash('sha256').update(b).digest('hex');
export const sri = (b, alg = 'sha384') => `${alg}-` + createHash(alg).update(b).digest('base64');
const sha512b64 = (b) => 'sha512-' + createHash('sha512').update(b).digest('base64');
const gitOid = (b) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');
// `*` matches inside one directory, `**` across directories.
const globToRe = (g) => new RegExp('^' + g.split('**').map((part) => part.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*') + '$');
const die = (m) => { console.error('third-party: ' + m); process.exit(1); };

export const readPin = () => JSON.parse(readFileSync(PIN, 'utf8'));

// ---- tar.gz (ustar with pax and GNU long names; regular files only, never links) ----
function readTgz(tgz) {
  const tar = gunzipSync(tgz);
  const field = (o, n) => { const s = tar.subarray(o, o + n); const e = s.indexOf(0); return (e < 0 ? s : s.subarray(0, e)).toString('utf8'); };
  const files = new Map();
  let off = 0, longName = null, paxPath = null;
  while (off + 512 <= tar.length) {
    if (tar.subarray(off, off + 512).every((b) => b === 0)) break;
    const size = parseInt(field(off + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(tar[off + 156] || 48);
    const prefix = field(off + 345, 155);
    const name = (prefix ? prefix + '/' : '') + field(off, 100);
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = body.toString('utf8').replace(/\0+$/, ''); continue; }
    if (type === 'x') { for (const r of body.toString('utf8').split('\n')) { const m = /^\d+ path=(.*)$/.exec(r); if (m) paxPath = m[1]; } continue; }
    if (type === 'g') continue;
    const path = paxPath || longName || name;
    paxPath = null; longName = null;
    if (type !== '0' && type !== '\0' && type !== '7') continue;
    if (path.split('/').some((p) => p === '..')) throw new Error('unsafe path in tarball: ' + path);
    files.set(path, Buffer.from(body));
  }
  return files;
}

async function getBytes(url) {
  const r = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
async function getJSON(url) { return JSON.parse((await getBytes(url)).toString('utf8')); }

// The package's tarball, from the cache when its sha512 is the pinned one, else from the network.
async function tarball(e, { pinning = false } = {}) {
  const file = join(CACHE, `${e.name.replace('/', '__')}-${e.version}.tgz`);
  if (existsSync(file) && e.integrity) {
    const b = readFileSync(file);
    if (sha512b64(b) === e.integrity) return b;
  }
  const b = await getBytes(e.tarball);
  const got = sha512b64(b);
  if (e.source === 'npm') {
    const meta = await getJSON(`https://registry.npmjs.org/${e.name.replace('/', '%2F')}/${e.version}`);
    if (meta.version !== e.version) throw new Error(`${e.name}: the registry answered version ${meta.version}`);
    if (meta.dist.tarball !== e.tarball) throw new Error(`${e.name}@${e.version}: the registry's tarball is ${meta.dist.tarball}`);
    if (got !== meta.dist.integrity) throw new Error(`${e.name}@${e.version}: tarball sha512 differs from the registry's`);
  }
  if (!pinning && got !== e.integrity) throw new Error(`${e.name}@${e.version}: tarball sha512 differs from PIN.json`);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, b);
  return b;
}

// Relative imports of an ES module (static, dynamic with a literal, export-from).
function relImports(src) {
  const out = new Set();
  for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|import\s*['"](\.{1,2}\/[^'"]+)['"]/g)) out.add(m[1] || m[2] || m[3]);
  return [...out];
}

// The generated ES module around a CommonJS/UMD build.
export function wrapSource(w, original, e) {
  const head = `// Generated by third-party.mjs: ${e.name}@${e.version}/${w.file} (sha256 ${sha256(original)}), a UMD/CommonJS build\n` +
    `// run as CommonJS inside an ES module. Licence: ${e.license}, see LICENSE next to this directory.\n` +
    `const module = { exports: {} }; const exports = module.exports; const define = undefined;\n`;
  const names = (w.exports || []).join(', ');
  const tail = `\n;export default module.exports;\n` + (names ? `export const { ${names} } = module.exports;\n` : '');
  return Buffer.concat([Buffer.from(head), original, Buffer.from(tail)]);
}

// Every file an entry yields, with its bytes: { path → Buffer } (paths relative to the entry's directory).
async function materialise(e, { pinning = false } = {}) {
  const tgz = await tarball(e, { pinning });
  const all = readTgz(tgz);
  const root = e.root ?? 'package/';
  const pkg = new Map([...all].filter(([p]) => p.startsWith(root)).map(([p, b]) => [p.slice(root.length), b]));
  const out = new Map();
  for (const pattern of e.select || []) {
    const re = globToRe(pattern);
    const hits = [...pkg.keys()].filter((p) => re.test(p)).sort();
    if (!hits.length) throw new Error(`${e.name}@${e.version}: nothing matches ${pattern}`);
    for (const p of hits) out.set(p, pkg.get(p));
  }
  for (const start of e.closure || []) {
    const todo = [start];
    while (todo.length) {
      const p = todo.pop();
      if (out.has(p) && p !== start) continue;
      const b = pkg.get(p);
      if (!b) throw new Error(`${e.name}@${e.version}: ${p} is imported but not in the package`);
      out.set(p, b);
      for (const r of relImports(b.toString('utf8'))) {
        const q = posix.normalize(posix.join(posix.dirname(p), r));
        if (!out.has(q)) todo.push(q);
      }
    }
  }
  for (const r of e.rewrite || []) {
    const b = out.get(r.file);
    if (!b) throw new Error(`${e.name}@${e.version}: ${r.file} is rewritten but not taken`);
    let text = b.toString('utf8');
    for (const [from, to] of r.replace) {
      const n = text.split(from).length - 1;
      if (n !== (r.count ?? 1)) throw new Error(`${e.name}@${e.version}/${r.file}: «${from}» found ${n} times, expected ${r.count ?? 1}`);
      text = text.split(from).join(to);
    }
    out.set(r.file, Buffer.from(text, 'utf8'));
  }
  for (const w of e.wrap || []) {
    const b = pkg.get(w.file);
    if (!b) throw new Error(`${e.name}@${e.version}: ${w.file} not in the package`);
    out.set(w.out, wrapSource(w, b, e));
  }
  for (const [path, lic] of Object.entries(e.licenses || {})) {
    if (lic.from === 'package') {
      const b = pkg.get(lic.file || path);
      if (!b) throw new Error(`${e.name}@${e.version}: licence ${lic.file || path} not in the package`);
      out.set(path, b);
    } else if (lic.from === 'github') {
      const url = `https://raw.githubusercontent.com/${lic.repo}/${lic.commit}/${lic.file}`;
      const b = await getBytes(url);
      if (!pinning && lic.gitOid && gitOid(b) !== lic.gitOid) throw new Error(`${e.name}: ${url} has another git blob hash than PIN.json`);
      out.set(path, b);
    } else throw new Error(`${e.name}: unknown licence source ${lic.from}`);
  }
  return out;
}

/**
 * The import map index.html must carry: each entry's `imports` (specifier → path in the package) and the `integrity`
 * of every ES module file pinned here (scripts loaded otherwise, listed in `classic`, are left out).
 * @param {object} pin
 * @param {string} base URL of web/vendor/third-party/ as the page sees it
 * @param {object} [extra] product imports that are not third-party (kept first, unchanged)
 */
export function importMap(pin = readPin(), base = './vendor/third-party/', extra = {}) {
  const imports = { ...extra }, integrity = {};
  for (const [id, e] of Object.entries(pin.packages)) {
    for (const [spec, path] of Object.entries(e.imports || {})) imports[spec] = base + id + '/' + path;
    const classic = (e.classic || []).map(globToRe);
    for (const [path, meta] of Object.entries(e.files)) {
      if (!meta.sri || classic.some((re) => re.test(path))) continue;
      integrity[base + id + '/' + path] = meta.sri;
    }
  }
  return { imports, integrity };
}

/** The JSON of `<script type="importmap">` in an HTML text (null when there is none). */
export function importMapOf(html) {
  const m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
  return m ? { text: m[1], json: JSON.parse(m[1]) } : null;
}

/** The text index.html's import map has to have (two-space JSON, on its own lines). */
export const importMapText = (map) => '\n' + JSON.stringify(map, null, 2) + '\n';

function listFiles(dir, base = dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}

/** Offline check; returns the problems found (empty when all is well). */
export function check(pin = readPin()) {
  const problems = [];
  const expected = new Set(['PIN.json']);
  for (const [id, e] of Object.entries(pin.packages)) {
    if (id !== `${e.name}@${e.version}`) problems.push(`${id}: entry id is not name@version`);
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(e.version)) problems.push(`${id}: not an exact version`);
    if (!/^sha512-[A-Za-z0-9+/=]{88}$/.test(e.integrity || '')) problems.push(`${id}: missing or malformed sha512`);
    for (const [path, meta] of Object.entries(e.files || {})) {
      const rel = `${id}/${path}`;
      expected.add(rel);
      const p = join(VENDOR, rel);
      if (!existsSync(p)) { problems.push(`${rel}: missing`); continue; }
      const b = readFileSync(p);
      if (b.length !== meta.size) problems.push(`${rel}: size ${b.length}, PIN.json ${meta.size}`);
      else if (sha256(b) !== meta.sha256) problems.push(`${rel}: sha256 differs from PIN.json`);
    }
  }
  for (const f of listFiles(VENDOR)) {
    if (/(^|\/)\._/.test(f) || f.endsWith('.DS_Store')) continue;
    if (!expected.has(f)) problems.push(`${f}: under web/vendor/third-party/ but not in PIN.json`);
  }
  // Hashes written in the product's code (a classic script's `integrity`): `sriIn` maps a pinned file to the web/ file
  // that must carry its sha384, so a new pin cannot leave a stale hash behind.
  for (const [id, e] of Object.entries(pin.packages)) {
    for (const [path, file] of Object.entries(e.sriIn || {})) {
      const want = e.files?.[path]?.sri;
      const text = existsSync(join(ROOT, 'web', file)) ? readFileSync(join(ROOT, 'web', file), 'utf8') : '';
      if (!want || !text.includes(want)) problems.push(`web/${file}: does not carry the sha384 of ${id}/${path} (${want})`);
    }
  }
  // Every page with an import map carries exactly the one PIN.json implies (paths and integrity).
  for (const page of pin.importMapPages || []) {
    const html = readFileSync(join(ROOT, 'web', page), 'utf8');
    const got = importMapOf(html);
    const want = importMap(pin, pin.importMapBase || './vendor/third-party/', pin.importMapExtra || {});
    if (!got) problems.push(`web/${page}: no import map`);
    else if (got.text !== importMapText(want)) problems.push(`web/${page}: the import map is not the one PIN.json implies (node third-party.mjs --write-importmap)`);
  }
  return problems;
}

/** Rewrite the import map of the pages PIN.json lists. */
export function writeImportMaps(pin = readPin()) {
  for (const page of pin.importMapPages || []) {
    const file = join(ROOT, 'web', page);
    const html = readFileSync(file, 'utf8');
    const want = importMapText(importMap(pin, pin.importMapBase || './vendor/third-party/', pin.importMapExtra || {}));
    const out = html.replace(/(<script type="importmap">)[\s\S]*?(<\/script>)/, (_, a, b) => a + want + b);
    if (out === html && !importMapOf(html)) throw new Error(`web/${page}: no import map to rewrite`);
    writeFileSync(file, out);
  }
}

async function fetchAll(pin) {
  for (const [id, e] of Object.entries(pin.packages)) {
    const files = await materialise(e);
    const want = new Set(Object.keys(e.files));
    for (const p of files.keys()) if (!want.has(p)) throw new Error(`${id}: ${p} is produced but not pinned (run --pin)`);
    for (const p of want) if (!files.has(p)) throw new Error(`${id}: ${p} is pinned but not produced`);
    const dir = join(VENDOR, id);
    rmSync(dir, { recursive: true, force: true });
    for (const [p, b] of files) {
      const meta = e.files[p];
      if (b.length !== meta.size || sha256(b) !== meta.sha256) throw new Error(`${id}/${p}: bytes differ from PIN.json`);
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), b);
    }
    console.log(`third-party: ${id} (${files.size} files)`);
  }
}

async function pinAll(pin) {
  for (const [id, e] of Object.entries(pin.packages)) {
    const tgz = await tarball(e, { pinning: true });
    e.integrity = sha512b64(tgz);
    const files = await materialise(e, { pinning: true });
    e.files = {};
    for (const p of [...files.keys()].sort()) {
      const b = files.get(p);
      e.files[p] = { size: b.length, sha256: sha256(b) };
      if (/\.(m?js)$/.test(p)) e.files[p].sri = sri(b);
    }
    for (const [path, lic] of Object.entries(e.licenses || {})) {
      if (lic.from === 'github') lic.gitOid = gitOid(files.get(path));
    }
    console.log(`third-party: pinned ${id} (${files.size} files, ${e.integrity.slice(0, 20)}…)`);
  }
  writeFileSync(PIN, JSON.stringify(pin, null, 2) + '\n');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const mode = process.argv[2] || '--check';
  const pin = readPin();
  if (mode === '--check' || mode === '--ensure') {
    const problems = check(pin);
    if (!problems.length) { console.log(`third-party: ${Object.values(pin.packages).reduce((n, e) => n + Object.keys(e.files).length, 0)} files match web/vendor/third-party/PIN.json (${Object.keys(pin.packages).join(', ')})`); process.exit(0); }
    if (mode === '--ensure' && problems.every((p) => /: missing$/.test(p))) {
      await fetchAll(pin).catch((e) => die(e.message));
      const again = check(pin);
      if (again.length) die(again.join('\n'));
      console.log('third-party: fetched and checked');
      process.exit(0);
    }
    die(problems.slice(0, 40).join('\n') + (problems.length > 40 ? `\n… ${problems.length - 40} more` : ''));
  } else if (mode === '--fetch') {
    await fetchAll(pin).catch((e) => die(e.message));
    const problems = check(pin);
    if (problems.length) die(problems.join('\n'));
    console.log('third-party: fetched and checked');
  } else if (mode === '--pin') {
    await pinAll(pin).catch((e) => die(e.message));
    writeImportMaps(readPin());
  } else if (mode === '--write-importmap') {
    writeImportMaps(pin);
  } else die('unknown mode ' + mode);
}
