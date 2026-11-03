// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// La memoria compartida (v2) en Claw: un caso por cada hallazgo de la revisión
// del almacén y de Claw, con los orígenes de verdad (memoria-v2-servidor.mjs) y
// el Chrome del sistema. Sin GPU ni pesos: el cerebro es el guion de mentira.
//
//   node tests/memoria-v2-revision.mjs
//
// Cada bloque fallaba antes de su arreglo:
//   A · puente v1: un memory.save del chat viejo SIN permiso del chat en la
//       memoria compartida acaba como propuesta (antes: «no-grant» y se perdía);
//   B · puente v1: memory.list respeta «memoria apagada» y la lectura del chat
//       apagada en el gestor (antes listaba igual);
//   C · revocar Claw en el gestor no se deshace al recargar Claw (antes el
//       permiso viejo «Memoria» se volvía a heredar);
//   D · si la memoria v2 no carga, Claw no vuelve a la v1: ni escribe el almacén
//       viejo ni mete «Memoria (…)» en el contexto (antes guardaba sin puerta);
//   E · «Deshacer» tras 🧹 devuelve la conversación con su «Sin memoria» y su id;
//   F · un mensaje PEGADO recuperado con ↑ sigue sin contar como escrito;
//   G · repintar Ajustes no deja paneles de memoria suscritos para siempre;
//   H · el bloque de memoria no se descuenta dos veces: si va dentro del
//       historial que ajusta el proveedor, la reserva es 0.
import { chromium } from 'playwright';
import { arrancar } from './memoria-v2-servidor.mjs';
import { CHROME_ARGS } from './chrome-args.mjs';

const srv = await arrancar();
let fallos = 0;
const ok = (n, c, e = '') => { console.log((c ? '✅' : '❌') + ' ' + n + (e ? '  — ' + e : '')); if (!c) fallos++; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(cond, { veces = 120, cada = 100 } = {}) {
  for (let i = 0; i < veces; i++) { try { if (await cond()) return true; } catch { /* aún no */ } await espera(cada); }
  return false;
}
const b = await chromium.launch({ channel: 'chrome', headless: true, args: [...srv.args, '--enable-unsafe-webgpu', ...CHROME_ARGS] });
const errores = [];
const CLAW = 'https://claw.elffuss.com';
async function contexto({ permisoViejo = true } = {}) {
  const ctx = await b.newContext({ locale: 'es-ES', viewport: { width: 1400, height: 900 } });
  ctx.on('page', (p) => p.on('pageerror', (e) => errores.push(`${p.url()}: ${e.message}`)));
  await ctx.addInitScript((permisoViejo) => {
    try {
      if (location.hostname !== 'claw.elffuss.com') return;
      localStorage.setItem('elffuss.welcomed', '1');
      localStorage.setItem('elffuss.model', 'ext:ollama');
      localStorage.setItem('elffuss.model.elegido', 'ext:ollama');
      localStorage.setItem('elffuss.providers', JSON.stringify({ ollama: { enabled: true, baseURL: 'https://claw.elffuss.com/fake-llm/v1', model: 'guion', apiKey: 'x' } }));
      if (permisoViejo && !localStorage.getItem('elffuss.grants')) localStorage.setItem('elffuss.grants', JSON.stringify(['memory']));
    } catch { /* — */ }
  }, permisoViejo);
  return ctx;
}
const leer = (p, db, store) => p.evaluate(({ db, store }) => new Promise((ok) => {
  const r = indexedDB.open(db);
  r.onupgradeneeded = () => { r.transaction.abort(); ok(null); };
  r.onerror = () => ok(null);
  r.onsuccess = () => {
    const d = r.result;
    if (!d.objectStoreNames.contains(store)) { d.close(); ok([]); return; }
    const q = d.transaction(store, 'readonly').objectStore(store).getAll();
    q.onsuccess = () => { d.close(); ok(q.result); };
    q.onerror = () => { d.close(); ok(null); };
  };
}), { db, store });
// El almacén abierto en una página de Claw (mismo origen que la página almacén),
// con el contexto del gestor o de una app.
const almacen = (p, op, args = {}, quien = { ui: true, manager: true }) => p.evaluate(async ({ op, args, quien }) => {
  const { openStore } = await import('/js/engine/memory-store.js');
  const cfg = (await import('/memory/memory.config.js')).default;
  window.__st ||= await openStore(cfg);
  return window.__st.call(op, args, quien);
}, { op, args, quien });
const ev = (t) => ({ current: t, typedTexts: [t] });

async function abrirClaw(ctx) {
  const claw = await ctx.newPage();
  await claw.goto(CLAW + '/', { waitUntil: 'domcontentloaded' });
  const listo = await hasta(() => claw.evaluate(() => document.getElementById('model-select')?.value === 'ext:ollama'
    && document.getElementById('model-status')?.classList.contains('on')), { veces: 200 });
  return { claw, listo };
}
async function escribe(claw, texto, { pegar = false } = {}) {
  const antes = srv.llm.length;
  if (pegar) {
    await claw.focus('#prompt');
    await claw.evaluate((t) => {
      const dt = new DataTransfer(); dt.setData('text/plain', t);
      document.getElementById('prompt').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    }, texto);
  }
  if (texto !== null) await claw.fill('#prompt', texto);
  await claw.press('#prompt', 'Enter');
  await hasta(() => srv.llm.length > antes, { veces: 100 });
  let n = -1, igual = 0;
  for (let i = 0; i < 100 && igual < 8; i++) {
    const parado = await claw.evaluate(() => !document.getElementById('send').classList.contains('is-stop'));
    if (srv.llm.length === n && parado) igual++; else igual = 0;
    n = srv.llm.length;
    await espera(150);
  }
  return srv.llm.slice(antes);
}
const activos = async (p, re) => ((await leer(p, 'elffuss-memory', 'records')) || []).filter((r) => r.status === 'active' && re.test(r.fact));

// ── A y B · el puente v1 ────────────────────────────────────────────────────
{
  const ctx = await contexto({ permisoViejo: false });
  const sitio = await ctx.newPage();
  await sitio.goto(CLAW + '/robots.txt');
  await almacen(sitio, 'grant', { state: 'granted' }, { app: 'claw', direct: true });
  const g = await almacen(sitio, 'save', { fact: 'Tiene una gata que se llama Lía', evidence: ev('Recuerda que tengo una gata que se llama Lía'), tainted: false }, { app: 'claw', direct: true });
  ok('A·preparación: un hecho guardado por Claw', g.ok && g.result.status === 'saved', JSON.stringify(g));
  const chat = await ctx.newPage();
  await chat.goto('https://elffuss.com/');
  await chat.waitForFunction(() => !!window.__t);
  const grants = await leer(sitio, 'elffuss-memory', 'grants');
  ok('A·el chat no tiene permiso en la memoria compartida', !grants.some((x) => x.origin === 'https://elffuss.com'));
  const r = await chat.evaluate(() => window.__t.puente('memory.save', { fact: 'Tiene un perro que se llama Bruno' }));
  ok('A·puente memory.save sin permiso del chat: «pendiente de confirmar», no «no-grant»', r.ok === false && /confirm/i.test(r.error), JSON.stringify(r));
  ok('A·…y la propuesta queda en Memoria, «no sale de tus palabras», de la app chat', await hasta(async () =>
    ((await leer(sitio, 'elffuss-memory', 'proposals')) || []).some((p) => /Bruno/.test(p.fact) && p.label === 'from-content' && p.source?.app === 'chat')));
  ok('A·…y nada activo', (await activos(sitio, /Bruno/)).length === 0);

  const lista = async () => chat.evaluate(() => window.__t.puente('memory.list'));
  let l = await lista();
  ok('B·control: con la memoria encendida, el puente lista el hecho', l.ok && l.result.some((f) => /Lía/.test(f.fact)), JSON.stringify(l).slice(0, 120));
  await almacen(sitio, 'settings', { on: false });
  l = await lista();
  ok('B·memoria apagada en el gestor: el puente no lista nada', l.ok && l.result.length === 0, JSON.stringify(l).slice(0, 120));
  await almacen(sitio, 'settings', { on: true, apps: { chat: { read: false } } });
  l = await lista();
  ok('B·lectura del chat apagada: el puente no lista nada', l.ok && l.result.length === 0, JSON.stringify(l).slice(0, 120));
  await ctx.close();
}

// ── C · revocar Claw no se deshace al recargar ──────────────────────────────
{
  const ctx = await contexto();
  const { claw, listo } = await abrirClaw(ctx);
  ok('C·Claw arranca con el cerebro guionado', listo);
  const permisoClaw = async () => ((await leer(claw, 'elffuss-memory', 'grants')) || []).find((x) => x.origin === CLAW)?.state || null;
  ok('C·el permiso viejo «Memoria» se hereda la primera vez', await hasta(async () => (await permisoClaw()) === 'granted'));
  const rv = await almacen(claw, 'revoke', { origin: CLAW });
  ok('C·el gestor revoca a Claw', rv.ok && (await permisoClaw()) === null, JSON.stringify(rv));
  await claw.reload({ waitUntil: 'domcontentloaded' });
  await claw.evaluate(async () => { await (await import('/js/memory-wire.js')).cargar(); });
  await espera(800);
  ok('C·tras recargar Claw, sigue revocado (no se vuelve a heredar)', (await permisoClaw()) === null, String(await permisoClaw()));
  await ctx.close();
}

// ── D · si la memoria v2 no carga, nada vuelve a la v1 ──────────────────────
{
  const ctx = await contexto();
  await ctx.route('**/js/engine/memory-ui.js', (r) => r.abort());
  const { claw, listo } = await abrirClaw(ctx);
  ok('D·Claw arranca aunque falle un módulo de memoria', listo);
  const sinV2 = await claw.evaluate(async () => (await (await import('/js/memory-wire.js')).cargar()) === null);
  ok('D·(la memoria v2 no ha cargado)', sinV2);
  const pet = await escribe(claw, 'recuerda que vivo en Lisboa');
  const viejo = (await leer(claw, 'elffuss', 'memory')) || [];
  ok('D·memory.save no escribe el almacén viejo de Claw', !viejo.some((r) => /Lisboa/.test(r.fact)), JSON.stringify(viejo));
  const estado = (pet[0]?.messages || []).find((m) => m.role === 'user' && /^CONTEXTO AHORA/.test(m.content))?.content || '';
  ok('D·ni vuelve la línea «Memoria (…)» de la v1 al contexto', !/Memoria \(hechos que recuerdas/.test(estado), estado.slice(0, 160));
  const resultado = (pet[1]?.messages || []).map((m) => m.content).find((c) => /^\[resultado/.test(c)) || '';
  ok('D·el modelo recibe «no disponible», no «Recordado»', !/Recordado/.test(resultado) && /disponible/i.test(resultado), resultado.slice(0, 160));
  await ctx.close();
}

// ── E, F, G, H · en una pestaña de Claw ─────────────────────────────────────
{
  const ctx = await contexto();
  const { claw, listo } = await abrirClaw(ctx);
  ok('Claw arranca con el cerebro guionado', listo);
  await hasta(async () => ((await leer(claw, 'elffuss-memory', 'grants')) || []).some((x) => x.origin === CLAW && x.state === 'granted'));

  // F · pegado y luego ↑
  await escribe(claw, 'recuerda que vivo en Oporto', { pegar: true });
  ok('F·pegado: no se guarda activo', (await activos(claw, /Oporto/)).length === 0);
  await claw.focus('#prompt');
  await claw.fill('#prompt', '');
  await claw.press('#prompt', 'ArrowUp');
  ok('F·↑ recupera el mensaje pegado', (await claw.inputValue('#prompt')) === 'recuerda que vivo en Oporto');
  await escribe(claw, null);
  ok('F·enviado otra vez con ↑ sigue sin contar como escrito: nada activo', (await activos(claw, /Oporto/)).length === 0);
  await escribe(claw, 'recuerda que vivo en Valencia');
  ok('F·control: escrito a mano sí se guarda', (await activos(claw, /Valencia/)).length === 1);
  await claw.fill('#prompt', '');
  await claw.press('#prompt', 'ArrowUp');
  await escribe(claw, null);
  ok('F·control: lo escrito recuperado con ↑ sigue contando como escrito (duplicado, no propuesta)', (await activos(claw, /Valencia/)).length === 1 &&
    !((await leer(claw, 'elffuss-memory', 'proposals')) || []).some((p) => /Valencia/.test(p.fact)));

  // G · repintar Ajustes
  await claw.evaluate(() => { location.hash = '#/memoria'; });
  await hasta(() => claw.evaluate(() => !!document.querySelector('#panel-ajustes .mem-root')));
  const vivos = await claw.evaluate(async () => {
    const w = await import('/js/memory-wire.js');
    const m = await w.cargar();
    const st = m.store;
    if (!st.__cuenta) {
      st.__cuenta = { vivas: 0 };
      const orig = st.onChange.bind(st);
      st.onChange = (f) => { st.__cuenta.vivas++; const off = orig(f); let hecho = false; return () => { if (!hecho) { hecho = true; st.__cuenta.vivas--; } return off(); }; };
    }
    const ui = await import('/js/ui.js');
    for (let i = 0; i < 6; i++) ui.refreshSettings();
    await new Promise((r) => setTimeout(r, 1500));
    return { vivas: st.__cuenta.vivas, montados: document.querySelectorAll('#panel-ajustes .mem-root').length };
  });
  ok('G·seis repintados de Ajustes: un solo panel montado', vivos.montados === 1, JSON.stringify(vivos));
  ok('G·…y como mucho una suscripción viva de los paneles nuevos', vivos.vivas <= 1, JSON.stringify(vivos));

  // H · la reserva del bloque
  const res = await claw.evaluate(async () => {
    const { Agent } = await import('/js/agent.js');
    const out = [];
    const falso = (fuera) => ({
      ...(fuera ? { memoriaFueraDelHistorial: () => true } : {}),
      contextTokens: () => 32768,
      async chat(history, system, onToken, opts = {}) {
        const dentro = history.some((m) => /<memoria>/.test(m.content || ''));
        out.push({ fuera, dentro, reserva: opts.reserveTokens || 0 });
        return 'Vale.';
      },
    });
    for (const fuera of [false, true]) {
      const a = new Agent(falso(fuera));
      await a.handle('¿dónde vivo?', () => {}, { typed: true });
    }
    return out;
  });
  const enHist = res.find((x) => !x.fuera), aparte = res.find((x) => x.fuera);
  ok('H·el bloque <memoria> va dentro del historial que ajusta el proveedor', enHist?.dentro === true, JSON.stringify(res));
  ok('H·…y entonces no se reserva otra vez (reserva 0)', enHist?.reserva === 0, JSON.stringify(enHist));
  ok('H·un proveedor que ajusta el historial aparte del bloque (LiteRT) sí recibe la reserva', aparte?.reserva > 0, JSON.stringify(aparte));

  // E · «Deshacer» tras 🧹
  await claw.evaluate(async () => { (await import('/js/memory-wire.js')).ponerSinMemoria(true); });
  await escribe(claw, 'hola');
  const antes = await claw.evaluate(() => ({ sin: localStorage.getItem('elffuss.memoria.sinMemoria'), conv: localStorage.getItem('elffuss.memoria.conv') }));
  ok('E·preparación: conversación «Sin memoria» con su id', antes.sin === '1' && !!antes.conv, JSON.stringify(antes));
  await Promise.all([claw.waitForEvent('load', { timeout: 20000 }).catch(() => {}), claw.click('#btn-clear')]);
  await claw.waitForLoadState('domcontentloaded');
  ok('E·🧹: conversación nueva, sin «Sin memoria»', await hasta(() => claw.evaluate(() => localStorage.getItem('elffuss.memoria.sinMemoria') !== '1')));
  ok('E·sale el aviso con «Deshacer»', await hasta(() => claw.evaluate(() => [...document.querySelectorAll('.toast-accion')].some((x) => x.textContent === 'Deshacer')), { veces: 200 }));
  await Promise.all([claw.waitForEvent('load', { timeout: 20000 }).catch(() => {}),
    claw.evaluate(() => [...document.querySelectorAll('.toast-accion')].find((x) => x.textContent === 'Deshacer').click())]);
  await claw.waitForLoadState('domcontentloaded');
  await espera(1500);
  const despues = await claw.evaluate(() => ({ sin: localStorage.getItem('elffuss.memoria.sinMemoria'), conv: localStorage.getItem('elffuss.memoria.conv'), hola: /hola/.test(document.getElementById('log')?.textContent || '') }));
  ok('E·«Deshacer» devuelve la conversación', despues.hola, JSON.stringify(despues));
  ok('E·…con su «Sin memoria»', despues.sin === '1', JSON.stringify(despues));
  ok('E·…y su id de conversación', despues.conv === antes.conv, JSON.stringify(despues));
  await ctx.close();
}

ok('sin errores de página', errores.length === 0, errores.slice(0, 3).join(' | '));
await b.close();
await srv.cerrar();
if (fallos) { console.log(`\n❌ ${fallos} fallo(s)`); process.exit(1); }
console.log('\n✅ REVISIÓN DE LA MEMORIA EN CLAW: puente, permiso revocado, sin vuelta a la v1, deshacer, pegado, paneles y reserva');
