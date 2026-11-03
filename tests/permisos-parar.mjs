// Permisos y herramientas frente al botón ■ (sin GPU, con proveedores de mentira).
// ─────────────────────────────────────────────────────────────────────────────
// El turno esperaba a la herramienta sin mirar la señal, y el diálogo de
// permisos cerrado con Escape no contestaba nunca. Juntos:
//   · Escape dejaba el turno colgado para siempre: ■ abortaba, pero el bucle no
//     llegaba a ninguna comprobación; detrás esperaban la cola y el cerebro CEO.
//   · Con varios permisos pedidos a la vez (los perfiles del CEO piensan en
//     paralelo) solo el último quedaba enganchado a los botones; los demás no
//     contestaban nunca y el ciclo no podía terminar: «pausando…» para siempre.
// Se comprueba:
//   1. Escape en el diálogo es «no»: la herramienta recibe la negativa, el turno
//      sigue y termina, y el mensaje siguiente se procesa.
//   2. ■ con una herramienta que no vuelve: «(Parado.)», el turno termina (sin
//      burbuja colgada, botón ➤) y lo que se envía después se procesa.
//   3. Tres peticiones a la vez: se enseñan de una en una y cada una recibe SU
//      respuesta; la que espera turno no pregunta si su ámbito ya se concedió.
//   4. El cerebro CEO. En la app solo puede leer (kernel.js le pasa una lista de
//      solo lectura): sus perfiles no abren ningún diálogo. Con una lista que lo
//      deja todo —la maquinaria de ceo.js y permissions.js tal cual, como la usa
//      un anfitrión sin lista—, los permisos que piden a la vez se enseñan de uno
//      en uno, y pausar TERMINA el ciclo aunque queden pendientes; después
//      «Pensar ahora» vuelve a funcionar.
//
//   python3 server/serve.py 8742 &   BASE=http://localhost:8742 node tests/permisos-parar.mjs
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:8742';
let fails = 0;
const ok = (n, c, e = '') => { console.log((c ? '✅' : '❌') + ' ' + n + (e ? '  — ' + e : '')); if (!c) fails++; };
const espera = ms => new Promise(r => setTimeout(r, ms));
async function hasta(cond, { veces = 100, cada = 50 } = {}) {
  for (let i = 0; i < veces; i++) { if (await cond()) return true; await espera(cada); }
  return false;
}

const b = await chromium.launch();
const ctx = await b.newContext({ locale: 'es-ES' });
await ctx.addInitScript(() => {
  try { localStorage.setItem('elffuss.model', 'rules'); localStorage.setItem('elffuss.welcomed', '1'); localStorage.removeItem('elffuss.grants'); } catch {}
});
const p = await ctx.newPage({ viewport: { width: 1400, height: 900 } });
const errores = [];
p.on('pageerror', e => { if (!/allow-same-origin/.test(e.message)) errores.push(e.message); });
await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.elffuss?.agent, null, { timeout: 15000 });

const dialogo = () => p.evaluate(() => {
  const d = document.getElementById('perm-dialog');
  return { abierto: d.open, detalle: document.getElementById('perm-detail').textContent };
});
const reposo = () => p.evaluate(() => !document.getElementById('send').classList.contains('is-stop')
  && document.querySelectorAll('.msg.thinking').length === 0);
const textos = () => p.locator('#log .msg.assistant').allTextContents();
// Un clic que, si el botón no está, falla la comprobación en vez de tumbar la prueba.
const pulsar = async sel => { try { await p.click(sel, { timeout: 3000 }); return true; } catch { return false; } };

// ── 1 · Escape en el diálogo de permisos ─────────────────────────────────────
await p.evaluate(() => {
  window.__llamadas = 0;
  window.elffuss.agent.setProvider({ chat: async (h) => {
    window.__llamadas++;
    if (/^\[resultado memory\.save\]/.test(h.at(-1)?.content || '')) return 'Vale, no lo guardo.';
    return '```tool\n{"tool":"memory.save","args":{"fact":"me gusta el mar"}}\n```';
  } });
  window.elffuss.send('recuerda que me gusta el mar');
});
ok('1 · el turno pide permiso con el diálogo', await hasta(async () => (await dialogo()).abierto));
await p.keyboard.press('Escape');
ok('1 · Escape cierra el diálogo y el turno TERMINA (no se queda colgado)', await hasta(async () => !(await dialogo()).abierto && await reposo()));
ok('1 · la herramienta recibe la negativa', (await p.locator('#log .msg.tool-result.err').allTextContents()).some(t => /denegado/i.test(t)));
ok('1 · y el modelo contesta después con ese resultado', (await textos()).some(t => t.includes('Vale, no lo guardo.')), `${await p.evaluate(() => window.__llamadas)} llamadas`);
await p.evaluate(() => {
  window.elffuss.agent.setProvider({ chat: async () => { window.__llamadas++; return 'Aquí sigo.'; } });
  window.elffuss.send('¿sigues ahí?');
});
ok('1 · el mensaje siguiente se procesa', await hasta(async () => (await textos()).some(t => t.includes('Aquí sigo.')) && await reposo()));

// ── 2 · ■ con una herramienta que no vuelve nunca ────────────────────────────
await p.evaluate(async () => {
  const { TOOLS } = await import('/js/tools/index.js');
  window.__runAntes = TOOLS['memory.list'].run;
  TOOLS['memory.list'].run = () => new Promise(() => {});
  window.elffuss.agent.setProvider({ chat: async () => '```tool\n{"tool":"memory.list","args":{}}\n```' });
  window.elffuss.send('lista lo que recuerdas');
});
await hasta(() => p.evaluate(() => [...document.querySelectorAll('#log .msg.tool')].some(d => d.textContent.includes('memory.list'))));
const paradosAntes = (await p.locator('.msg.assistant.muted').allTextContents()).filter(t => t.includes('(Parado.)')).length;
await pulsar('#send');
ok('2 · ■ con la herramienta colgada: avisa «(Parado.)»', await hasta(async () =>
  (await p.locator('.msg.assistant.muted').allTextContents()).filter(t => t.includes('(Parado.)')).length === paradosAntes + 1));
ok('2 · y el turno termina: sin burbuja de «pensando» y el botón vuelve a ➤', await hasta(reposo));
await p.evaluate(async () => {
  const { TOOLS } = await import('/js/tools/index.js');
  TOOLS['memory.list'].run = window.__runAntes;
  window.elffuss.agent.setProvider({ chat: async () => 'Sigo aquí después de parar.' });
  window.elffuss.send('¿y ahora?');
});
ok('2 · lo que se envía después se procesa', await hasta(async () => (await textos()).some(t => t.includes('Sigo aquí después de parar.')) && await reposo()));

// ── 3 · tres peticiones a la vez, de una en una ──────────────────────────────
await p.evaluate(async () => {
  const perms = await import('/js/permissions.js');
  const r = x => x.then(() => 'sí', () => 'no');
  window.__perm = Promise.all([r(perms.require('tasks', 'uno')), r(perms.require('web', 'dos')), r(perms.require('tasks', 'tres'))]);
});
ok('3 · se enseña la primera', await hasta(async () => { const d = await dialogo(); return d.abierto && d.detalle === 'uno'; }));
await pulsar('#perm-allow');
ok('3 · al contestarla, se enseña la segunda (no se pierde)', await hasta(async () => { const d = await dialogo(); return d.abierto && d.detalle === 'dos'; }));
await pulsar('#perm-deny');
const res3 = await p.evaluate(() => Promise.race([window.__perm, new Promise(r => setTimeout(() => r('PENDIENTE'), 3000))]));
ok('3 · cada una recibe SU respuesta, y la tercera no pregunta (su ámbito ya se concedió)',
  JSON.stringify(res3) === '["sí","no","sí"]' && !(await dialogo()).abierto, JSON.stringify(res3));

// ── 4 · el cerebro CEO con permisos pendientes ───────────────────────────────
// Primero tal como lo monta la app: init() sin `allowTool` conserva la lista de
// solo lectura que le dio kernel.js, y app.create (escribe) no llega a pedir
// permiso: el modelo recibe un ERROR que se lo explica y el ciclo termina.
// (Era memory.save; con la memoria compartida guardar ya no abre el diálogo de
// permisos de Claw —el permiso es de la memoria, con su tarjeta—, así que el
// ejemplo de herramienta que pide permiso pasa a ser crear una app: el de las
// tareas ya está concedido en el paso 3.)
await p.evaluate(async () => {
  const ceo = await import('/js/ceo.js');
  window.__ceo = { llamadas: 0, herramienta: true };
  ceo.init({
    workspace: { isReady: async () => true, tree: async () => 'a.txt', list: async () => [], read: async () => '', remove: async () => {}, write: async () => {} },
    provider: () => ({ chat: async () => {
      window.__ceo.llamadas++;
      return window.__ceo.herramienta ? '```tool\n{"tool":"app.create","args":{"name":"x","html":"<p>x"}}\n```' : 'Una propuesta concreta para el espacio.';
    } }),
    isBusy: () => false,
    onEvent: () => {},
  });
  const t0 = Date.now();
  while (!ceo.isThisTabLeader() && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 50));
  ceo.enable();
  window.__ciclo0 = ceo.forceCycle();
});
const r40 = await p.evaluate(async () => {
  let abierto = false;
  const fin = await Promise.race([
    window.__ciclo0,
    (async () => { for (let i = 0; i < 160; i++) { abierto ||= document.getElementById('perm-dialog').open; await new Promise(r => setTimeout(r, 50)); } return 'PENDIENTE'; })(),
  ]);
  return { fin, abierto: abierto || document.getElementById('perm-dialog').open, llamadas: window.__ceo.llamadas };
});
ok('4 · con la lista de solo lectura de la app, el ciclo del CEO termina sin abrir ningún diálogo', r40.fin === true && !r40.abierto, JSON.stringify(r40));
// Ahora con todas las herramientas permitidas: los tres perfiles piden permiso a la vez.
await p.evaluate(async () => {
  const ceo = await import('/js/ceo.js');
  ceo.init({ allowTool: () => true });
  window.__ciclo = ceo.forceCycle();
});
ok('4 · los perfiles del CEO piden permiso a la vez', await hasta(async () => (await dialogo()).abierto));
await pulsar('#perm-deny');
ok('4 · al contestar uno, se enseña el del siguiente perfil', await hasta(async () => (await dialogo()).abierto));
const r4 = await p.evaluate(async () => {
  const ceo = await import('/js/ceo.js');
  ceo.disable();
  for (let i = 0; i < 60 && ceo.isRunning(); i++) await new Promise(r => setTimeout(r, 50));
  const corriendo = ceo.isRunning();
  window.__ceo.herramienta = false;
  const otra = await Promise.race([ceo.forceCycle(), new Promise(r => setTimeout(() => r('PENDIENTE'), 5000))]);
  return { corriendo, otra, llamadas: window.__ceo.llamadas };
});
ok('4 · pausar TERMINA el ciclo aunque queden permisos sin contestar', r4.corriendo === false, JSON.stringify(r4));
ok('4 · y «Pensar ahora» vuelve a arrancar un ciclo', r4.otra === true, JSON.stringify(r4));
// Los permisos que quedaron en fila se pueden despachar con Escape, uno a uno.
for (let i = 0; i < 4 && (await dialogo()).abierto; i++) { await p.keyboard.press('Escape'); await espera(150); }
ok('4 · lo que quedó en fila se despacha con Escape y no queda nada abierto', !(await dialogo()).abierto);

ok('sin errores de página', errores.length === 0, errores.slice(0, 3).join(' | '));
console.log(fails ? `\n❌ ${fails} FALLO(S)` : '\n✅ PERMISOS Y HERRAMIENTAS: Escape contesta, ■ no se queda colgado y el CEO puede pausar');
await b.close();
process.exit(fails ? 1 : 0);
