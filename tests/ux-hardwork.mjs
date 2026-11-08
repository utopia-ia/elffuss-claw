// ⛏ Hard Work con un cerebro de prueba (proveedor «Ollama local» apuntando a un
// servidor de mentira compatible con OpenAI, en un puerto que da el sistema).
//   · Es para el PRÓXIMO mensaje que escribes: aria-pressed, y se apaga al
//     mandarlo. Los chips no lo gastan ni van por Hard Work.
//   · Cuenta lo que pasó: rondas de mejora reales, «solo el borrador» si la
//     reescritura no salió, y el error si la app no se pudo guardar.
//   · Con carpeta, no lee los ficheros que parecen secretos (.env).
//   · Un mensaje de Hard Work que espera en la cola lo sigue siendo tras recargar.
//
//   BASE=http://localhost:8743 node tests/ux-hardwork.mjs
import { createServer } from 'node:http';
import { navegador, contexto, ok, hasta, espera, escribir, reposo, fin, BASE } from './ux-comun.mjs';

const peticiones = [];         // { sistema, usuario }
let reescrituraMala = false;
const HTML = cuerpo => `<!doctype html><html><head><title>naves</title></head><body>${cuerpo}</body></html>`;
const servidor = createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  let cuerpo = '';
  req.on('data', d => { cuerpo += d; });
  req.on('end', () => {
    let msgs = [];
    try { msgs = JSON.parse(cuerpo).messages || []; } catch { /* */ }
    const sistema = msgs.find(m => m.role === 'system')?.content || '';
    const usuario = msgs.filter(m => m.role === 'user').map(m => m.content).join('\n');
    peticiones.push({ sistema, usuario });
    let out = 'respuesta normal';
    if (/crítico de videojuegos/.test(sistema)) out = '1. le falta color';
    else if (/mejorando tu propia app/.test(sistema)) out = reescrituraMala ? 'no sé hacerlo' : HTML('MEJORADA');
    else if (/creando una app web/.test(sistema)) out = HTML('BORRADOR');
    else if (/analista|sintetizador/.test(sistema)) out = 'resumen de la parte';
    const responder = () => {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: out } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    };
    // «LENTO»: un turno que tarda, para que lo siguiente espere en la cola.
    if (/LENTO/.test(usuario.split('\n').at(-1) || '')) setTimeout(responder, 3000); else responder();
  });
});
await new Promise(r => servidor.listen(0, '127.0.0.1', r));
const PUERTO = servidor.address().port;

const b = await navegador();
const { ctx } = await contexto(b, {
  model: 'ext:ollama', grants: ['apps'],
  extraInit: { 'elffuss.providers': JSON.stringify({ ollama: { enabled: true, baseURL: `http://localhost:${PUERTO}/v1`, model: 'falso', apiKey: 'ollama' } }) },
});
const p = await ctx.newPage({ viewport: { width: 1400, height: 900 } });
const errores = [];
p.on('pageerror', e => { if (!/allow-same-origin/.test(e.message)) errores.push(e.message); });
await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
ok('el cerebro de prueba queda cargado', await hasta(() => p.evaluate(() =>
  document.getElementById('model-select')?.value === 'ext:ollama' && document.getElementById('model-status')?.classList.contains('on'))));
const hw = p.locator('#btn-hardwork');
const pulsado = async () => await hw.getAttribute('aria-pressed');
const ultimoAsistente = () => p.locator('#log .msg.assistant').last().innerText();

ok('el botón dice su estado (aria-pressed=false) y tiene título traducido', await pulsado() === 'false' && /próximo mensaje/.test(await hw.getAttribute('title')));
await hw.click();
ok('al pulsarlo: aria-pressed=true y la caja lo dice', await pulsado() === 'true' && /Hard Work para este mensaje/.test(await p.getAttribute('#prompt', 'placeholder')));

// ── un mensaje con Hard Work: rondas reales, y se apaga solo ────────────────
let desde = peticiones.length;
await escribir(p, 'hazme un juego de naves');
ok('…y al mandarlo se apaga (era para ese mensaje)', await pulsado() === 'false');
ok('trabaja en dos pasadas y lo dice con las rondas que hubo', await hasta(async () => /rondas de mejora: 1/.test(await ultimoAsistente())));
ok('la app guardada es la mejorada', await p.evaluate(async () => /MEJORADA/.test((await import('/js/sandbox-frame.js')).frameHtml(document.getElementById('appframe')))));
ok('(borrador, crítica y reescritura: 3 llamadas)', peticiones.length - desde === 3, `${peticiones.length - desde}`);
await reposo(p);

// ── los chips no gastan ni usan Hard Work ───────────────────────────────────
await hw.click();
desde = peticiones.length;
await p.locator('#chips .chip', { hasText: 'Crea una app de notas' }).click();
await reposo(p);
ok('con Hard Work puesto, un chip va como mensaje normal', peticiones.slice(desde).every(x => /^Eres Elffuss: un sistema operativo/.test(x.sistema)) && peticiones.length > desde);
ok('…y Hard Work sigue puesto para lo que escribas', await pulsado() === 'true');

// ── la reescritura no sale: «solo el borrador» ──────────────────────────────
reescrituraMala = true;
await escribir(p, 'hazme otro juego');
ok('si la reescritura no sale, dice que solo hizo el borrador', await hasta(async () => /solo el borrador/.test(await ultimoAsistente())));
reescrituraMala = false;
await reposo(p);

// ── no se puede guardar la app: lo dice ─────────────────────────────────────
await p.evaluate(async () => (await import('/js/permissions.js')).revoke('apps'));
await hw.click();
await escribir(p, 'hazme un tercer juego');
await hasta(() => p.evaluate(() => document.getElementById('perm-dialog').open));
await p.keyboard.press('Escape');                 // denegar el permiso de Apps
ok('si la app no se puede guardar, lo dice (y no «Listo»)', await hasta(async () =>
  /no pude guardar la app/.test(await p.locator('#log .msg.assistant.err').last().innerText().catch(() => ''))));
await reposo(p);

// ── un mensaje de Hard Work que espera en la cola sigue siéndolo tras recargar ─
// (antes la cola guardaba solo el texto y, al recargar, iba como chat normal)
await espera(300);
if (await p.evaluate(() => document.getElementById('perm-dialog').open)) await p.click('#perm-deny');
await escribir(p, 'LENTO turno normal');
await hasta(() => peticiones.some(x => /LENTO turno normal/.test(x.usuario)));
if (await pulsado() !== 'true') await hw.click();
await escribir(p, 'hazme un juego de naves EN-COLA');
const cola = await p.evaluate(async () => (await import('/js/db.js')).get('kv', 'queue'));
ok('el mensaje de Hard Work se guarda en la cola CON su elección', Array.isArray(cola)
  && cola.some(x => /EN-COLA/.test(x.text) && x.hard === true), JSON.stringify(cola));
desde = peticiones.length;
await p.reload({ waitUntil: 'domcontentloaded' });
ok('tras recargar, va por Hard Work (no como chat normal)', await hasta(() =>
  peticiones.slice(desde).some(x => /creando una app web/.test(x.sistema) && /EN-COLA/.test(x.usuario)), { veces: 400 }),
  JSON.stringify(peticiones.slice(desde).map(x => x.sistema.slice(0, 40) + ' | ' + x.usuario.slice(-30))));
ok('…y nunca como turno normal', !peticiones.slice(desde).some(x => /^Eres Elffuss: un sistema operativo/.test(x.sistema) && /EN-COLA/.test(x.usuario.split('\n').at(-1))));
await reposo(p);

// ── con carpeta: .env no se lee ─────────────────────────────────────────────
await p.evaluate(async () => {
  const raiz = await (await navigator.storage.getDirectory()).getDirectoryHandle('proyecto', { create: true });
  const escribe = async (n, t) => { const f = await raiz.getFileHandle(n, { create: true }); const w = await f.createWritable(); await w.write(t); await w.close(); };
  await escribe('README.md', '# Proyecto\nCONTENIDO-LEGIBLE de la documentación.');
  await escribe('.env', 'API_KEY=SECRETO-NO-LEER-123');
  await escribe('credentials.json', '{"token":"OTRO-SECRETO-456"}');
  await (await import('/js/db.js')).set('fs', 'proyecto', raiz);
  (await import('/js/permissions.js')).require('fs');
});
await espera(200);
if (await p.evaluate(() => document.getElementById('perm-dialog').open)) await p.click('#perm-allow');
desde = peticiones.length;
await hw.click();
await escribir(p, '¿de qué va este proyecto?');
await hasta(async () => /Hard Work \(RLM\)/.test(await p.locator('#log').innerText()), { veces: 300 });
const enviado = peticiones.slice(desde).map(x => x.usuario).join('\n');
ok('con carpeta, Hard Work lee los documentos…', /CONTENIDO-LEGIBLE/.test(enviado));
ok('…pero NO .env ni lo que parece una credencial', !/SECRETO-NO-LEER|OTRO-SECRETO/.test(enviado));

ok('sin errores de página', errores.length === 0, errores.slice(0, 3).join(' | '));
servidor.close();
await fin(b, 'HARD WORK: para un mensaje, cuenta lo que hizo y no lee secretos');
