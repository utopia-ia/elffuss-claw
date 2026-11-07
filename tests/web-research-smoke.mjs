// Smoke test of web.search / web.fetch on the shared research module (web/js/tools/web-research.js, a copy of
// elffuss.com's, tested there against real saved pages). Here, small pages written in this file, a fake /proxy and a
// fake /websearch, in the system Chrome; no network.
//
//   PLAYWRIGHT_MODULE=…/playwright/index.mjs node tests/web-research-smoke.mjs
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const PAGES = {
  'https://www.gatos-ejemplo.es/robots.txt': ['text/plain', 'User-agent: *\nDisallow: /privado/\n'],
  'https://www.gatos-ejemplo.es/comida/': ['text/html; charset=utf-8', `<!doctype html><html lang="es"><head><title>Qué comen los gatos</title></head><body>
    <nav><a href="/">Inicio</a> <a href="/privado/">Privado</a></nav><main><h1>Qué comen los gatos</h1>
    <h2>Proteína</h2><p>Los gatos son carnívoros estrictos: necesitan proteína animal y taurina en cada comida, porque no la fabrican ellos mismos.</p>
    <h2>Agua</h2><p>Beben poco, así que la comida húmeda les ayuda a mantenerse hidratados durante todo el día.</p>
    <h2>Historia</h2><p>${'Los gatos domésticos viven con las personas desde hace miles de años en muchos lugares del mundo. '.repeat(12)}</p></main></body></html>`],
  'https://www.gatos-ejemplo.es/privado/notas': ['text/html', '<p>nunca</p>'],
};
const SEARX = { results: [
  { url: 'https://www.gatos-ejemplo.es/comida/', title: 'Qué comen los gatos', content: 'Proteína, taurina y agua', engines: ['brave'] },
  { url: 'https://www.gatos-ejemplo.es/privado/notas', title: 'Notas', content: 'privado', engines: ['brave'] },
], answers: [], unresponsive_engines: [] };

const seen = [];
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/proxy') {
    const target = u.searchParams.get('url'); seen.push(target);
    const p = PAGES[target];
    if (!p) { res.writeHead(502, { 'X-Proxy-Error': 'upstream', 'Content-Type': 'text/plain' }).end('no'); return; }
    res.writeHead(200, { 'Content-Type': p[0], 'X-Proxy-Upstream-Status': '200' }).end(p[1]); return;
  }
  if (u.pathname === '/websearch') { seen.push('websearch:' + u.searchParams.get('q')); res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(/gatos/.test(u.searchParams.get('q')) ? SEARX : { results: [] })); return; }
  let f = normalize(join(WEB, decodeURIComponent(u.pathname)));
  if (!f.startsWith(WEB)) { res.writeHead(403).end(); return; }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json' }[extname(f)] || 'application/octet-stream' }).end(readFileSync(f));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
let fails = 0, passes = 0;
const ok = (n, c, x = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -- ' + String(x).slice(0, 400))); c ? passes++ : fails++; };
try {
  const p = await browser.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`http://127.0.0.1:${srv.address().port}/js/tools/web.js`);
  const r = await p.evaluate(async () => {
    try { localStorage.setItem('elffuss.grants', JSON.stringify(['web'])); } catch { /* Claw asks for the «web» permission */ }
    const w = await import('/js/tools/web.js');
    const s = await w.search({ query: 'site:gatos-ejemplo.es comida gatos' }, { question: '¿qué comen los gatos?' });
    const f = await w.fetchUrl({ url: 'https://www.gatos-ejemplo.es/comida/' }, { question: '¿necesitan taurina?' });
    const site = await w.search({ url: 'https://www.gatos-ejemplo.es/', query: 'comida gatos' }, { question: 'comida' });
    return { s, f, site };
  });
  ok('web.search: /websearch first, results and the passages of the page read', /Qué comen los gatos/.test(r.s) && /taurina/.test(r.s) && seen[0] === 'websearch:site:gatos-ejemplo.es comida gatos', r.s);
  ok('web.search: robots.txt asked, and the page it closes is not read', seen.includes('https://www.gatos-ejemplo.es/robots.txt') && !seen.includes('https://www.gatos-ejemplo.es/privado/notas'), seen.join(' '));
  ok('web.fetch: the passage that answers, with its heading, and how to cite', /§ Proteína[\s\S]*taurina/.test(r.f) && /\[título\]\(dirección\)|\[title\]\(address\)/.test(r.f), r.f);
  ok('a web.site-style call ({ url, query }) is a site: search', seen.includes('websearch:site:gatos-ejemplo.es comida gatos') && /Qué comen los gatos/.test(r.site), r.site);
  ok('no pageerror', errors.length === 0, errors.join(' | '));
} catch (e) { ok('the run finished', false, e.stack); }
finally { await browser.close(); srv.close(); }
console.log(`${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
