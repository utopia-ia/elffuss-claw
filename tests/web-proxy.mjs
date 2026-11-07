// web.fetch y web.search frente al proxy endurecido (server/serve.py): lo que
// el proxy dice en sus cabeceras llega al agente, y la página anti-bot de
// DuckDuckGo (un 202) es un bloqueo, no «Sin resultados».
//
// Sin red: arranca su propio serve.py en un puerto libre y corta todo lo que
// no sea ese servidor. Lo que se le pide de verdad a /proxy son destinos que
// rechaza ANTES de conectar a nada; el resto de respuestas del proxy se
// simulan con las mismas cabeceras que pone serve.py (tests/test_proxy.py
// comprueba que las pone).
//
//   cd tests && node web-proxy.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const SERVE = fileURLToPath(new URL('../server/serve.py', import.meta.url));
let fails = 0;
const ok = (n, c, e = '') => { console.log((c ? '✅' : '❌') + ' ' + n + (e ? '  — ' + String(e).slice(0, 240) : '')); if (!c) fails++; };

const libre = () => new Promise((res, rej) => {
  const s = net.createServer().once('error', rej).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});
const port = await libre();
const BASE = `http://127.0.0.1:${port}`;
const server = spawn('python3', [SERVE, String(port)], {
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ELFFUSS_BIND: '127.0.0.1' }, stdio: ['ignore', 'ignore', 'ignore'],
});
const parar = () => { try { server.kill(); } catch { /* */ } };
process.on('exit', parar);
for (let i = 0; ; i++) {
  try { if ((await fetch(BASE + '/robots.txt')).ok) break; } catch { /* aún arrancando */ }
  if (i > 100) { console.log('❌ serve.py no arrancó'); process.exit(1); }
  await new Promise(r => setTimeout(r, 100));
}

const DDG_OK = '<html><body><table><tr><td><a href="/l/?uddg=https%3A%2F%2Fejemplo.org%2Fhistoria-del-reloj&rut=x">Historia del reloj</a> Un repaso a la historia del reloj.</td></tr></table></body></html>';
// La página que DuckDuckGo le da a un servidor que le parece un bot (con un 202).
const DDG_ANTIBOT = '<html><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div><form id="challenge-form" action="//duckduckgo.com/anomaly.js"></form></body></html>';
const DDG_202_SIN_TEXTO = '<html><body><p>Procesando…</p></body></html>';

// Cómo contesta el «proxy» según la url pedida: null = que conteste el serve.py de verdad.
const P = (status, headers, body = '') => ({ status, headers, body });
let ddg = 'ok';
function respuestaProxy(pedida) {
  if (pedida.startsWith('http://127.0.0.1:1/')) return null;   // de verdad: forbidden-port
  if (pedida.startsWith('https://caducado.ejemplo/'))
    return P(502, { 'X-Proxy-Error': 'tls' }, 'fallo TLS con la web (SSLCertVerificationError)\n');
  if (pedida.startsWith('https://sin-pagina.ejemplo/')) return P(404, { 'X-Proxy-Upstream-Status': '404' }, 'Not Found');
  if (pedida.startsWith('https://prohibe.ejemplo/')) return P(403, { 'X-Proxy-Upstream-Status': '403' }, 'Forbidden');
  if (pedida.startsWith('https://enorme.ejemplo/'))
    return P(200, { 'X-Proxy-Upstream-Status': '200', 'X-Proxy-Truncated': '1' }, '<p>principio de una página enorme</p>');
  if (pedida.startsWith('https://normal.ejemplo/'))
    return P(200, { 'X-Proxy-Upstream-Status': '200', 'X-Proxy-Truncated': '0' }, '<p>una página normal</p>');
  if (pedida.startsWith('https://sin-ruta.ejemplo/')) return P(404, {}, '<html><body>404 Not Found</body></html>');   // nginx sin /proxy
  if (/duckduckgo\.com\//.test(pedida)) {
    if (ddg === 'antibot') return P(202, { 'X-Proxy-Upstream-Status': '202' }, DDG_ANTIBOT);
    if (ddg === '202') return P(202, { 'X-Proxy-Upstream-Status': '202' }, DDG_202_SIN_TEXTO);
    if (ddg === 'antibot-proxy-viejo') return P(200, {}, DDG_ANTIBOT);   // el proxy viejo lo daba como 200
    if (ddg === 'limite') return P(429, { 'X-Proxy-Error': 'rate-limited', 'Retry-After': '60' }, 'demasiadas peticiones al proxy, espera un poco\n');
    if (ddg === 'ocupado') return P(503, { 'X-Proxy-Error': 'busy', 'Retry-After': '5' }, 'proxy ocupado, prueba en unos segundos\n');
    return P(200, { 'X-Proxy-Upstream-Status': '200' }, DDG_OK);
  }
  return P(502, { 'X-Proxy-Error': 'upstream' }, 'no previsto en la prueba\n');
}

const b = await chromium.launch();
async function pagina(locale) {
  const ctx = await b.newContext({ locale });
  await ctx.addInitScript(() => { try { localStorage.setItem('elffuss.grants', JSON.stringify(['web'])); } catch { /* */ } });
  await ctx.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.origin !== BASE) return route.abort('failed');   // ni internet ni el fetch directo: sin CORS
    if (u.pathname !== '/proxy') return route.continue();
    const r = respuestaProxy(u.searchParams.get('url') || '');
    if (!r) return route.continue();
    return route.fulfill({ status: r.status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...r.headers }, body: r.body });
  });
  const p = await ctx.newPage();
  const errores = [];
  p.on('pageerror', e => errores.push(e.message));
  await p.goto(BASE + '/robots.txt');
  return { ctx, p, errores };
}
const llamar = (p, fn, args) => p.evaluate(async ({ fn, args }) => {
  const web = await import('/js/tools/web.js');
  try { return { ok: true, res: await web[fn](args) }; } catch (e) { return { ok: false, err: String(e?.message || e) }; }
}, { fn, args });

const { ctx, p, errores } = await pagina('es-ES');

// ---- lo que dice el proxy llega al agente (antes: «HTTP 403» o «HTTP 502» a secas)
const f1 = await llamar(p, 'fetchUrl', { url: 'http://127.0.0.1:1/' });
ok('un puerto prohibido lo dice el proxy de verdad: forbidden-port y el motivo',
  !f1.ok && /forbidden-port/.test(f1.err) && /solo se permiten los puertos 80 y 443/.test(f1.err) && /proxy del servidor no la trajo/.test(f1.err), f1.err);
const f2 = await llamar(p, 'fetchUrl', { url: 'https://caducado.ejemplo/' });
ok('un fallo TLS es un fallo TLS, no «HTTP 502»', !f2.ok && /\btls\b/.test(f2.err) && /fallo TLS con la web/.test(f2.err), f2.err);
const f3 = await llamar(p, 'fetchUrl', { url: 'https://sin-pagina.ejemplo/x' });
ok('el 404 de la web a través del proxy es «esa página no existe», no «falta el proxy»',
  !f3.ok && /no existe/.test(f3.err) && !/proxy de respaldo/.test(f3.err), f3.err);
const f4 = await llamar(p, 'fetchUrl', { url: 'https://prohibe.ejemplo/x' });
ok('el 403 de la propia web se distingue de un destino que rechaza el proxy',
  !f4.ok && /la web respondió HTTP 403/.test(f4.err) && !/forbidden/.test(f4.err), f4.err);
const f5 = await llamar(p, 'fetchUrl', { url: 'https://sin-ruta.ejemplo/x' });
ok('sin la ruta /proxy (un 404 sin cabeceras del proxy) sigue diciendo que falta el proxy de respaldo',
  !f5.ok && /proxy de respaldo/.test(f5.err), f5.err);

// ---- el recorte del proxy no es silencioso
const g1 = await llamar(p, 'fetchUrl', { url: 'https://enorme.ejemplo/' });
ok('una página que el proxy cortó lo dice al final', g1.ok && /principio de una página enorme/.test(g1.res) && /cortó la página en 2 MB/.test(g1.res), g1.ok ? g1.res : g1.err);
const g2 = await llamar(p, 'fetchUrl', { url: 'https://normal.ejemplo/' });
ok('…y una entera no lleva el aviso', g2.ok && /una página normal/.test(g2.res) && !/cortó/.test(g2.res), g2.ok ? g2.res : g2.err);

// ---- web.search: el bloqueo anti-bot y los errores no son «Sin resultados»
for (const [modo, nombre] of [['antibot', 'la página anti-bot (202, anomaly-modal)'],
                              ['202', 'un 202 sin enlaces aunque no traiga el texto de siempre'],
                              ['antibot-proxy-viejo', 'la página anti-bot que el proxy viejo daba como 200']]) {
  ddg = modo;
  const s = await llamar(p, 'search', { query: 'historia del reloj' });
  ok(`${nombre} es un bloqueo del buscador`, !s.ok && /bloqueó la consulta/.test(s.err) && !/Sin resultados/.test(s.err), s.ok ? s.res : s.err);
}
for (const [modo, codigo] of [['limite', 'rate-limited'], ['ocupado', 'busy']]) {
  ddg = modo;
  const s = await llamar(p, 'search', { query: 'historia del reloj' });
  ok(`si el proxy no contesta (${codigo}) la búsqueda falla diciendo por qué`,
    !s.ok && new RegExp(codigo).test(s.err) && !/Sin resultados/.test(s.err), s.ok ? s.res : s.err);
}
ddg = 'ok';
const s3 = await llamar(p, 'search', { query: 'historia del reloj' });
ok('con el buscador contestando salen los resultados con su enlace',
  s3.ok && /Resultados (de la web )?para «historia del reloj»/.test(s3.res) && /https:\/\/ejemplo\.org\/historia-del-reloj/.test(s3.res), s3.ok ? s3.res : s3.err);
ok('sin errores de página', errores.length === 0, errores.join(' | '));
await ctx.close();

{
  const { ctx: c2, p: q } = await pagina('en-US');
  const r = await llamar(q, 'fetchUrl', { url: 'http://127.0.0.1:1/' });
  ok('in English the proxy refusal reads in English', !r.ok && /the server’s proxy did not fetch it/.test(r.err) && /forbidden-port/.test(r.err), r.err);
  await c2.close();
}

await b.close();
parar();
console.log(fails ? `\n❌ ${fails} FALLO(S)` : '\n✅ WEB: el agente recibe lo que dice el proxy, y un bloqueo no es «Sin resultados»');
process.exit(fails ? 1 : 0);
