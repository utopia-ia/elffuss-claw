// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Do the generated nginx snippets (deploy/nginx/, from deploy/headers.json) send, path by path, exactly the headers
// deploy/headers.mjs says, and in every location of the server? No nginx needed: the maps are evaluated here with
// nginx's rules (exact keys, then regexes in order, then default), and the add_header inheritance rule is applied to
// the server's shape: a location with an add_header of its own does NOT inherit the server's, so the snippet has to be
// included in it too. The same test lives in Claw, Code and the chat; the shape of each server is below.
//
//   node tests/headers-nginx.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSpec, headersFor } from '../deploy/headers.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
let fallos = 0;
const ok = (n, c, e = '') => { console.log((c ? '✅' : '❌') + ' ' + n + (e ? '  — ' + e : '')); if (!c) fallos++; };

// The maps of a maps.conf: name → { exact: Map, regex: [[re, value]], def }.
function maps(text) {
  const out = new Map();
  for (const m of text.matchAll(/map \$uri \$(\w+) \{\n([\s\S]*?)\n\}/g)) {
    const e = { exact: new Map(), regex: [], def: undefined };
    for (const line of m[2].split('\n')) {
      const l = /^\s*(default|"[^"]*")\s+("([^"]*)"|'([^']*)');$/.exec(line);
      if (!l) throw new Error('unreadable map line: ' + line);
      const val = l[3] ?? l[4];
      if (l[1] === 'default') e.def = val;
      else { const k = l[1].slice(1, -1); if (k.startsWith('~')) e.regex.push([new RegExp(k.slice(1)), val]); else e.exact.set(k, val); }
    }
    out.set(m[1], e);
  }
  return out;
}
const evalua = (e, uri) => e.exact.has(uri) ? e.exact.get(uri) : (e.regex.find(([re]) => re.test(uri))?.[1] ?? e.def);
// The headers a snippet sends for a uri (values '' are not sent).
function envia(snippet, ms, uri) {
  const h = {};
  for (const m of snippet.matchAll(/^add_header ([\w-]+) (\$\w+|"[^"]*"|'[^']*') always;$/gm)) {
    let v = m[2];
    if (v.startsWith('$')) { const e = ms.get(v.slice(1)); if (!e) throw new Error('undefined variable ' + v); v = evalua(e, uri); }
    else v = v.slice(1, -1);
    if (v !== '') h[m[1]] = v;
  }
  return h;
}

// Paths worth checking per site (what each policy matches, plus ordinary files).
const MUESTRAS = {
  'claw.elffuss.com': ['/index.html', '/js/kernel.js', '/vendor/third-party/three@0.160.0/build/three.module.js', '/bridge.html', '/sandbox/run.html', '/proxy', '/websearch', '/memory/index.html'],
  'models.elffuss.com': ['/index.html', '/', '/sw.js', '/bonsai-27b.p0'],
  'code.elffuss.com': ['/index.html', '/js/main.js', '/lab.html', '/js/tools/eval-worker.js', '/sandbox/run.html', '/vendor/x2/abc/sandbox-main.js', '/proxy'],
  'elffuss.com': ['/index.html', '/chat/chat.js', '/chat/sandbox/run.html', '/vendor/elffuss-ai/sdk/core/task.js', '/apps/index.html', '/blog/index.html', '/img/x.webp', '/proxy'],
};

const spec = loadSpec();
for (const [name, site] of Object.entries(spec.sites)) {
  const dir = join(RAIZ, 'deploy', 'nginx');
  const ms = maps(readFileSync(join(dir, `${site.file}.maps.conf`), 'utf8'));
  for (const phase of [1, 2]) {
    const snippet = readFileSync(join(dir, `${site.file}.headers${phase === 1 ? '.report-only' : ''}.conf`), 'utf8');
    const malos = [];
    for (const uri of MUESTRAS[name] || ['/index.html']) {
      const got = envia(snippet, ms, uri), want = headersFor(name, uri, { phase });
      if (JSON.stringify(Object.entries(got).sort()) !== JSON.stringify(Object.entries(want).sort())) malos.push(uri);
    }
    ok(`${name} fase ${phase}: los fragmentos de nginx mandan lo mismo que headers.mjs en ${(MUESTRAS[name] || []).length} rutas`, malos.length === 0, malos.join(' '));
  }
}

// The shape of claw.elffuss.com's server (tests/memoria-v2-nginx.mjs has the same one): which locations have an
// add_header of their own, so the snippet must be included in them as well as in the server block.
const SERVER = {
  'claw.elffuss.com': [
    { loc: '~ \\.mjs$', own: true }, { loc: '= /proxy/report', own: false }, { loc: '= /proxy', own: false },
    { loc: '~* \\.(js|mjs|html|css|json)$', own: true }, { loc: '/', own: false }, { loc: '^~ /memory/', own: true, ownHeaders: 'server/memory/headers.conf' },
  ],
};
for (const [name, locs] of Object.entries(SERVER)) {
  if (!spec.sites[name]) continue;
  const conPropias = locs.filter((l) => l.own && !l.ownHeaders).map((l) => l.loc);
  console.log(`ℹ️  ${name}: incluir el fragmento en el server y en ${conPropias.map((l) => 'location ' + l).join(', ')} (tienen add_header propio); /memory/ lleva el suyo (server/memory/headers.conf)`);
  const mem = locs.find((l) => l.ownHeaders);
  if (mem && existsSync(join(RAIZ, mem.ownHeaders))) {
    const conf = readFileSync(join(RAIZ, mem.ownHeaders), 'utf8');
    ok(`${name} /memory/: su fragmento lleva HSTS, nosniff, Referrer-Policy y su propia CSP`, /Strict-Transport-Security/.test(conf) && /nosniff/.test(conf) && /Referrer-Policy/.test(conf) && /Content-Security-Policy/.test(conf));
  }
}

console.log(fallos ? `\n❌ ${fallos} FALLO(S)` : '\n✅ los fragmentos de nginx mandan las cabeceras de deploy/headers.json');
process.exit(fallos ? 1 : 0);
