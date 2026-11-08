// El copiloto (?copilot=1) con un Translator de mentira: una página servida en
// https://translator.elffuss.com por intercepción (nada llega a producción) que
// abre Claw y le manda la conversación como lo hace el de verdad.
//   · Avisa de que instala una skill en tus Skills (con «Ver»).
//   · Lo que se oye en la llamada sale como transcripción (quién habla), no como
//     un mensaje tuyo, y en el chat solo va el consejo (no CONSEJO/ACCION/DATOS
//     crudos ni el texto de ayuda de Básico).
//   · «Me llamo Ana Ruiz», con mayúscula, rellena el nombre.
//   · «⬇ Exportar a Excel (CSV)» descarga de verdad dentro del visor.
//   · Una app abierta a mano desde Apps no la tapa el tablero a los 5 s.
//
//   BASE=http://localhost:8743 node tests/ux-copiloto.mjs
import { navegador, contexto, ok, hasta, espera, fin, BASE, OUT } from './ux-comun.mjs';

const TRANSLATOR = 'https://translator.elffuss.com';
const STUB = '<!doctype html><html><body>stub translator<script>window.__msgs=[];addEventListener("message",e=>window.__msgs.push({origin:e.origin,data:e.data}));</script></body></html>';
const b = await navegador();
const { ctx } = await contexto(b, {
  grants: ['apps'],
  rutas: async (url, route) => {
    if (!url.startsWith(TRANSLATOR + '/')) return false;
    await route.fulfill({ status: 200, contentType: 'text/html', body: STUB });
    return true;
  },
});
const stub = await ctx.newPage();
await stub.goto(TRANSLATOR + '/copiloto-de-prueba.html');
const [claw] = await Promise.all([
  ctx.waitForEvent('page'),
  stub.evaluate(u => { window.__claw = window.open(u, 'claw'); }, BASE + '/?copilot=1&skill=ficha'),
]);
const errores = [];
claw.on('pageerror', e => { if (!/allow-same-origin/.test(e.message)) errores.push(e.message); });
await claw.waitForFunction(() => !!window.elffuss?.agent, null, { timeout: 15000 });
ok('Claw avisa al Translator de que está listo', await hasta(() => stub.evaluate(() => window.__msgs.some(m => m.data?.kind === 'copilot-ready'))));
const aClaw = msg => stub.evaluate(([m, o]) => window.__claw.postMessage(m, o), [msg, new URL(BASE).origin]);

await aClaw({ kind: 'copilot-init', skill: 'ficha', sellerLangName: 'español' });
ok('el tablero «Ficha de cliente» se monta en el visor', await hasta(() => claw.evaluate(async () =>
  (await import('/js/sandbox-frame.js')).frameHtml(document.getElementById('appframe')).includes('Ficha de cliente'))));
const aviso = claw.locator('#toasts .toast', { hasText: 'Ficha de cliente' });
ok('dice que ha instalado la skill en tus Skills, con «Ver»', await hasta(async () => await aviso.count() === 1)
  && (await aviso.locator('.toast-accion').innerText()) === 'Ver');

await aClaw({ kind: 'transcript', speaker: 'Hablante 2', text: 'Me llamo Ana Ruiz y mi teléfono es 600123456' });
ok('la línea de la llamada sale como transcripción (con quién habla), no como mensaje tuyo', await hasta(async () =>
  await claw.locator('#log .msg.transcript', { hasText: 'Hablante 2' }).count() === 1)
  && await claw.locator('#log .msg.user', { hasText: 'Ana Ruiz' }).count() === 0);
ok('en el chat va solo el consejo (💡), sin el contrato crudo ni la ayuda de Básico', await hasta(async () => {
  const t = await claw.locator('#log').innerText();
  return /💡/.test(t) && !/CONSEJO:|ACCION:|DATOS:/.test(t) && !/Estoy en modo básico/.test(t);
}), (await claw.locator('#log').innerText()).slice(-300));
const tablero = () => claw.frames().find(f => f !== claw.mainFrame() && /\/sandbox\/run\.html\?n=/.test(f.url()));
ok('«Me llamo Ana Ruiz» (con mayúscula) rellena el nombre, y el teléfono también', await hasta(async () => {
  const f = tablero(); if (!f) return false;
  const t = await f.locator('#slots').innerText().catch(() => '');
  return /Ana Ruiz/.test(t) && /600123456/.test(t);
}), await tablero()?.locator('#slots').innerText().catch(() => '?'));
if (OUT) await claw.screenshot({ path: OUT + '/ux-copiloto.png' });

const [descarga] = await Promise.all([
  claw.waitForEvent('download', { timeout: 10000 }).catch(() => null),
  tablero().locator('#exp').click(),
]);
ok('«Exportar a Excel (CSV)» descarga dentro del visor', !!descarga && /\.csv$/.test(descarga.suggestedFilename()), descarga?.suggestedFilename());

// ── una app abierta a mano no la tapa el tablero ────────────────────────────
await claw.evaluate(async () => {
  await (await import('/js/db.js')).set('apps', 'reloj', { name: 'reloj', html: '<!doctype html><title>reloj</title><h1>RELOJ-DE-PRUEBA</h1>', created: Date.now() });
});
await claw.click('#tabs button[data-tab="apps"]');
await claw.locator('#panel-apps .card', { hasText: 'reloj' }).locator('button', { hasText: 'Abrir' }).click();
ok('Apps › Abrir abre la app', await hasta(() => claw.evaluate(async () => /RELOJ-DE-PRUEBA/.test((await import('/js/sandbox-frame.js')).frameHtml(document.getElementById('appframe'))))));
await espera(6500);
ok('…y sigue a la vista pasado el vigilante del tablero (5 s)', await claw.evaluate(async () => /RELOJ-DE-PRUEBA/.test((await import('/js/sandbox-frame.js')).frameHtml(document.getElementById('appframe')))));
ok('…y el modelo sabe que es la app abierta', await claw.evaluate(async () => (await import('/js/tools/apps.js')).currentApp()) === 'reloj');

ok('sin errores de página', errores.length === 0, errores.slice(0, 3).join(' | '));
await fin(b, 'COPILOTO: transcripción aparte, solo el consejo, nombre con mayúscula, CSV que descarga, Abrir que se respeta');
