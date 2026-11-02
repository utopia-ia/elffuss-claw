// Espacio de los modelos: el chip 💾 y «Vaciar caché del modelo» cuentan y
// vacían PESOS, no el origen entero.
//   · Con solo datos tuyos (apps, conversación) no hay chip: antes decía
//     «💾 0 MB … pulsa para vaciarlo».
//   · Con pesos guardados (Cache Storage de cualquier proveedor y el OPFS de
//     modelos) el chip los cuenta y vaciarlo libera eso, dice cuánto, y tus apps
//     siguen ahí.
//   · «Vaciar caché del modelo» se desactiva mientras trabaja y dice cuánto liberó.
//   · El aviso del chip solo nombra el almacén compartido si hay camino a él. Con
//     un SDK de broker que lo sabe medir y vaciar (un doble local): al arrancar no
//     se le pregunta; al abrir Ajustes sí, a todos los orígenes; vaciar los pide
//     a la vez; «En disco» lo suma sin errores.
//
// Las dos mitades sirven el model-broker.js de ESTE árbol con sharedUsage y
// clearShared fuera de los exports: la primera, sin camino al compartido; la
// segunda, con el doble en su lugar. El SDK de main ya los exporta, y añadir el
// doble sin quitarlos daba «export duplicado»: la app no llegaba a arrancar.
//
//   BASE=http://localhost:8743 node tests/ux-modelos.mjs
import { navegador, contexto, pagina, ok, hasta, escribir, reposo, avisos, fin, BASE } from './ux-comun.mjs';

const SIN_COMPARTIDO = src => src.replace(/export\s+async\s+function\s+(sharedUsage|clearShared)\s*\(/g, 'async function __sinExportar_$1(');
async function servirBroker(ctx, doble = '') {
  await ctx.route('**/js/runtime/model-broker.js', async route => {
    const r = await route.fetch();
    await route.fulfill({ response: r, body: SIN_COMPARTIDO(await r.text()) + doble, headers: { ...r.headers(), 'content-type': 'text/javascript' } });
  });
}

const b = await navegador();
const { ctx } = await contexto(b, { grants: ['apps'] });
await servirBroker(ctx);
const { p, errores } = await pagina(ctx);
const listo = () => p.waitForFunction(() => !!window.elffuss?.agent, null, { timeout: 15000 });

await escribir(p, 'hazme un reloj');
await reposo(p);
await p.reload({ waitUntil: 'domcontentloaded' });
await listo();
await p.waitForTimeout(800);
ok('con solo tus datos (una app, la conversación) no hay chip de modelos', await p.evaluate(() => document.getElementById('disk-chip').hidden));

// pesos falsos donde los guardan los proveedores: Cache Storage y OPFS
const sembrar = () => p.evaluate(async () => {
  const c = await caches.open('transformers-cache');
  await c.put('/modelo-falso.bin', new Response(new Uint8Array(3 * 1024 * 1024)));
  const c2 = await caches.open('elffuss-models-v1');
  await c2.put('/gemma-falso.litertlm', new Response(new Uint8Array(1024 * 1024)));
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('elffuss-models', { create: true });
  const f = await dir.getFileHandle('qwen-falso.bin', { create: true });
  const w = await f.createWritable(); await w.write(new Uint8Array(2 * 1024 * 1024)); await w.close();
});
await sembrar();
await p.reload({ waitUntil: 'domcontentloaded' });
await listo();
ok('con pesos guardados aparece el chip y los cuenta (~6 MB)', await hasta(() => p.evaluate(() => {
  const c = document.getElementById('disk-chip');
  return !c.hidden && c.textContent.trim() === '6 MB' && !!c.querySelector('svg');
})), await p.evaluate(() => document.getElementById('disk-chip').textContent));
ok('su nombre accesible dice qué es y qué hace', /Modelos descargados en este navegador: 6 MB/.test(await p.getAttribute('#disk-chip', 'aria-label') || ''));
p.__aceptar = true;
await p.click('#disk-chip');
ok('la confirmación dice cuánto y que tus datos no se tocan', await hasta(() => (p.__dialogos || []).some(m => /6 MB/.test(m) && /ni apps/.test(m))));
ok('…y, sin camino al almacén compartido (el SDK no sabe vaciarlo), no lo promete', (p.__dialogos || []).every(m => !/almacén compartido/.test(m)),
  (p.__dialogos || []).join(' | '));
ok('vaciar dice cuánto se liberó', await hasta(async () => (await avisos(p)).some(t => /Liberados 6 MB/.test(t))), (await avisos(p)).join(' | '));
const tras = await p.evaluate(async () => ({
  chip: document.getElementById('disk-chip').hidden,
  caches: await caches.keys(),
  apps: (await (await import('/js/db.js')).all('apps')).length,
}));
ok('…el chip se va, no queda ninguna caché de modelos y tu app sigue ahí', tras.chip && tras.caches.length === 0 && tras.apps === 1, JSON.stringify(tras));

// ── Ajustes · «Vaciar caché del modelo» ─────────────────────────────────────
await sembrar();
await p.click('#tabs button[data-tab="ajustes"]');
const card = p.locator('#panel-ajustes .card', { hasText: 'Modelo descargado' });
ok('Ajustes cuenta los pesos (no el origen entero)', await hasta(async () => /0\.01 GB en caché/.test(await card.innerText())), await card.innerText());
const boton = card.locator('button', { hasText: 'Vaciar caché del modelo' });
await p.evaluate(() => {
  // ver el botón ocupado mientras trabaja (aria-disabled: con disabled el foco
  // caía a <body> nada más pulsarlo)
  const b = [...document.querySelectorAll('#panel-ajustes button')].find(x => /Vaciar caché del modelo/.test(x.textContent));
  window.__visto = [];
  new MutationObserver(() => window.__visto.push(b.getAttribute('aria-disabled'))).observe(b, { attributes: true, attributeFilter: ['aria-disabled'] });
});
await boton.focus();
await p.keyboard.press('Enter');
ok('el botón queda ocupado mientras vacía y dice cuánto liberó', await hasta(async () => (await avisos(p)).filter(t => /Liberados 6 MB/.test(t)).length >= 1)
  && (await p.evaluate(() => window.__visto)).includes('true'));
ok('…y con el teclado el foco sigue en él al terminar (no cae a <body>)', await hasta(() => p.evaluate(() =>
  /Vaciar caché del modelo/.test(document.activeElement?.textContent || '') && !document.activeElement.hasAttribute('aria-disabled'))),
  await p.evaluate(() => document.activeElement?.textContent || document.activeElement?.tagName));
ok('y después cuenta cero', await hasta(async () => /Nada cacheado todavía/.test(await card.innerText())));

ok('sin errores de página', errores.length === 0, errores.slice(0, 3).join(' | '));

// ── con un SDK de broker que SÍ sabe del almacén compartido ────────────────
// Doble local: el model-broker.js de este árbol con sharedUsage/clearShared que
// apuntan lo que se les pide, y un registro del motor con dos hosts de pesos.
// Nada sale a la red: ni se incrusta ni se consulta ningún broker de verdad.
{
  const DOBLE = `
export async function sharedUsage(o) { (window.__comp ||= []).push(['medir', JSON.stringify(o)]); return { usage: 5 * 1048576, quota: 0, ok: true }; }
export async function clearShared(o) {
  window.__vuelo = (window.__vuelo || 0) + 1; window.__maxVuelo = Math.max(window.__maxVuelo || 0, window.__vuelo);
  (window.__comp ||= []).push(['vaciar', o]);
  await new Promise(r => setTimeout(r, 400));
  window.__vuelo--;
  return { liberado: 1048576, ok: true };
}`;
  const { ctx: c2 } = await contexto(b, { grants: ['apps'] });
  await servirBroker(c2, DOBLE);
  // origenesAlmacen() del registro puede devolver la lista o una promesa de
  // ella: el doble devuelve una promesa, que es el caso que se perdía.
  await c2.route('**/js/engine/registro.js', route => route.fulfill({ contentType: 'text/javascript',
    body: "export const MODELS = {}; export async function disponible() { return false; } export async function origenesAlmacen() { return ['https://m1.elffuss.com/', 'https://m2.elffuss.com/']; }" }));
  const { p: q, errores: errQ } = await pagina(c2);
  await q.evaluate(async () => {
    const c = await caches.open('transformers-cache');
    await c.put('/modelo-falso.bin', new Response(new Uint8Array(3 * 1024 * 1024)));
  });
  await q.reload({ waitUntil: 'domcontentloaded' });
  await q.waitForFunction(() => !!window.elffuss?.agent, null, { timeout: 15000 });
  await hasta(() => q.evaluate(() => !document.getElementById('disk-chip').hidden));
  await q.waitForTimeout(1500);
  const alArrancar = await q.evaluate(() => ({ comp: window.__comp || [], chip: document.getElementById('disk-chip').textContent }));
  ok('al arrancar en Básico, el chip cuenta solo este origen: no pregunta al almacén compartido', !alArrancar.comp.length && alArrancar.chip.trim() === '3 MB',
    JSON.stringify(alArrancar));
  await q.click('#tabs button[data-tab="ajustes"]');
  ok('al abrir Ajustes sí pregunta, a todos los orígenes con pesos', await hasta(() => q.evaluate(() =>
    (window.__comp || []).some(([k, o]) => k === 'medir' && /m1\.elffuss/.test(o) && /m2\.elffuss/.test(o)))));
  const uso = q.locator('#panel-ajustes .card', { hasText: '📊' });
  ok('«En disco» se pinta (no se queda en «…») y suma el compartido sin «?»', await hasta(async () => {
    const txt = await uso.innerText();
    return /En disco[^\n]*\n?[^\n]*\d/.test(txt) && !/En disco[^\n]*…/.test(txt) && !/ · \?/.test(txt);
  }), await uso.innerText());
  q.__aceptar = true;
  await q.click('#disk-chip');
  ok('con almacén compartido, la confirmación lo menciona', await hasta(() => (q.__dialogos || []).some(m => /almacén compartido/.test(m))),
    (q.__dialogos || []).join(' | '));
  ok('vaciar pide a todos los brokers A LA VEZ (models, m1 y m2 en paralelo)', await hasta(() => q.evaluate(() =>
    (window.__comp || []).filter(([k]) => k === 'vaciar').length === 3 && window.__maxVuelo === 3)),
  JSON.stringify(await q.evaluate(() => ({ comp: window.__comp, max: window.__maxVuelo }))));
  ok('…y dice cuánto liberó, contando el compartido', await hasta(async () => (await avisos(q)).some(t => /Liberados 6 MB/.test(t))), (await avisos(q)).join(' | '));
  ok('sin errores de página con el almacén compartido', errQ.length === 0, errQ.slice(0, 3).join(' | '));
  await c2.close();
}
await fin(b, 'MODELOS: el chip 💾 y «Vaciar caché» cuentan y vacían pesos, no tus datos');
