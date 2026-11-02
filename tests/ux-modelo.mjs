// Selector de modelo.
//   · Nombre accesible propio y estado del punto con palabras.
//   · Si el cerebro elegido no carga, se vuelve al que FUNCIONABA (no a Básico),
//     también si es un Gemma (su respaldo ligero es solo para cuando no había otro).
//   · Mientras carga, el selector está desactivado (sin cargas en paralelo).
//   · Cambiar de cerebro no te saca de la pestaña en la que estás.
//   · Barra de progreso accesible; ⓘ a la ficha del modelo; etiquetas en inglés.
//
//   BASE=http://localhost:8743 node tests/ux-modelo.mjs
import { createServer } from 'node:http';
import { navegador, contexto, ok, hasta, espera, escribir, reposo, avisos, fin, BASE } from './ux-comun.mjs';

const servidor = createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'respuesta de ollama' } }] })}\n\n`);
    res.write('data: [DONE]\n\n'); res.end();
  });
});
await new Promise(r => servidor.listen(0, '127.0.0.1', r));
const PROV = JSON.stringify({
  ollama: { enabled: true, baseURL: `http://localhost:${servidor.address().port}/v1`, model: 'falso', apiKey: 'ollama' },
  openai: { enabled: true, baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' },   // sin clave: no carga
});
const b = await navegador();
const { ctx } = await contexto(b, { model: 'ext:ollama', extraInit: { 'elffuss.providers': PROV } });
const p = await ctx.newPage({ viewport: { width: 1400, height: 900 } });
const errores = [];
p.on('pageerror', e => { if (!/allow-same-origin/.test(e.message)) errores.push(e.message); });
await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
const listo = () => p.evaluate(() => document.getElementById('model-select').value === 'ext:ollama' && document.getElementById('model-status').classList.contains('on'));
ok('Ollama (de prueba) cargado', await hasta(listo));
// Un cerebro que carga al momento no deja puesto el escaparate de descarga
// («Preparando tu sistema operativo…»): su módulo llegaba DESPUÉS de que la
// carga terminara, y se montaba para quedarse.
ok('un cerebro que carga al momento no deja el escaparate de descarga en la Vista', await hasta(() => p.evaluate(() =>
  !document.getElementById('loading-stage') && !document.getElementById('vista-empty').hidden)),
  await p.evaluate(() => document.getElementById('loading-stage') ? 'escaparate puesto' : 'sin placeholder'));
ok('el selector se llama «Cerebro (modelo de IA)» y el punto dice su estado', await p.getAttribute('#model-select', 'aria-label') === 'Cerebro (modelo de IA)'
  && await p.getAttribute('#model-status', 'aria-label') === 'Modelo listo');
// …y lo dice también a la vista, con palabras: el punto solo era un color.
ok('junto al punto, el estado en palabras («Listo»), visible', await p.evaluate(() => {
  const t = document.getElementById('model-status-txt');
  return t?.textContent === 'Listo' && t.getClientRects().length > 0 && getComputedStyle(t).visibility !== 'hidden';
}));

await p.click('#tabs button[data-tab="ajustes"]');
await p.evaluate(() => {
  window.__desactivado = [];
  const s = document.getElementById('model-select');
  new MutationObserver(() => window.__desactivado.push(s.disabled)).observe(s, { attributes: true, attributeFilter: ['disabled'] });
  s.value = 'ext:openai';
  s.dispatchEvent(new Event('change'));
});
ok('si el elegido no carga, lo dice y sigue con el que funcionaba', await hasta(async () =>
  (await avisos(p)).some(t => /Sigo con Ollama/.test(t)) && await listo()), (await avisos(p)).join(' | '));
ok('…mientras cargaba el selector estuvo desactivado y luego se reactivó', await p.evaluate(() =>
  window.__desactivado.includes(true) && !document.getElementById('model-select').disabled));
ok('…y no te sacó de Ajustes para enseñar la descarga', await p.evaluate(() => document.querySelector('#tabs [aria-selected="true"]').dataset.tab === 'ajustes'));
// Con el teclado: el selector vive en el desplegable de la pastilla del cerebro.
// Elegir cierra el desplegable y el foco vuelve a la pastilla (no a <body>),
// también después de la carga.
await p.focus('#model-chip');
await p.keyboard.press('Enter');
ok('la pastilla del cerebro abre el desplegable y enfoca el selector', await hasta(() => p.evaluate(() =>
  !document.getElementById('model-pop').hidden && document.activeElement?.id === 'model-select'
  && document.getElementById('model-chip').getAttribute('aria-expanded') === 'true')));
await p.selectOption('#model-select', 'ext:openai');
ok('elegir cerebro con el teclado: se cierra el desplegable y al acabar la carga el foco está en la pastilla', await hasta(async () =>
  await listo() && await p.evaluate(() => !document.getElementById('model-select').disabled && document.getElementById('model-pop').hidden
    && document.activeElement?.id === 'model-chip')),
  await p.evaluate(() => document.activeElement?.id || document.activeElement?.tagName));
// Escape cierra el desplegable y devuelve el foco a la pastilla.
await p.click('#model-chip');
await p.keyboard.press('Escape');
ok('Escape cierra el desplegable y devuelve el foco a la pastilla', await p.evaluate(() =>
  document.getElementById('model-pop').hidden && document.activeElement?.id === 'model-chip'));
await escribir(p, 'hola');
ok('el cerebro que funcionaba sigue contestando', await hasta(async () => /respuesta de ollama/.test(await p.locator('#log').innerText())));
await reposo(p);

// ── un Gemma que no carga, con otro cerebro funcionando: se vuelve a ESE ─────
// (antes el respaldo de Gemma iba primero y te dejaba en Qwen3.5-0.8B, otra
// descarga de ~600 MB, aunque Ollama funcionaba). Gemma y Qwen son dobles: el
// Gemma falla al cargar y el Qwen cargaría bien, para que se note a cuál va.
await p.route('**/js/providers/litert.js', r => r.fulfill({ contentType: 'text/javascript',
  body: 'export function configure(){} export async function load(){ throw new Error("sin memoria (prueba)"); } export async function chat(){ return ""; }' }));
await p.route('**/js/providers/onnx.js', r => r.fulfill({ contentType: 'text/javascript',
  body: 'window.__qwen = 0; export function configure(){} export async function load(){ window.__qwen++; } export async function chat(h, s, cb){ cb && cb("respuesta de qwen"); return "respuesta de qwen"; }' }));
const elegir = id => p.evaluate(id => {
  const s = document.getElementById('model-select');
  if (![...s.options].some(o => o.value === id)) { const o = document.createElement('option'); o.value = id; o.textContent = id; s.appendChild(o); }
  s.value = id;
  s.dispatchEvent(new Event('change'));
}, id);
await elegir('litert:gemma-e4b');
ok('un Gemma que no carga, con Ollama funcionando: vuelve a Ollama', await hasta(async () =>
  (await avisos(p)).some(t => /No se pudo cargar .*gemma.*Sigo con Ollama/i.test(t)) && await listo()), (await avisos(p)).join(' | '));
ok('…sin pasar por el ligero (Qwen no se carga)', await p.evaluate(() => !window.__qwen && localStorage.getItem('elffuss.model') === 'ext:ollama'));
await escribir(p, 'sigues ahí');
ok('…y contesta Ollama', await hasta(async () => /respuesta de ollama[\s\S]*respuesta de ollama/.test(await p.locator('#log').innerText())));
await reposo(p);
// Sin otro cerebro (desde Básico), el respaldo ligero sigue existiendo.
await elegir('rules');
await hasta(() => p.evaluate(() => document.getElementById('model-select').value === 'rules' && !document.getElementById('model-select').disabled));
await elegir('litert:gemma-e4b');
ok('desde Básico, un Gemma que no carga cae al ligero', await hasta(() => p.evaluate(() =>
  window.__qwen === 1 && document.getElementById('model-select').value === 'onnx:qwen3.5-0.8b')), (await avisos(p)).join(' | '));
await elegir('ext:ollama');
await hasta(listo);
await p.unroute('**/js/providers/litert.js');
await p.unroute('**/js/providers/onnx.js');

// ── barra de progreso y ficha del modelo ────────────────────────────────────
const prog = await p.evaluate(async () => {
  const ui = await import('/js/ui.js');
  ui.modelProgress('Descargando el cerebro · 42 %');
  const t = document.querySelector('#model-progress .track');
  const r = { visible: !document.getElementById('model-progress').hidden, role: t.getAttribute('role'), now: t.getAttribute('aria-valuenow') };
  ui.modelProgress(null);
  ui.setFichaModelo('https://huggingface.co/onnx-community/Qwen3.5-0.8B-ONNX', 'Qwen3.5-0.8B');
  const a = document.getElementById('model-card');
  r.ficha = { hidden: a.hidden, href: a.href, rel: a.rel, label: a.getAttribute('aria-label') };
  return r;
});
ok('fuera de la Vista, el progreso va en la caja flotante con role=progressbar y aria-valuenow', prog.visible && prog.role === 'progressbar' && prog.now === '42', JSON.stringify(prog));
ok('ⓘ enlaza la ficha del modelo (pestaña nueva, sin referrer) con nombre', !prog.ficha.hidden && /huggingface\.co\/onnx-community/.test(prog.ficha.href)
  && prog.ficha.rel === 'noopener noreferrer' && /Qwen3\.5-0\.8B/.test(prog.ficha.label), JSON.stringify(prog.ficha));

// ── en inglés, las coletillas del selector ──────────────────────────────────
{
  const { ctx: c2 } = await contexto(b, { locale: 'en-US' });
  const e = await c2.newPage();
  await e.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await e.waitForFunction(() => !!window.elffuss?.agent);
  const ops = await e.$$eval('#model-select option', os => os.map(o => o.textContent));
  ok('en inglés: «Basic (no model)» y sin coletillas en español', ops.includes('Basic (no model)') && !ops.some(o => /sin modelo|ligero|por defecto/.test(o)), JSON.stringify(ops));
  ok('en inglés: el selector se llama «Brain (AI model)»', await e.getAttribute('#model-select', 'aria-label') === 'Brain (AI model)');
  await c2.close();
}

ok('sin errores de página', errores.length === 0, errores.slice(0, 3).join(' | '));
servidor.close();
await fin(b, 'SELECTOR DE MODELO: vuelve al que funcionaba, se bloquea al cargar y no te mueve de pestaña');
