// Una descarga de modelo tiene que SOBREVIVIR a una recarga y a un corte de red.
// ─────────────────────────────────────────────────────────────────────────────
// El fallo que fija este test: con createWritable los bytes no están en el
// fichero hasta close(), y la página guardaba en partes de 1 GiB que solo se
// cerraban al llenarse. Recargar a mitad tiraba la parte en curso (medido: 262 MB
// en el .crswap, 0 B en el fichero), y el broker desplegado además BORRABA lo ya
// cerrado al volver a empezar. Con la red cortándose cada pocos minutos, el
// modelo grande no llegaba a guardarse nunca.
//
// Todo en LOCAL, sin producción ni GPU: un servidor Node sirve la app (web/ de
// este árbol), y dos orígenes más hacen de m1/m2 —página de broker y un fragmento
// sintético cada uno—, con ancho de banda limitado para poder recargar a mitad y
// con fallos inyectables (corte de conexión, 200 corto). La integridad se
// comprueba con SHA-256 de lo leído contra el fichero servido.
//
// Requiere el motor sincronizado en web/js/engine (../elffuss-engine/sync-to-claw.sh).
//
//   node tests/resume-download.mjs            (HEADED=1 para verlo)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(RAIZ, 'web');
const BROKER = readFileSync(join(RAIZ, 'server/broker/index.html'));
if (!existsSync(join(WEB, 'js/engine/provider.js'))) {
  console.error('Falta web/js/engine/: sincroniza el motor con ../elffuss-engine/sync-to-claw.sh');
  process.exit(2);
}

const MiB = 1024 * 1024;
const TRAMO = 64 * MiB;                    // lo que el broker y el almacén cierran de una vez
const RATE = +(process.env.RATE || 40) * MiB;   // bytes/s por respuesta

let fails = 0;
const ok = (n, c, e = '') => { console.log((c ? '✅' : '❌') + ' ' + n + (e ? '  — ' + e : '')); if (!c) fails++; };

// ── datos sintéticos: deterministas pero no periódicos (xorshift), para que un
//    bloque desplazado NO dé el mismo hash ─────────────────────────────────────
function sintetico(n, semilla) {
  const b = Buffer.allocUnsafe(n);
  let x = semilla >>> 0 || 1;
  let i = 0;
  for (; i + 4 <= n; i += 4) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b.writeUInt32LE(x, i); }
  for (; i < n; i++) b[i] = i & 255;
  return b;
}
const sha = b => createHash('sha256').update(b).digest('hex');
// Tamaños impares a propósito: ni múltiplos del tramo ni de la parte.
const FICHEROS = {
  '/frag0.bin': sintetico(150 * MiB + 12345, 11),
  '/frag1.bin': sintetico(140 * MiB + 777, 22),
};
FICHEROS['/cut0.bin'] = FICHEROS['/frag0.bin'];
FICHEROS['/cut1.bin'] = FICHEROS['/frag1.bin'];
FICHEROS['/short0.bin'] = FICHEROS['/frag0.bin'];
FICHEROS['/hyb0.bin'] = FICHEROS['/frag0.bin'];
FICHEROS['/hyb1.bin'] = FICHEROS['/frag1.bin'];
FICHEROS['/poison.bin'] = sintetico(3 * MiB + 5, 33);
const SINGLE = sintetico(130 * MiB + 4321, 44);
const HASH = Object.fromEntries(Object.entries(FICHEROS).map(([k, v]) => [k, sha(v)]));
const HASH_SINGLE = sha(SINGLE);

// ── el servidor: un proceso, tres orígenes ────────────────────────────────────
const registro = [];                        // {srv, path, range, status}
const enviados = {};                        // `${srv}${path}` → bytes de cuerpo enviados
const fallos = { cortarEn: {}, corto200: {}, cortarRango: {}, sinBroker: new Set() };
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html; charset=utf-8',
  '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png' };

async function servirDatos(nombre, req, res, datos, clave) {
  const total = datos.length;
  const cab = { 'accept-ranges': 'bytes', 'content-type': 'application/octet-stream',
    etag: '"' + sha(datos.subarray(0, 4096)).slice(0, 16) + '-' + total + '"',
    'last-modified': 'Tue, 29 Sep 2026 10:00:00 GMT', 'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'Content-Range, Content-Length, ETag, Last-Modified, Accept-Ranges' };
  const rango = req.headers.range;
  registro.push({ srv: nombre, path: req.url, range: rango || null });
  let desde = 0, hasta = total - 1, estado = 200;
  const m = rango && /^bytes=(\d+)-(\d*)$/.exec(rango);
  if (m) { desde = +m[1]; hasta = m[2] ? Math.min(+m[2], total - 1) : total - 1; estado = 206; }
  // 200 CORTO una vez: la respuesta dice medir 1 MiB y lo cumple, sin error de red.
  if (!m && fallos.corto200[clave]) {
    fallos.corto200[clave] = false;
    registro.at(-1).status = 'corto200';
    res.writeHead(200, { ...cab, 'content-length': MiB });
    return res.end(datos.subarray(0, MiB));
  }
  if (estado === 206) { cab['content-range'] = `bytes ${desde}-${hasta}/${total}`; }
  cab['content-length'] = hasta - desde + 1;
  res.writeHead(estado, cab);
  registro.at(-1).status = estado;
  if (req.method === 'HEAD') return res.end();
  // Corte de conexión una vez, al cruzar `cortarEn` (offset absoluto).
  const corte = fallos.cortarEn[clave];
  // Reset de UNA petición por rangos concreta (camino directo por red).
  const reset = fallos.cortarRango[clave] && estado === 206 && hasta - desde > 1 ? (fallos.cortarRango[clave] = false, true) : false;
  let pos = desde; const t0 = Date.now(); let cerrado = false;
  res.on('close', () => { cerrado = true; });
  const PASO = 256 * 1024;
  while (pos <= hasta && !cerrado) {
    const fin = Math.min(pos + PASO, hasta + 1);
    if (reset && pos - desde > PASO) { req.socket.destroy(); return; }
    if (corte && pos < corte && fin >= corte) { delete fallos.cortarEn[clave]; req.socket.destroy(); return; }
    if (!res.write(datos.subarray(pos, fin))) {
      await new Promise(r => { const f = () => { res.off('drain', f); res.off('close', f); r(); }; res.on('drain', f); res.on('close', f); });
    }
    enviados[clave] = (enviados[clave] || 0) + (fin - pos);
    pos = fin;
    // Limitar el caudal (una recarga «a mitad» necesita que haya un «a mitad»).
    const debe = (pos - desde) / RATE * 1000 - (Date.now() - t0);
    if (debe > 0) await new Promise(r => setTimeout(r, debe));
  }
  res.end();
}

function nuevoServidor(nombre, manejar) {
  const srv = createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Range',
        'access-control-allow-methods': 'GET, HEAD', 'access-control-max-age': '600' });
      return res.end();
    }
    manejar(req, res).catch(e => { try { res.destroy(e); } catch { /* — */ } });
  });
  return new Promise(r => srv.listen(0, () => r(srv)));
}
const servidorFragmentos = nombre => async (req, res) => {
  const path = req.url.replace(/[?#].*$/, '');
  if (path === '/') {
    if (fallos.sinBroker.has(nombre)) { res.writeHead(404); return res.end('no broker'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(BROKER);
  }
  if (FICHEROS[path]) return servirDatos(nombre, req, res, FICHEROS[path], nombre + path);
  res.writeHead(404); res.end();
};
const srvApp = await nuevoServidor('app', async (req, res) => {
  const path = decodeURIComponent(req.url.replace(/[?#].*$/, ''));
  if (path === '/single.bin') return servirDatos('app', req, res, SINGLE, 'app/single.bin');
  if (path === '/' || path === '/__prueba.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><meta charset="utf-8"><title>prueba</title><body>prueba de descargas</body>');
  }
  const f = normalize(join(WEB, path));
  if (!f.startsWith(WEB) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(f));
});
const srvA = await nuevoServidor('A', servidorFragmentos('A'));
const srvB = await nuevoServidor('B', servidorFragmentos('B'));
// `localhost` y NO 127.0.0.1: el broker solo acepta mensajes de http://localhost.
const APP = `http://localhost:${srvApp.address().port}`;
const OA = `http://localhost:${srvA.address().port}`;
const OB = `http://localhost:${srvB.address().port}`;

// ── el navegador: perfil propio, en disco (la OPFS de verdad, con su .crswap) ──
const PERFIL = mkdtempSync(join(tmpdir(), 'elffuss-resume-'));
const ctx = await chromium.launchPersistentContext(PERFIL, { headless: !process.env.HEADED })
  .catch(() => chromium.launchPersistentContext(PERFIL, { headless: !process.env.HEADED, channel: 'chrome' }));
const limpiar = () => { try { rmSync(PERFIL, { recursive: true, force: true }); } catch { /* — */ } };
process.on('exit', limpiar);
const page = ctx.pages()[0] || await ctx.newPage();
page.on('pageerror', e => console.log('   [pageerror]', e.message));
await page.goto(APP + '/__prueba.html');

const frags = (a, b) => [{ url: OA + a, bytes: FICHEROS[a].length }, { url: OB + b, bytes: FICHEROS[b].length }];
const espera = ms => new Promise(r => setTimeout(r, ms));
async function hasta(cond, ms, que) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await cond()) return true; await espera(50); }
  throw new Error('tiempo agotado esperando: ' + que);
}

// Arranca la apertura repartida SIN esperarla (para poder recargar a mitad).
const arrancar = (fr) => page.evaluate(async (fr) => {
  window.__prog = [];
  const eng = await import('/js/engine/provider.js');
  window.__res = eng.__abrirPorRangos(fr, p => window.__prog.push(String(p)), true)
    .then(r => ({ ok: true, r }), e => ({ ok: false, error: String(e?.message || e) }));
}, fr);

// Termina la apertura y calcula el SHA-256 de cada fragmento leído por el handle.
const terminar = (fr) => page.evaluate(async (fr) => {
  const x = await window.__res;
  if (!x.ok) return { ok: false, error: x.error, prog: window.__prog };
  const hex = b => [...new Uint8Array(b)].map(v => v.toString(16).padStart(2, '0')).join('');
  const hashes = []; let off = 0;
  for (const f of fr) {
    const buf = await x.r.ranged.slice(off, f.bytes);
    hashes.push(buf.byteLength === f.bytes ? hex(await crypto.subtle.digest('SHA-256', buf)) : 'corto:' + buf.byteLength);
    off += f.bytes;
  }
  return { ok: true, donde: x.r.donde, size: x.r.ranged.size, hashes, prog: window.__prog };
}, fr);

// Lo que el broker de un origen tiene en su almacén (vía su propio mensaje de diagnóstico).
const diag = (origen) => page.evaluate(async (origen) => {
  const f = document.createElement('iframe'); f.src = origen + '/'; document.body.appendChild(f);
  await new Promise((si, no) => { const t = setTimeout(() => no(new Error('broker sin ready')), 8000);
    addEventListener('message', function h(e) { if (e.source === f.contentWindow && e.data?.kind === 'elffuss-broker-ready') { clearTimeout(t); removeEventListener('message', h); si(); } }); });
  const r = await new Promise(si => { addEventListener('message', function h(e) { if (e.source === f.contentWindow && e.data?.kind === 'diag') { removeEventListener('message', h); si(e.data); } });
    f.contentWindow.postMessage({ type: 'elffuss-broker-diag', id: 'd' }, origen); });
  f.remove();
  return r.ficheros;
}, origen);
const pedidos = (srv, path) => registro.filter(r => r.srv === srv && r.path === path);
const cuerpos = (srv, path) => pedidos(srv, path).filter(r => r.range !== 'bytes=0-0');

// ═════ 1 · recarga a mitad del primer fragmento → reanuda desde lo guardado ═════
{
  console.log('\n· 1 · recarga a mitad de la descarga (almacén compartido, 2 fragmentos)');
  const fr = frags('/frag0.bin', '/frag1.bin');
  await arrancar(fr);
  await hasta(() => (enviados['A/frag0.bin'] || 0) >= 100 * MiB, 60000, '100 MiB del fragmento 0');
  await page.reload();
  await espera(500);
  // Medido DESPUÉS de recargar: hasta que la recarga surte efecto sigue llegando.
  const alRecargar = enviados['A/frag0.bin'];
  const antes = cuerpos('A', '/frag0.bin').length;
  await arrancar(fr);
  const r = await terminar(fr);
  ok('carga completa tras la recarga', r.ok, r.error || r.donde);
  const tras = cuerpos('A', '/frag0.bin').slice(antes);
  const rango = tras[0]?.range || '';
  const desde = +(/bytes=(\d+)-/.exec(rango)?.[1] || 0);
  ok('la 2.ª petición del fragmento 0 pide SOLO el resto (Range desde lo guardado)',
    desde > 0 && desde % TRAMO === 0 && desde <= alRecargar, `${rango || 'sin Range'} · al recargar iban ${(alRecargar / MiB).toFixed(0)} MiB enviados`);
  const trasRecarga = enviados['A/frag0.bin'] - alRecargar;
  ok('tras recargar no se vuelve a bajar entero (al menos un tramo se conservó)',
    trasRecarga < FICHEROS['/frag0.bin'].length - TRAMO + 8 * MiB,
    `${(trasRecarga / MiB).toFixed(0)} MiB servidos tras recargar, de un fragmento de ${(FICHEROS['/frag0.bin'].length / MiB).toFixed(0)} MiB`);
  ok('la barra dice «reanudando desde N %»', (r.prog || []).some(p => /reanudando desde \d+ %/.test(p)),
    (r.prog || []).find(p => /reanudando/.test(p)) || 'ningún mensaje de reanudación');
  ok('SHA-256 de los dos fragmentos idéntico al servido',
    r.ok && r.hashes[0] === HASH['/frag0.bin'] && r.hashes[1] === HASH['/frag1.bin'], r.hashes?.map(h => h.slice(0, 12)).join(' '));
  ok('viene del almacén, no de la red', /^almacén compartido/.test(r.donde || ''), r.donde);
  const fa = await diag(OA);
  ok('en el almacén queda la marca .done y ninguna huella .parte',
    fa.some(n => n.includes('frag0.bin.done')) && !fa.some(n => n.includes('frag0.bin.parte')), fa.filter(n => n.includes('frag0')).join(' '));

  // Segunda carga: ni un byte de red.
  const n0 = registro.length;
  await page.reload();
  await arrancar(fr);
  const r2 = await terminar(fr);
  const nuevos = registro.slice(n0).filter(x => /frag[01]\.bin/.test(x.path));
  ok('la segunda carga no toca la red', r2.ok && nuevos.length === 0, `${nuevos.length} peticiones · ${r2.donde || r2.error}`);
}

// ═════ 2 · la red se corta a mitad (sin recargar) → el broker reintenta solo ═════
{
  console.log('\n· 2 · corte de conexión a mitad del fragmento 1');
  await page.reload();
  const fr = frags('/cut0.bin', '/cut1.bin');
  const CORTE = 90 * MiB + 4096;
  fallos.cortarEn['B/cut1.bin'] = CORTE;
  await arrancar(fr);
  const r = await terminar(fr);
  ok('carga completa pese al corte', r.ok, r.error || r.donde);
  ok('sigue viniendo del almacén (no cae a leer por red)', /^almacén compartido/.test(r.donde || ''), r.donde);
  const cs = cuerpos('B', '/cut1.bin');
  const rango = cs[1]?.range || '';
  const desde = +(/bytes=(\d+)-/.exec(rango)?.[1] || 0);
  ok('tras el corte pide desde CASI el punto del corte (la parte a medias se conservó)',
    cs.length === 2 && desde > TRAMO && desde <= CORTE && CORTE - desde < 16 * MiB, `${cs.length} peticiones de cuerpo · ${rango || '—'} · corte en ${CORTE}`);
  ok('la barra avisa del reintento', (r.prog || []).some(p => /reintentando \(1\)/.test(p)),
    (r.prog || []).find(p => /reintent/.test(p)) || 'sin aviso');
  ok('SHA-256 idéntico', r.ok && r.hashes[0] === HASH['/cut0.bin'] && r.hashes[1] === HASH['/cut1.bin'], r.hashes?.map(h => h.slice(0, 12)).join(' '));
}

// ═════ 3 · un 200 CORTO no se guarda como completo ═════
{
  console.log('\n· 3 · respuesta 200 corta (1 MiB) sin error de red');
  await page.reload();
  const fr = frags('/short0.bin', '/frag1.bin');
  fallos.corto200['A/short0.bin'] = true;
  await arrancar(fr);
  const r = await terminar(fr);
  ok('carga completa (se reanudó tras el corto)', r.ok && /^almacén compartido/.test(r.donde || ''), r.error || r.donde);
  ok('SHA-256 idéntico', r.ok && r.hashes[0] === HASH['/short0.bin'], r.hashes?.[0]?.slice(0, 12));
  const cs = cuerpos('A', '/short0.bin');
  ok('primero el 200 corto y luego un Range desde 1 MiB', cs[0]?.status === 'corto200' && cs[1]?.range === `bytes=${MiB}-`,
    cs.map(c => `${c.status}:${c.range || '-'}`).join(' '));
}

// ═════ 4 · una copia envenenada de una versión anterior se descarta ═════
{
  console.log('\n· 4 · marca .done de una versión anterior que no mide lo que debe');
  // Estado que dejaba el broker viejo tras un 200 corto: .done {size:1MiB} + p0 de 1 MiB.
  const pg = await ctx.newPage();
  await pg.goto(OA + '/');
  await pg.evaluate(async u => {
    const k = String(u).replace(/[?#].*$/, '').replace(/[^\w.\-]+/g, '_').slice(-180);
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('elffuss-models', { create: true });
    const esc = async (n, b) => { const w = await (await d.getFileHandle(n, { create: true })).createWritable(); await w.write(b); await w.close(); };
    await esc(k + '.p0', new Uint8Array(1048576));
    await esc(k + '.done', new TextEncoder().encode(JSON.stringify({ size: 1048576, parts: 1 })));
  }, OA + '/poison.bin');
  await pg.close();
  const n = FICHEROS['/poison.bin'].length;
  const r = await page.evaluate(async ({ u, n }) => {
    const { getSharedModel } = await import('/js/runtime/model-broker.js');
    const f = await getSharedModel(u, () => {}, null, { bytes: n });
    const hex = b => [...new Uint8Array(b)].map(v => v.toString(16).padStart(2, '0')).join('');
    return { size: f.size, hash: hex(await crypto.subtle.digest('SHA-256', await f.arrayBuffer())) };
  }, { u: OA + '/poison.bin', n }).catch(e => ({ error: String(e.message || e) }));
  ok('con el tamaño esperado, la copia corta se tira y se vuelve a bajar',
    r.size === n && r.hash === HASH['/poison.bin'], r.error || `${r.size} B`);
}

// ═════ 5 · almacén local (un solo fichero, OPFS de la app) ═════
{
  console.log('\n· 5 · modelo de un solo fichero en la OPFS de la app: recarga a mitad');
  await page.reload();
  const u = APP + '/single.bin';
  const lanzar = () => page.evaluate(async (u) => {
    // Como en tests/modelparts.mjs: sin esto se intentaría el broker primero.
    sessionStorage.setItem('elffuss.broker.down', '1');
    window.__prog = [];
    const st = await import('/js/runtime/model-store.js');
    window.__res = st.getModelParts(u, p => window.__prog.push(String(p)))
      .then(p => ({ ok: true, p }), e => ({ ok: false, error: String(e?.message || e) }));
  }, u);
  await lanzar();
  await hasta(() => (enviados['app/single.bin'] || 0) >= 100 * MiB, 60000, '100 MiB del fichero único');
  await page.reload();
  await espera(500);
  // Medido DESPUÉS de recargar: hasta que la recarga surte efecto sigue llegando.
  const alRecargar = enviados['app/single.bin'];
  const antes = cuerpos('app', '/single.bin').length;
  await lanzar();
  const r = await page.evaluate(async () => {
    const x = await window.__res;
    if (!x.ok) return { ok: false, error: x.error, prog: window.__prog };
    const b = new Blob(x.p);
    const hex = v => [...new Uint8Array(v)].map(c => c.toString(16).padStart(2, '0')).join('');
    return { ok: true, n: x.p.length, size: b.size, hash: hex(await crypto.subtle.digest('SHA-256', await b.arrayBuffer())), prog: window.__prog };
  });
  const rango = cuerpos('app', '/single.bin').slice(antes)[0]?.range || '';
  const desde = +(/bytes=(\d+)-/.exec(rango)?.[1] || 0);
  ok('carga completa', r.ok, r.error || `${r.n} partes`);
  // Aquí no tiene por qué ser múltiplo del tramo: la página de la app a veces
  // alcanza a CERRAR la parte en curso al descargarse (el fetch se aborta, salta
  // el catch y close() confirma). Lo que importa es que no empiece de cero ni
  // pida más allá de lo que llegó; la integridad la dice el hash.
  ok('reanuda con Range desde lo guardado', desde >= TRAMO && desde <= alRecargar,
    `${rango || 'sin Range'} · al recargar iban ${(alRecargar / MiB).toFixed(0)} MiB`);
  ok('la barra dice «reanudando desde N %»', (r.prog || []).some(p => /reanudando desde \d+ %/.test(p)),
    (r.prog || []).find(p => /reanudando/.test(p)) || '—');
  ok('SHA-256 idéntico', r.hash === HASH_SINGLE, (r.hash || '').slice(0, 12));
}

// ═════ 6 · un broker no disponible: lo guardado se usa y solo lo que falta va por red ═════
{
  console.log('\n· 6 · broker del fragmento 1 caído + una conexión reseteada en el camino directo');
  await page.reload();
  fallos.sinBroker.add('B');
  fallos.cortarRango['B/hyb1.bin'] = true;
  const fr = frags('/hyb0.bin', '/hyb1.bin');
  await arrancar(fr);
  const r = await terminar(fr);
  fallos.sinBroker.delete('B');
  ok('carga completa', r.ok, r.error || r.donde);
  ok('el fragmento 0 del almacén y el 1 de la red', /almacén \(1\) \+ red \(1\)/.test(r.donde || ''), r.donde);
  ok('SHA-256 idéntico (incluido el rango reintentado)', r.ok && r.hashes[0] === HASH['/hyb0.bin'] && r.hashes[1] === HASH['/hyb1.bin'],
    r.hashes?.map(h => h.slice(0, 12)).join(' '));
}

// ═════ 7 · el mensaje de error ya no culpa al disco de un corte de red ═════
{
  console.log('\n· 7 · mensajes de error');
  const r = await page.evaluate(async () => {
    const eng = await import('/js/engine/provider.js');
    const m = { label: 'Bonsai 27B', bytes: 7206168928 };
    return {
      red: eng.__mensajeHumano(new TypeError('Failed to fetch'), m),
      red2: eng.__mensajeHumano(new TypeError('network error'), m),
      cuota: eng.__mensajeHumano(new DOMException('The operation failed because it would cause the application to exceed its storage quota.', 'QuotaExceededError'), m),
    };
  });
  ok('«Failed to fetch» se explica como red, no como disco', /problema de red/.test(r.red) && !/espacio en disco/.test(r.red), r.red);
  ok('«network error» también', /problema de red/.test(r.red2) && !/espacio en disco/.test(r.red2), r.red2);
  ok('la cuota sí habla de espacio', /No cabe/.test(r.cuota), r.cuota);
}

await ctx.close();
srvApp.close(); srvA.close(); srvB.close();
console.log(fails ? `\n❌ ${fails} FALLO(S)` : '\n✅ DESCARGA REANUDABLE OK');
process.exit(fails ? 1 : 0);
