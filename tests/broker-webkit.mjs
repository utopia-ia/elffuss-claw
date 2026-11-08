// El broker de modelos (server/broker/index.html) en WebKit DE VERDAD, con su OPFS de verdad.
// ─────────────────────────────────────────────────────────────────────────────
// El fallo (iPhone, Safari 26, 8-nov): WebKit escribe con write(vista) el ArrayBuffer ENTERO de la vista. El broker
// reparte cada trozo de red entre partes de 16 MiB con subarray, así que todo fichero de más de un tramo salía más
// largo («llegaron 24943062 de 23201314 bytes») y no cargaba ningún modelo de voz.
//
// Aquí: la página real del broker en https://models.elffuss.com/, embebida desde https://elffuss.com/, baja un fichero
// de 20 MiB + 4.321 bytes de https://m1.elffuss.com/ (con Range). En el iframe del broker, un script de prueba hace que
// cada trozo del cuerpo sea una VISTA dentro de un buffer mayor (desplazada y con cola), como puede darlo la red.
//   · la descarga sale entera y con el mismo SHA-256, a través de la frontera de 16 MiB
//   · unas partes de la página de antes (un tramo con bytes de más) con su marcador de reanudar: se tiran y se baja
//     desde cero, no se empalma detrás (daría el tamaño justo con el contenido mal)
// Los hosts llegan a un servidor local por un proxy CONNECT (WebKit no tiene reglas de resolución); certificado propio.
//
//   PLAYWRIGHT_BROWSERS_PATH=<navegadores> node tests/broker-webkit.mjs        (BROKER_FILE=<otra página> para comparar)
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const { webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const PAGINA = readFileSync(process.env.BROKER_FILE || join(RAIZ, 'server/broker/index.html'));
let fails = 0;
const ok = (n, c, e = '') => { console.log((c ? '✅' : '❌') + ' ' + n + (e ? '  — ' + e : '')); if (!c) fails++; };

const MiB = 1024 * 1024;
const TAM = 20 * MiB + 4321;
const DATOS = Buffer.alloc(TAM);
{ let x = 7; for (let i = 0; i < TAM; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; DATOS[i] = x >> 16; } }
const SHA = createHash('sha256').update(DATOS).digest('hex');
const URLF = 'https://m1.elffuss.com/prueba/modelo.bin';

// ── certificado y servidor ───────────────────────────────────────────────────
const HOSTS = ['elffuss.com', 'models.elffuss.com', 'm1.elffuss.com'];
const dir = mkdtempSync(join(tmpdir(), 'broker-wk-'));
writeFileSync(join(dir, 'san.cnf'), ['[req]', 'distinguished_name=dn', 'x509_extensions=ext', 'prompt=no', '[dn]', 'CN=broker.test', '[ext]',
  `subjectAltName=${HOSTS.map((h) => 'DNS:' + h).join(',')}`].join('\n'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '2', '-config', join(dir, 'san.cnf')], { stdio: 'ignore' });
const peticiones = [];
const PADRE = `<!doctype html><meta charset="utf-8"><body><script>
  window.pedir = (msg) => new Promise((res) => {
    const id = Math.random(); const msgs = [];
    const h = (e) => { if (e.origin !== 'https://models.elffuss.com' || e.data?.id !== id) return; msgs.push(e.data);
      if (['file', 'error'].includes(e.data.kind)) { removeEventListener('message', h); res(e.data.kind === 'file' ? e.data.file : e.data); } };
    addEventListener('message', h);
    document.querySelector('iframe').contentWindow.postMessage({ ...msg, id }, 'https://models.elffuss.com');
  });
  window.sha = async (f) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await f.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('');
  window.listo = new Promise((r) => addEventListener('message', (e) => { if (e.data?.kind === 'elffuss-broker-ready') r(true); }));
</script><iframe src="https://models.elffuss.com/"></iframe>`;
const srv = https.createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (req, res) => {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  const path = new URL(req.url, 'https://x').pathname;
  if (host === 'elffuss.com') { res.writeHead(200, { 'Content-Type': 'text/html' }).end(PADRE); return; }
  if (host === 'models.elffuss.com' && path === '/') { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' }).end(PAGINA); return; }
  if (host === 'm1.elffuss.com' && path === '/prueba/modelo.bin') {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, ETag', 'Accept-Ranges': 'bytes', ETag: '"v1"', 'Content-Type': 'application/octet-stream' };
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'Access-Control-Allow-Headers': 'Range' }).end(); return; }
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    peticiones.push(req.headers.range || 'entero');
    if (!m) { res.writeHead(200, { ...cors, 'Content-Length': TAM }).end(DATOS); return; }
    const a = +m[1], b = m[2] ? Math.min(+m[2], TAM - 1) : TAM - 1;
    res.writeHead(206, { ...cors, 'Content-Range': `bytes ${a}-${b}/${TAM}`, 'Content-Length': b - a + 1 }).end(DATOS.subarray(a, b + 1));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const proxy = http.createServer((q, s) => s.writeHead(502).end());
proxy.on('connect', (req, sock, head) => {
  sock.on('error', () => {});
  if (!HOSTS.includes(String(req.url).split(':')[0])) { sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
  const up = net.connect(srv.address().port, '127.0.0.1', () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head?.length) up.write(head); up.pipe(sock); sock.pipe(up); });
  up.on('error', () => sock.destroy());
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

// En el iframe del broker: cada trozo del cuerpo de la descarga, una vista dentro de un buffer mayor.
const vistas = () => {
  if (location.hostname !== 'models.elffuss.com') return;
  const f0 = fetch;
  globalThis.fetch = async (...a) => {
    const r = await f0(...a);
    if (!r.body || !/modelo\.bin/.test(String(a[0]))) return r;
    const lector = r.body.getReader();
    const body = new ReadableStream({ async pull(c) {
      const { done, value } = await lector.read();
      if (done) { c.close(); return; }
      for (let off = 0; off < value.byteLength; off += 700001) {
        const n = Math.min(700001, value.byteLength - off);
        const grande = new Uint8Array(n + 4096); grande.set(value.subarray(off, off + n), 3);
        c.enqueue(new Uint8Array(grande.buffer, 3, n));
      }
    } });
    return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
  };
};

const ctx = await webkit.launchPersistentContext(mkdtempSync(join(tmpdir(), 'broker-wk-perfil-')), {
  ignoreHTTPSErrors: true, proxy: { server: `http://127.0.0.1:${proxy.address().port}` },
});
try {
  await ctx.addInitScript(vistas);
  const p = ctx.pages()[0] || await ctx.newPage();
  await p.goto('https://elffuss.com/');
  ok('la página del broker arranca en WebKit', await Promise.race([p.evaluate(() => window.listo), new Promise((r) => setTimeout(() => r(false), 15000))]));

  // 1) descarga de más de un tramo, con trozos que son vistas
  const r1 = await p.evaluate(async ([url, bytes]) => { const f = await window.pedir({ type: 'elffuss-model-get', url, bytes }); return f instanceof Blob ? { size: f.size, sha: await window.sha(f) } : f; }, [URLF, TAM]);
  ok('WebKit, 20 MiB en trozos que son vistas: llega entero', r1?.size === TAM, JSON.stringify(r1).slice(0, 300));
  ok('…y con el mismo SHA-256', r1?.sha === SHA);

  // 2) partes de la página de antes: un tramo con bytes de más y el marcador de reanudar. Se escriben en la OPFS del
  //    broker desde su propio iframe.
  const broker = p.frames().find((f) => f.url().startsWith('https://models.elffuss.com/'));
  await broker.evaluate(async ([url, total]) => {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('elffuss-models', { create: true });
    const k = String(url).replace(/[?#].*$/, '').replace(/[^\w.\-]+/g, '_').slice(-180);
    for (const n of [k + '.done', k + '.p0', k + '.p1']) await d.removeEntry(n).catch(() => {});
    const esc = async (n, bytes) => { const w = await (await d.getFileHandle(n, { create: true })).createWritable(); await w.write(bytes); await w.close(); };
    await esc(k + '.p0', new Uint8Array(16 * 1024 * 1024 + 700001));     // un tramo con un trozo de más
    await esc(k + '.p1', new Uint8Array(1000));
    await esc(k + '.parte', new TextEncoder().encode(JSON.stringify({ total, v: '"v1"' })));
  }, [URLF, TAM]);
  peticiones.length = 0;
  const r2 = await p.evaluate(async ([url, bytes]) => { const f = await window.pedir({ type: 'elffuss-model-get', url, bytes }); return f instanceof Blob ? { size: f.size, sha: await window.sha(f) } : f; }, [URLF, TAM]);
  ok('partes de antes con bytes de más: no se empalma detrás, se baja desde cero', !peticiones.some((x) => /^bytes=[1-9]/.test(x)), peticiones.join(' | '));
  ok('…y sale entero y exacto', r2?.size === TAM && r2?.sha === SHA, JSON.stringify(r2).slice(0, 300));
} finally {
  await ctx.close();
  proxy.close(); srv.close(); srv.closeAllConnections?.();
}
console.log(fails ? `\n${fails} FALLO(S)` : '\nTodo en verde');
process.exit(fails ? 1 : 0);
