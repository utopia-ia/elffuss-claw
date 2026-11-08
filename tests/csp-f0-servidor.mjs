// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// HTTPS server for tests/csp-f0.mjs: answers as the REAL hosts, chosen by the Host header, with the headers the
// deploy sends (deploy/headers.json through deploy/headers.mjs, the same values as the nginx snippets), so the pages
// run under their production policies with their production origins. Chrome is pointed here with
// --host-resolver-rules and accepts the test certificate only for these hosts; every other host fails to resolve, and
// the test records each request so a call to a CDN would show.
//
//   claw.elffuss.com    this repository's web/ (the /memory/ page with server/memory/headers.conf), a scripted model
//                       compatible with OpenAI at /fake-llm/v1, and /proxy and /websearch that answer 503
//   models.elffuss.com  the model store (server/broker/index.html and sw.js) with its policy
//   elffuss.com         a page that embeds Claw's bridge (/bridge.html) and Claw itself (the apps panel), as the chat does
//   evil.test           a page of another site that tries to frame Claw, the bridge and the sandbox page
import https from 'node:https';
import { readFileSync, existsSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headersFor } from '../deploy/headers.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');
const WEB = join(RAIZ, 'web');
export const HOSTS = ['claw.elffuss.com', 'models.elffuss.com', 'elffuss.com', 'evil.test'];
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain',
  '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.webp': 'image/webp' };

// A test certificate for exactly these hosts (as tests/memoria-v2-servidor.mjs does for its own).
function certificadoDe(dir = mkdtempSync(join(tmpdir(), 'csp-f0-'))) {
  const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem'), conf = join(dir, 'san.cnf');
  writeFileSync(conf, ['[req]', 'distinguished_name=dn', 'x509_extensions=ext', 'prompt=no', '[dn]', 'CN=csp-f0.test',
    '[ext]', `subjectAltName=${HOSTS.map((x) => 'DNS:' + x).join(',')}`, 'basicConstraints=CA:FALSE',
    'keyUsage=digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth'].join('\n'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-config', conf], { stdio: 'ignore' });
  const pub = execFileSync('openssl', ['x509', '-in', cert, '-pubkey', '-noout']);
  const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'der'], { input: pub });
  const spki = execFileSync('openssl', ['dgst', '-sha256', '-binary'], { input: der }).toString('base64');
  return { key: readFileSync(key), cert: readFileSync(cert), spki };
}

// The memory store's headers, read from the nginx snippet that is deployed.
function cabecerasAlmacen() {
  const conf = readFileSync(join(RAIZ, 'server', 'memory', 'headers.conf'), 'utf8');
  const h = {};
  for (const m of conf.matchAll(/add_header\s+([\w-]+)\s+"([^"]*)"\s+always;/g)) h[m[1]] = m[2];
  return h;
}

// The app the scripted model creates: its inline script must run (in /sandbox/run.html) and say so.
export const APP_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>reloj</title></head><body>' +
  '<div id="t">…</div><script>document.getElementById("t").textContent = "corre-" + (40 + 2);' +
  'document.body.dataset.ok = "1"; parent.postMessage({ cspf0: "app-ran", origin: String(window.origin) }, "*");</script></body></html>';

// The scripted model: «hazme un reloj» → app.create; «recuerda que …» → memory.save; after a tool result, «Hecho.».
function guion(messages) {
  const sin = messages.filter((m) => !(m.role === 'user' && /^CONTEXTO AHORA/.test(m.content)));
  let i = sin.length - 1, resultados = 0;
  while (i >= 0 && (sin[i].role !== 'user' || String(sin[i].content).startsWith('[resultado'))) { if (sin[i].role === 'user') resultados++; i--; }
  const u = i >= 0 ? String(sin[i].content) : '';
  const llamada = (tool, args) => '```tool\n' + JSON.stringify({ tool, args }) + '\n```';
  if (resultados > 0) return 'Hecho.';
  if (/hazme un reloj/i.test(u)) return llamada('app.create', { name: 'reloj', html: APP_HTML });
  const m = /recuerda que (.+)/iu.exec(u);
  if (m) return llamada('memory.save', { fact: m[1].trim() });
  return 'Vale, sin herramientas: esto es una respuesta guionada.';
}

const PAGINAS = {
  'elffuss.com': `<!doctype html><meta charset="utf-8"><title>chat (prueba)</title><body>
<iframe id="b" src="https://claw.elffuss.com/bridge.html" style="display:none"></iframe>
<iframe id="app" src="https://claw.elffuss.com/" allow="microphone; camera" style="width:1200px;height:800px"></iframe>
<script>
window.puente = new Promise((ok) => {
  addEventListener('message', (e) => {
    if (e.origin !== 'https://claw.elffuss.com' || !e.data || e.data.kind !== 'elffuss-bridge') return;
    if (e.data.op === 'ready') document.getElementById('b').contentWindow.postMessage({ kind: 'elffuss-bridge', v: 1, id: 'x1', op: 'apps.list', args: {} }, 'https://claw.elffuss.com');
    else if (e.data.id === 'x1') ok(e.data);
  });
});
</script>`,
  'evil.test': `<!doctype html><meta charset="utf-8"><title>otro sitio</title><body>
<iframe id="claw" src="https://claw.elffuss.com/"></iframe>
<iframe id="bridge" src="https://claw.elffuss.com/bridge.html"></iframe>
<iframe id="sbx" src="https://claw.elffuss.com/sandbox/run.html?n=1"></iframe>
<iframe id="store" src="https://models.elffuss.com/"></iframe>`,
};

export async function arrancar({ puerto = 0, cert = certificadoDe(), phase = 2 } = {}) {
  const almacen = cabecerasAlmacen();
  const peticiones = [];
  const llm = [];
  const server = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    const url = new URL(req.url, 'https://local.test');
    peticiones.push({ host, method: req.method, path: url.pathname });
    if (!HOSTS.includes(host)) { res.writeHead(421).end(); return; }
    if (PAGINAS[host]) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGINAS[host]); return; }
    if (host === 'claw.elffuss.com' && url.pathname === '/fake-llm/v1/chat/completions') {
      let cuerpo = '';
      req.on('data', (c) => { cuerpo += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(cuerpo); } catch { /* — */ }
        llm.push(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: guion(body.messages || []) } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
      return;
    }
    if (host === 'claw.elffuss.com' && (url.pathname === '/proxy' || url.pathname.startsWith('/websearch'))) {
      res.writeHead(503, { 'Content-Type': 'text/plain' }).end('no backend in this test'); return;
    }
    let raiz = WEB, ruta = decodeURIComponent(url.pathname);
    if (host === 'models.elffuss.com') { raiz = join(RAIZ, 'server', 'broker'); }
    let file = normalize(join(raiz, ruta));
    if (!file.startsWith(raiz)) { res.writeHead(403).end(); return; }
    // nginx's `index`: a directory is answered by its index.html, and the map sees that path ($uri).
    let uri = ruta;
    if (existsSync(file) && statSync(file).isDirectory()) { file = join(file, 'index.html'); uri = ruta.replace(/\/?$/, '/') + 'index.html'; }
    const site = host === 'models.elffuss.com' ? 'models.elffuss.com' : 'claw.elffuss.com';
    let h = uri.startsWith('/memory/') && site === 'claw.elffuss.com' ? { ...almacen } : headersFor(site, uri, { phase });
    if (!existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain', ...h }).end('not found'); return; }
    h = { 'Content-Type': TIPOS[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...h };
    res.writeHead(200, h);
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(puerto, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port, spki: cert.spki, peticiones, llm,
    args: [`--host-resolver-rules=${HOSTS.map((x) => `MAP ${x} 127.0.0.1:${port}`).join(', ')}, MAP * ~NOTFOUND`,
      `--ignore-certificate-errors-spki-list=${cert.spki}`],
    cerrar: () => new Promise((r) => server.close(r)),
  };
}
