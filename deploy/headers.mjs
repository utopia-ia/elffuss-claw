#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Security headers of the sites this repository serves, from ONE source: deploy/headers.json. The same script lives
// in Claw, Code and the chat (elffuss-home); only headers.json differs. Elffuss Link spec §4.4 (product-origin gate).
//
//   node deploy/headers.mjs --write   regenerate deploy/nginx/<site>.maps.conf, <site>.headers.conf and
//                                     <site>.headers.report-only.conf from headers.json and the pages' inline scripts
//   node deploy/headers.mjs --check   no network: the generated files are current, every hashed page still has the
//                                     inline scripts the policy names, and no page, script or style of web/ loads
//                                     code, styles or fonts from another origin
//   node deploy/headers.mjs --print <site> <path> [--phase 1|2]
//                                     the headers one response gets (what the test server sends)
//
// nginx, per site (the generated files say where each goes):
//   <site>.maps.conf                 http context (conf.d/): one `map $uri` per header that changes with the path
//   <site>.headers.report-only.conf  PHASE 1: the strict policy as Content-Security-Policy-Report-Only; enforced only
//                                    frame-ancestors, object-src and base-uri (and the few policies marked `phase1`,
//                                    whole, from the start); include it in the server
//                                    block AND in every location that has add_header of its own (nginx drops the
//                                    server's add_header in such a location)
//   <site>.headers.conf              PHASE 2: the strict policy enforced, with Trusted Types still report-only
// No violation report is sent anywhere (no report-uri): a report would tell a server what a person was doing, which
// the products promise not to do. Violations are watched in the browser console and in tests/csp-f0.mjs.
//
// Placeholders in headers.json values: {self} is the site's origin; {inline:<file>} the 'sha256-…' sources of every
// inline executable <script> of <file> (repository-relative), JSON import maps included.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
const OUT = join(HERE, 'nginx');
export const loadSpec = () => JSON.parse(readFileSync(join(HERE, 'headers.json'), 'utf8'));

// Header names whose value depends on the path (one nginx map each).
const MAPPED = [
  ['Content-Security-Policy', 'csp'],
  ['Content-Security-Policy-Report-Only', 'csp_ro'],
  ['Cross-Origin-Opener-Policy', 'coop'],
  ['Cross-Origin-Resource-Policy', 'corp'],
  ['Permissions-Policy', 'pp'],
];

/** Inline executable scripts of an HTML text (classic, module and import maps; not JSON-LD or other data blocks). */
export function inlineScripts(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1];
    if (/\bsrc\s*=/.test(attrs)) continue;
    const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1] || '').toLowerCase();
    if (type && !['module', 'importmap', 'text/javascript', 'application/javascript'].includes(type)) continue;
    out.push(m[2]);
  }
  return out;
}
export const hashSource = (text) => "'sha256-" + createHash('sha256').update(text, 'utf8').digest('base64') + "'";

function fill(value, site, root = ROOT) {
  return value
    .replace(/\{self\}/g, site.origin)
    .replace(/\{inline:([^}]+)\}/g, (_, file) => {
      const p = join(root, file);
      if (!existsSync(p)) throw new Error(`{inline:${file}}: no such file`);
      const scripts = inlineScripts(readFileSync(p, 'utf8'));
      if (!scripts.length) throw new Error(`{inline:${file}}: the page has no inline script to hash`);
      return scripts.map(hashSource).join(' ');
    });
}

/** The header values of one policy of a site, for a phase (1: report-only rollout, 2: enforced). */
export function policyHeaders(site, policy, { phase = 2, root = ROOT } = {}) {
  if (policy.none) return Object.fromEntries(MAPPED.map(([h]) => [h, '']));
  const csp = (policy.csp || []).map((d) => fill(d, site, root)).join('; ');
  const ro = [...(policy.csp || []), ...(policy.reportOnly || [])].filter((d) => !/^sandbox\b/.test(d)).map((d) => fill(d, site, root)).join('; ');
  // Phase 1 already enforces what cannot break a page that works: who may frame it, no plugins, no <base>.
  const safe = (policy.csp || []).filter((d) => /^(frame-ancestors|object-src|base-uri) /.test(d)).map((d) => fill(d, site, root)).join('; ');
  // `reportOnlyAlways`: pages this repository does not build (served next to it) get the strict policy as a report in
  // both phases, and only the safe directives enforced.
  const enforced = policy.reportOnlyAlways ? safe : phase === 2 || policy.phase1 ? csp : safe;
  const reportOnly = policy.reportOnlyAlways ? ro : phase === 2 ? (policy.reportOnly?.length ? ro : '') : (policy.phase1 ? (policy.reportOnly?.length ? ro : '') : ro);
  const h = policy.headers || {};
  return {
    'Content-Security-Policy': enforced,
    'Content-Security-Policy-Report-Only': reportOnly,
    'Cross-Origin-Opener-Policy': h['Cross-Origin-Opener-Policy'] ?? '',
    'Cross-Origin-Resource-Policy': h['Cross-Origin-Resource-Policy'] ?? '',
    'Permissions-Policy': h['Permissions-Policy'] ?? '',
  };
}

/** Which policy of a site answers a path, with nginx's map rules: exact keys first, then regexes in order. */
export function policyFor(site, path) {
  const keys = (p) => [].concat(p.match);
  for (const p of site.policies) if (keys(p).some((k) => !k.startsWith('~') && k !== 'default' && k === path)) return p;
  for (const p of site.policies) if (keys(p).some((k) => k.startsWith('~') && new RegExp(k.slice(1)).test(path))) return p;
  const d = site.policies.find((p) => keys(p).includes('default'));
  if (!d) throw new Error(`${site.origin}: no default policy`);
  return d;
}

/** Every header a response to `path` gets (values '' are not sent, as with nginx). */
export function headersFor(siteName, path, { phase = 2, spec = loadSpec(), root = ROOT } = {}) {
  const site = spec.sites[siteName];
  if (!site) throw new Error('unknown site ' + siteName);
  const all = { ...policyHeaders(site, policyFor(site, path), { phase, root }), ...site.common };
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v !== ''));
}

// nginx string: double quotes, or single quotes when the value has double quotes (Permissions-Policy origins).
const q = (v) => {
  if (/[\\\n]/.test(v) || (v.includes('"') && v.includes("'"))) throw new Error('a header value nginx cannot quote: ' + v);
  return v.includes('"') ? `'${v}'` : `"${v}"`;
};

function mapsConf(name, site, spec) {
  const v = (h) => `$${site.prefix}_${MAPPED.find(([x]) => x === h)[1]}`;
  const lines = [
    `# GENERATED by deploy/headers.mjs from deploy/headers.json. Do not edit; run node deploy/headers.mjs --write.`,
    `# ${name}: http context (for example /etc/nginx/conf.d/${site.file}.maps.conf). The values the header snippets send,`,
    `# chosen by path ($uri, after nginx's internal redirects such as index): exact paths first, then regexes in order.`,
    `# Both phases' Content-Security-Policy values are here; the snippet included in the server block picks the phase.`,
  ];
  const phases = [['', 2], ['_p1', 1]];
  for (const [header, short] of MAPPED) {
    for (const [suffix, phase] of (short === 'csp' || short === 'csp_ro') ? phases : [['', 2]]) {
      const per = site.policies.map((p) => ({ p, h: policyHeaders(site, p, { phase }) }));
      lines.push('', `map $uri ${v(header)}${suffix} {`);
      const def = per.find(({ p }) => [].concat(p.match).includes('default'));
      lines.push(`    default ${q(def.h[header])};`);
      for (const { p, h } of per) for (const k of [].concat(p.match)) if (k !== 'default' && !k.startsWith('~')) lines.push(`    ${q(k)} ${q(h[header])};`);
      for (const { p, h } of per) for (const k of [].concat(p.match)) if (k.startsWith('~')) lines.push(`    ${q(k)} ${q(h[header])};`);
      lines.push('}');
    }
  }
  return lines.join('\n') + '\n';
}

function headersConf(name, site, spec, phase) {
  const v = (short, p1) => `$${site.prefix}_${short}${p1 ? '_p1' : ''}`;
  const lines = [
    `# GENERATED by deploy/headers.mjs from deploy/headers.json. Do not edit; run node deploy/headers.mjs --write.`,
    `# ${name}, PHASE ${phase} (${phase === 1 ? 'the strict policy report-only' : 'the strict policy enforced, Trusted Types report-only'}).`,
    `# Needs ${site.file}.maps.conf in the http context. Include it in the server block AND in every location of the`,
    `# server that has an add_header of its own (there nginx forgets the server's add_header): tests/headers-nginx.mjs checks this on the server's shape.`,
    `add_header Content-Security-Policy ${v('csp', phase === 1)} always;`,
    `add_header Content-Security-Policy-Report-Only ${v('csp_ro', phase === 1)} always;`,
    `add_header Cross-Origin-Opener-Policy ${v('coop')} always;`,
    `add_header Cross-Origin-Resource-Policy ${v('corp')} always;`,
    `add_header Permissions-Policy ${v('pp')} always;`,
  ];
  for (const [h, val] of Object.entries(site.common)) lines.push(`add_header ${h} ${q(val)} always;`);
  return lines.join('\n') + '\n';
}

export function generated(spec = loadSpec()) {
  const files = new Map();
  for (const [name, site] of Object.entries(spec.sites)) {
    files.set(`${site.file}.maps.conf`, mapsConf(name, site, spec));
    files.set(`${site.file}.headers.report-only.conf`, headersConf(name, site, spec, 1));
    files.set(`${site.file}.headers.conf`, headersConf(name, site, spec, 2));
  }
  return files;
}

// ---- no third-party code, styles or fonts (spec §4.4: «a CI check fails if any HTML, JS or CSS references another
// origin for script, style, font, worker or import») ----
const CDN_HOSTS = /\b(cdn\.jsdelivr\.net|unpkg\.com|esm\.sh|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|ajax\.googleapis\.com|cdn\.sheetjs\.com|cdn\.skypack\.dev|ga\.jspm\.io|w\.soundcloud\.com\/player\/api\.js|code\.jquery\.com|stackpath\.bootstrapcdn\.com|cdn\.tailwindcss\.com)\b/;
const LOADS = [
  /\bimport\s*\(\s*['"`]https?:\/\//,
  /\bfrom\s*['"]https?:\/\//,
  /\bimport\s*['"]https?:\/\//,
  /<script\b[^>]*\bsrc\s*=\s*["']?https?:\/\//i,
  /<link\b[^>]*\brel\s*=\s*["']?(stylesheet|modulepreload|preload)[^>]*\bhref\s*=\s*["']?https?:\/\//i,
  /<link\b[^>]*\bhref\s*=\s*["']?https?:\/\/[^"'\s>]*["']?[^>]*\brel\s*=\s*["']?(stylesheet|modulepreload|preload)/i,
  /\bimportScripts\s*\(\s*['"`]https?:\/\//,
  /\bnew\s+(Shared)?Worker\s*\(\s*['"`]https?:\/\//,
  /@import\s+(url\()?\s*['"]?https?:\/\//,
  /@font-face[^}]*url\(\s*['"]?https?:\/\//,
  /\.src\s*=\s*['"`]https?:\/\/[^'"`]*\.m?js\b/,
];
function walk(dir, skip, out = []) {
  if (!existsSync(dir)) return out;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    const rel = relative(ROOT, p).split(sep).join('/');
    if (skip.some((s) => rel === s || rel.startsWith(s + '/'))) continue;
    if (d.isDirectory()) walk(p, skip, out);
    else if (/\.(html|m?js|css)$/.test(d.name)) out.push(rel);
  }
  return out;
}
/** References to code, styles or fonts on another origin in the served tree (comments skipped). */
export function thirdPartyRefs(spec = loadSpec(), root = ROOT) {
  const scan = spec.scan || { dirs: ['web'], skip: [] };
  const hits = [];
  for (const dir of scan.dirs) {
    for (const rel of walk(join(root, dir), scan.skip || [])) {
      const lines = readFileSync(join(root, rel), 'utf8').split('\n');
      lines.forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--') || t.startsWith('#')) return;
        if (line.length > 4000) return; // minified third-party code is checked by its pin, not here
        if (CDN_HOSTS.test(line) || LOADS.some((re) => re.test(line))) hits.push(`${rel}:${i + 1}: ${t.slice(0, 160)}`);
      });
    }
  }
  return hits;
}

export function check(spec = loadSpec()) {
  const problems = [];
  let files;
  try { files = generated(spec); } catch (e) { return [e.message]; }
  for (const [name, text] of files) {
    const p = join(OUT, name);
    if (!existsSync(p)) problems.push(`deploy/nginx/${name}: missing (node deploy/headers.mjs --write)`);
    else if (readFileSync(p, 'utf8') !== text) problems.push(`deploy/nginx/${name}: not current (node deploy/headers.mjs --write)`);
  }
  for (const [name, site] of Object.entries(spec.sites)) {
    for (const p of site.policies) {
      if (p.none || !p.csp?.length) continue;
      const csp = (p.csp || []).join('; ');
      if (/'unsafe-inline'/.test((p.csp || []).find((d) => d.startsWith('script-src')) || '') && !p.sandboxed) problems.push(`${name} ${p.name}: 'unsafe-inline' in script-src`);
      if (/'unsafe-eval'/.test((p.csp || []).find((d) => d.startsWith('script-src')) || '') && !p.sandboxed && !p.allowEval) problems.push(`${name} ${p.name}: 'unsafe-eval' in script-src`);
      if (!p.sandboxed) for (const need of ['object-src', 'base-uri', 'frame-ancestors']) if (!new RegExp(`(^|; )${need} `).test(csp)) problems.push(`${name} ${p.name}: no ${need}`);
      if (/\*\.elffuss\.com/.test(csp)) problems.push(`${name} ${p.name}: a *.elffuss.com wildcard (exact origins only, spec §4.6)`);
      if ((p.headers || {})['Cross-Origin-Opener-Policy'] === 'same-origin' && site.product) problems.push(`${name} ${p.name}: product COOP must never be same-origin (spec §4.4)`);
    }
  }
  for (const h of thirdPartyRefs(spec)) problems.push('third-party load: ' + h);
  return problems;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === '--write') {
    mkdirSync(OUT, { recursive: true });
    for (const [name, text] of generated()) writeFileSync(join(OUT, name), text);
    console.log('headers: wrote ' + [...generated().keys()].map((n) => 'deploy/nginx/' + n).join(', '));
  } else if (mode === '--check' || !mode) {
    const problems = check();
    if (problems.length) { console.error('headers: ' + problems.join('\nheaders: ')); process.exit(1); }
    console.log('headers: deploy/nginx/ is current; no third-party code, style or font is loaded from another origin');
  } else if (mode === '--print') {
    const phase = rest.includes('--phase') ? Number(rest[rest.indexOf('--phase') + 1]) : 2;
    for (const [k, v] of Object.entries(headersFor(rest[0], rest[1] || '/', { phase }))) console.log(`${k}: ${v}`);
  } else { console.error('headers: unknown mode ' + mode); process.exit(1); }
}
