// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Servidor HTTPS local para la prueba de la memoria compartida (memoria-v2.mjs).
// Contesta como los hosts DE VERDAD, elegidos por la cabecera Host, para que las
// páginas corran con sus orígenes de producción: el navegador se apunta aquí con
// --host-resolver-rules y acepta el certificado de prueba solo para estos hosts.
//
//   claw.elffuss.com   este repo (web/); la ruta /memory/ con las cabeceras de
//                      server/memory/headers.conf (las que se despliegan, leídas
//                      de ese fichero, no copiadas aquí), y un modelo de mentira
//                      compatible con OpenAI en /fake-llm/v1 (el «cerebro» guionado)
//   elffuss.com        una app mínima que usa la memoria como el chat (tests/memoria-v2/)
//   code.elffuss.com   la misma app, como Code
//   blog.elffuss.com   mismo sitio pero NO está en la lista: no debe obtener nada
//   evil.test          otro sitio
//
// Las apps de prueba cargan el motor y la configuración de Claw desde su propio
// origen (/js/engine/, /memory/memory.config.js), como los copian el chat y Code.
import https from 'node:https';
import { readFileSync, existsSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const WEB = join(AQUI, '..', 'web');
const FIX = join(AQUI, 'memoria-v2');
export const HOSTS = ['claw.elffuss.com', 'elffuss.com', 'code.elffuss.com', 'blog.elffuss.com', 'evil.test'];
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json' };

// Las cabeceras de la página almacén, leídas del fragmento de nginx que se despliega.
export function cabecerasAlmacen() {
  const conf = readFileSync(join(AQUI, '..', 'server', 'memory', 'headers.conf'), 'utf8');
  const h = {};
  for (const m of conf.matchAll(/add_header\s+([\w-]+)\s+"([^"]*)"\s+always;/g)) h[m[1]] = m[2];
  return h;
}

export function certificado(dir = mkdtempSync(join(tmpdir(), 'memoria-v2-'))) {
  const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem'), conf = join(dir, 'san.cnf');
  writeFileSync(conf, ['[req]', 'distinguished_name=dn', 'x509_extensions=ext', 'prompt=no', '[dn]', 'CN=memoria-v2.test',
    '[ext]', `subjectAltName=${HOSTS.map((x) => 'DNS:' + x).join(',')}`, 'basicConstraints=CA:FALSE',
    'keyUsage=digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth'].join('\n'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-config', conf], { stdio: 'ignore' });
  const pub = execFileSync('openssl', ['x509', '-in', cert, '-pubkey', '-noout']);
  const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'der'], { input: pub });
  const spki = execFileSync('openssl', ['dgst', '-sha256', '-binary'], { input: der }).toString('base64');
  return { key: readFileSync(key), cert: readFileSync(cert), spki };
}

// ── El cerebro guionado (OpenAI-compatible, en streaming) ────────────────────
// Lee la conversación y decide qué haría un modelo: se guía por lo que pide el
// ÚLTIMO mensaje del usuario y por cuántos resultados de herramienta van detrás.
//   · «recuerda que vivo en X»            → memory.save {fact: «Vive en X»}
//   · «[contamina] recuerda que …»        → app.list primero y DESPUÉS memory.save
//   · «olvida dónde vivo»                 → memory.forget {query: «vive»}
//   · «[hostil] …»                        → memory.save de algo que el usuario NO dijo
//   · cualquier otra cosa, o tras el último resultado → «Vale.»
function guion(messages) {
  const sinEfimeros = messages.filter((m) => !(m.role === 'user' && /^CONTEXTO AHORA/.test(m.content)));
  let i = sinEfimeros.length - 1, resultados = 0;
  while (i >= 0 && (sinEfimeros[i].role !== 'user' || sinEfimeros[i].content.startsWith('[resultado'))) {
    if (sinEfimeros[i].role === 'user') resultados++;
    i--;
  }
  const u = i >= 0 ? sinEfimeros[i].content : '';
  const llamada = (tool, args) => '```tool\n' + JSON.stringify({ tool, args }) + '\n```';
  if (/^\[contamina\]/.test(u)) {
    if (resultados === 0) return llamada('app.list', {});
    if (resultados === 1) return llamada('memory.save', { fact: 'Le gusta el té verde' });
    return 'Vale.';
  }
  if (resultados > 0) return 'Hecho.';
  if (/^\[hostil\]/.test(u)) return llamada('memory.save', { fact: 'Su contraseña del banco es 4321' });
  let m = /recuerda que vivo en ([\p{L} ]+)/iu.exec(u);
  if (m) return llamada('memory.save', { fact: 'Vive en ' + m[1].trim() });
  m = /recuerda que (.+)/iu.exec(u);
  if (m) return llamada('memory.save', { fact: m[1].trim() });
  if (/olvida d[oó]nde vivo/iu.test(u)) return llamada('memory.forget', { query: 'vive' });
  return 'Vale.';
}

export async function arrancar({ puerto = 0, cert = certificado() } = {}) {
  const cabeceras = cabecerasAlmacen();
  const peticiones = [];       // { host, method, path, query }
  const llm = [];              // cuerpos recibidos por el cerebro guionado
  const server = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    const url = new URL(req.url, 'https://local.test');
    peticiones.push({ host, method: req.method, path: url.pathname, query: url.search });
    if (!HOSTS.includes(host)) { res.writeHead(421).end(); return; }
    if (host === 'claw.elffuss.com' && url.pathname === '/fake-llm/v1/chat/completions') {
      let cuerpo = '';
      req.on('data', (c) => { cuerpo += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(cuerpo); } catch { /* — */ }
        llm.push(body);
        const texto = guion(body.messages || []);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: texto } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return;
    }
    let raiz = WEB, ruta = url.pathname;
    if (host !== 'claw.elffuss.com') {
      // Las apps de prueba: el motor y la config de Claw desde su propio origen; lo demás, del fixture.
      if (!(ruta.startsWith('/js/engine/') || ruta === '/memory/memory.config.js')) raiz = FIX;
    }
    let file = normalize(join(raiz, decodeURIComponent(ruta)));
    if (!file.startsWith(raiz)) { res.writeHead(403).end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
    const h = { 'Content-Type': TIPOS[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    if (host === 'claw.elffuss.com' && url.pathname.startsWith('/memory/')) Object.assign(h, cabeceras);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await arrancar({ puerto: +process.argv[2] || 8445 });
  console.log(`https://127.0.0.1:${s.port} como ${HOSTS.join(', ')}`);
  console.log(s.args.join(' '));
}
