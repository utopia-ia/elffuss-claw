// Proveedor ONNX (transformers.js) y la señal de parar.
//
// Antes la señal solo silenciaba el streamer: el modelo seguía generando hasta
// acabar la respuesta, con la CPU/GPU ocupada, y chat() devolvía el texto
// entero como si nada. Ahora se pasa un InterruptableStoppingCriteria como
// stopping_criteria, abortar llama a interrupt() y chat() rechaza con
// AbortError (con lo generado en `partial`).
//
// Sin modelo: un generador de mentira que se porta como el bucle de
// transformers.js en lo que importa aquí (llama al criterio de parada en cada
// paso y entrega cada trozo al streamer). Se prueba con un criterio local que
// imita al de la librería, con el InterruptableStoppingCriteria REAL de
// transformers.js (si el CDN responde) y sin criterio (librería sin la clase:
// debe degradar a «dejar de pintar» y aun así rechazar con AbortError).
//
//   BASE=http://localhost:8742 node tests/onnx-stop.mjs
import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:8742';
let fails = 0; const ok = (n, c, e = '') => { console.log((c ? '✅' : '❌') + ' ' + n + (e ? '  — ' + e : '')); if (!c) fails++; };

const b = await chromium.launch();
const ctx = await b.newContext();
await ctx.addInitScript(() => { try { localStorage.setItem('elffuss.model', 'rules'); } catch {} });
const p = await ctx.newPage();
await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1000);

const r = await p.evaluate(async () => {
  const onnx = await import('/js/providers/onnx.js');
  if (typeof onnx.__usarGenerador !== 'function') return { sinGancho: true };
  // Sin pedirlo, el gancho se niega: en la app no cambia el modelo cargado.
  let sinPedir = null;
  try { onnx.__usarGenerador(() => {}, class {}); } catch (e) { sinPedir = e.message; }
  globalThis.__ELFFUSS_PRUEBAS__ = true;
  const N = 30;
  // Igual que Callable/StoppingCriteria de transformers.js: la instancia se
  // llama como función y devuelve un booleano por secuencia del lote.
  class CorteLocal {
    constructor() { this.interrupted = false; const f = (ids) => new Array(ids.length).fill(f.interrupted); f.interrupted = false; f.interrupt = () => { f.interrupted = true; }; return f; }
  }
  class Streamer { constructor(_tok, o) { this.o = o; } put(t) { this.o.callback_function(t); } end() {} }
  const generador = (cuenta) => {
    const g = async (messages, opts) => {
      let texto = '';
      for (let i = 0; i < N; i++) {
        const sc = opts.stopping_criteria;
        if (sc && sc([[0]], null).every(Boolean)) break;
        await new Promise(r => setTimeout(r, 15));
        const t = 'p' + i + ' ';
        texto += t; cuenta.pasos++;
        opts.streamer.put(t);
      }
      return [{ generated_text: [...messages, { role: 'assistant', content: texto }] }];
    };
    g.tokenizer = {};
    return g;
  };
  const prueba = async (Corte, { abortarTras = 3, yaAbortada = false } = {}) => {
    const cuenta = { pasos: 0 };
    onnx.__usarGenerador(generador(cuenta), Streamer, Corte);
    const ac = new AbortController();
    if (yaAbortada) ac.abort();
    const toks = []; let err = null, out = null;
    try {
      out = await onnx.chat([{ role: 'user', content: 'hola' }], 'sistema', t => { toks.push(t); if (abortarTras && toks.length === abortarTras) ac.abort(); }, ac.signal);
    } catch (e) { err = { name: e.name, partial: e.partial }; }
    return { pasos: cuenta.pasos, toks: toks.length, err, out };
  };
  const res = {
    local: await prueba(CorteLocal),
    sinClase: await prueba(null),
    yaAbortada: await prueba(CorteLocal, { yaAbortada: true }),
    normal: await prueba(CorteLocal, { abortarTras: 0 }),
  };
  // El de verdad: la copia fijada del SDK que usa onnx.js (js/tf-runtime.js; solo el módulo, ningún modelo).
  try {
    const tf = await (await import('/js/tf-runtime.js')).loadTransformers();
    res.clase = typeof tf.InterruptableStoppingCriteria;
    if (res.clase === 'function') res.real = await prueba(tf.InterruptableStoppingCriteria);
  } catch (e) { res.cdn = String(e?.message || e).slice(0, 120); }
  return { N, sinPedir, ...res };
});

if (r.sinGancho) { ok('onnx.js expone __usarGenerador para la prueba', false); }
else {
  ok('sin pedirlo, el gancho __usarGenerador se niega (en la app no cambia el modelo)', /solo para pruebas/.test(r.sinPedir || ''), r.sinPedir || 'no lanzó');
  ok('con criterio de parada: la generación se corta (no llega al final)', r.local.pasos <= 4 && r.local.pasos < r.N, `${r.local.pasos} pasos de ${r.N}`);
  ok('  …chat() rechaza con AbortError y lo generado en «partial»', r.local.err?.name === 'AbortError' && r.local.err?.partial === 'p0 p1 p2', JSON.stringify(r.local.err));
  ok('  …y no entrega ni un token más tras parar', r.local.toks === 3, `${r.local.toks} tokens`);
  ok('sin la clase en la librería: no rompe, deja de pintar y rechaza con AbortError', r.sinClase.err?.name === 'AbortError' && r.sinClase.toks === 3,
    `${r.sinClase.pasos} pasos (sin corte, llega al final) · ${r.sinClase.toks} tokens · ${JSON.stringify(r.sinClase.err)}`);
  ok('señal ya abortada: rechaza sin generar', r.yaAbortada.err?.name === 'AbortError' && r.yaAbortada.pasos === 0, `${r.yaAbortada.pasos} pasos`);
  ok('sin parar: devuelve la respuesta entera', !r.normal.err && r.normal.pasos === r.N && r.normal.out?.startsWith('p0 p1'), `${r.normal.pasos} pasos`);
  if (r.cdn) console.log(`⚠️  InterruptableStoppingCriteria real: NO PROBADO (no se pudo cargar transformers.js: ${r.cdn})`);
  else {
    ok('transformers.js@4 exporta InterruptableStoppingCriteria', r.clase === 'function', r.clase);
    if (r.real) ok('  …y con la clase REAL la generación también se corta', r.real.pasos <= 4 && r.real.err?.name === 'AbortError', `${r.real.pasos} pasos · ${JSON.stringify(r.real.err)}`);
  }
}

console.log(fails ? `\n❌ ${fails} FALLO(S)` : '\n✅ ONNX OK — parar corta la generación, no solo la pantalla');
await b.close();
process.exit(fails ? 1 : 0);
