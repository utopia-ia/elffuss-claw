// Utilidades comunes de los tests de UX (tests/ux-*.mjs). Sin modelo ni GPU:
// modo básico, determinista. Las peticiones a terceros se cortan aquí para que
// ningún test dependa de la red ni toque producción; three.js (la Mente) es lo
// único que se deja pasar, y solo si un test abre la Mente.
//
//   python3 server/serve.py 8743 &   BASE=http://localhost:8743 node tests/ux-<algo>.mjs
import { chromium } from 'playwright';

export const BASE = process.env.BASE || 'http://localhost:8743';
export const OUT = process.env.SCRATCH || '';

let fails = 0;
export const ok = (n, c, e = '') => { console.log((c ? '✅' : '❌') + ' ' + n + (e ? '  — ' + e : '')); if (!c) fails++; };
export const fallos = () => fails;
export const espera = ms => new Promise(r => setTimeout(r, ms));
export async function hasta(cond, { veces = 200, cada = 50 } = {}) {
  for (let i = 0; i < veces; i++) { if (await cond()) return true; await espera(cada); }
  return false;
}

// Lo que NO puede salir de la máquina en un test: el modelo grande, el broker,
// SoundCloud, Hugging Face, GitHub (salvo que el test lo stubee), producción.
const CORTAR = [
  /^https:\/\/([a-z0-9-]+\.)?soundcloud\.com\//,
  /^https:\/\/([a-z0-9-]+\.)?huggingface\.co\//,
  /^https:\/\/([a-z0-9-]+\.)?hf\.co\//,
  /^https:\/\/(m\d+|models)\.elffuss\.(com|utopiaia\.com)\//,
  /^https:\/\/([a-z0-9-]+\.)?elffuss\.com\//,
  /^https:\/\/([a-z0-9-]+\.)?openverse\.org\//,
  /^https:\/\/([a-z0-9-]+\.)?duckduckgo\.com\//,
  /^https:\/\/cdn\.sheetjs\.com\//,
  /^https:\/\/cdn\.jsdelivr\.net\/npm\/@huggingface\//,
  /^https:\/\/cdn\.jsdelivr\.net\/npm\/@mlc-ai\//,
  /^https:\/\/cdn\.jsdelivr\.net\/npm\/@litert/,
  /^https:\/\/([a-z0-9-]+\.)?googleapis\.com\//,
  /^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//,
];

// Las librerías de modelos vendorizadas (web/vendor/third-party/): LiteRT-LM, WebLLM, Transformers.js y ONNX Runtime.
export const LIBS_MODELO = /\/vendor\/third-party\/(@litert-lm|@litertjs|@mlc-ai|@huggingface|onnxruntime-web)[^/]*\//;

export async function navegador() { return chromium.launch(); }

// Contexto con Claw en modo básico, ya «bienvenido» y con los permisos que se
// pidan. `rutas` permite stubear una URL externa: (url, route) → true si la
// atendió.
export async function contexto(b, { locale = 'es-ES', viewport = { width: 1400, height: 900 }, welcomed = true,
  model = 'rules', grants = null, rutas = null, isMobile = false, hasTouch = false, extraInit = null } = {}) {
  const ctx = await b.newContext({ locale, viewport, acceptDownloads: true, isMobile, hasTouch });
  const fuera = [];
  await ctx.route('**/*', async route => {
    const url = route.request().url();
    // Las librerías de los modelos (antes de un CDN que aquí se cortaba, ahora de este origen) también se cortan: sin
    // ellas el arranque cae enseguida al modo básico, como antes, en vez de intentar bajar pesos que aquí no hay.
    if (url.startsWith(BASE) && LIBS_MODELO.test(url)) return route.abort();
    if (url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    if (rutas && await rutas(url, route)) return;
    fuera.push(route.request().method() + ' ' + url.slice(0, 140));
    if (CORTAR.some(rx => rx.test(url))) return route.abort();
    return route.continue();
  });
  await ctx.addInitScript(({ welcomed, model, grants, extraInit }) => {
    try {
      if (welcomed) localStorage.setItem('elffuss.welcomed', '1');
      if (model) localStorage.setItem('elffuss.model', model);
      if (grants) localStorage.setItem('elffuss.grants', JSON.stringify(grants));
      if (extraInit) for (const [k, v] of Object.entries(extraInit)) localStorage.setItem(k, v);
    } catch { /* */ }
  }, { welcomed, model, grants, extraInit });
  return { ctx, fuera };
}

export async function pagina(ctx, ruta = '/') {
  const p = await ctx.newPage();
  const errores = [];
  p.on('pageerror', e => { if (!/allow-same-origin/.test(e.message)) errores.push(e.message); });
  p.on('dialog', d => { p.__dialogos = (p.__dialogos || []).concat(d.message()); (p.__aceptar === false ? d.dismiss() : d.accept()).catch(() => {}); });
  await p.goto(BASE + ruta, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.elffuss?.agent, null, { timeout: 15000 });
  return { p, errores };
}

export const kv = (p, key) => p.evaluate(async k => (await import('/js/db.js')).get('kv', k), key);
export const avisos = p => p.$$eval('#toasts .toast .toast-txt', ts => ts.map(t => t.textContent));
export async function escribir(p, texto) { await p.fill('#prompt', texto); await p.press('#prompt', 'Enter'); }
export const reposo = p => hasta(() => p.evaluate(() => !document.getElementById('send').classList.contains('is-stop')
  && !document.querySelector('#log .msg.thinking')));

export function fin(b, titulo) {
  console.log(fails ? `\n❌ ${fails} FALLO(S)` : `\n✅ ${titulo}`);
  return b.close().then(() => process.exit(fails ? 1 : 0));
}
