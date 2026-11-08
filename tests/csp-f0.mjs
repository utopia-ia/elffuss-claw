// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Claw under its production security headers (Elffuss Link F0, deploy/headers.json): the main flows run with the
// strict policy ENFORCED and Trusted Types report-only, with the production origins (tests/csp-f0-servidor.mjs), and
// the test counts every policy violation and every host the browser asked for.
//
//   node tests/csp-f0.mjs            phase 2 (enforced)          CSP_PHASE=1 node tests/csp-f0.mjs   phase 1
//
// Needs web/vendor/third-party/ (node third-party.mjs --ensure), the media SDK runtimes (node ai-sync.mjs) and the
// engine in web/js/engine/. No GPU and no model weights: the model is a scripted one; what would download weights
// fails to resolve (every host but the four of the server does), and the test only checks that nothing asked a CDN.
//
// Flows: load; a chat turn whose answer creates an app (its inline script must run, in /sandbox/run.html, with an
// opaque origin); the Apps panel opening it again; attaching a PDF (PDF.js and its worker from the SDK copy);
// a voice note from a fake microphone; the memory store page; the Mind (three.js, vendored); the vendored libraries
// loaded and run (LiteRT-LM and its WebAssembly, WebLLM, SheetJS, Transformers.js + ONNX Runtime); the bridge framed
// by elffuss.com; other sites refused by frame-ancestors; the sandbox page opaque even when opened on its own.
// A violation that is ENFORCED anywhere is a failure. Trusted Types reports (report-only) are counted and listed:
// they are the work left before Trusted Types can be enforced.
import { chromium } from 'playwright';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { arrancar, APP_HTML } from './csp-f0-servidor.mjs';
import { CHROME_ARGS } from './chrome-args.mjs';

const PHASE = Number(process.env.CSP_PHASE || 2);
const srv = await arrancar({ phase: PHASE });
let fallos = 0;
const ok = (n, c, e = '') => { console.log((c ? '✅' : '❌') + ' ' + n + (e ? '  — ' + e : '')); if (!c) fallos++; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(cond, { veces = 150, cada = 100 } = {}) {
  for (let i = 0; i < veces; i++) { try { if (await cond()) return true; } catch { /* aún no */ } await espera(cada); }
  return false;
}
const CLAW = 'https://claw.elffuss.com';
// Hosts the browser may ASK for in this run: the four of the server, and the model hosts that a voice note or the
// Mind would reach for (they fail to resolve here). A CDN in this list is a failure by itself.
const CDN = /(^|\.)(jsdelivr\.net|unpkg\.com|esm\.sh|cdnjs\.cloudflare\.com|googleapis\.com|gstatic\.com|sheetjs\.com|skypack\.dev|jspm\.io)$/;

const b = await chromium.launch({
  channel: 'chrome', headless: true,
  args: [...srv.args, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ...CHROME_ARGS],
});
const ctx = await b.newContext({ locale: 'es-ES', viewport: { width: 1400, height: 900 }, permissions: ['microphone'] });
const violaciones = [];   // { disp, dir, blocked, doc, src, sample }
const consola = [];
const pedidos = new Map(); // host → count
const errores = [];
ctx.on('request', (r) => { try { const h = new URL(r.url()).host; if (h) pedidos.set(h, (pedidos.get(h) || 0) + 1); } catch { /* data:, blob: */ } });
await ctx.addInitScript(() => {
  addEventListener('securitypolicyviolation', (e) => {
    console.log('CSPV ' + JSON.stringify({ disp: e.disposition, dir: e.effectiveDirective, blocked: String(e.blockedURI || '').slice(0, 140),
      doc: String(e.documentURI || '').slice(0, 100), src: String(e.sourceFile || '').slice(0, 120) + ':' + e.lineNumber, sample: String(e.sample || '').slice(0, 60) }));
  }, true);
});
const vigila = (p) => {
  p.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('CSPV ')) { try { violaciones.push(JSON.parse(t.slice(5))); } catch { /* — */ } return; }
    if (m.type() === 'error' || /Content Security Policy|Trusted Type|Refused to/i.test(t)) consola.push(`${p.url().slice(0, 60)} ${m.type()}: ${t.slice(0, 220)}`);
  });
  p.on('pageerror', (e) => errores.push(`${p.url().slice(0, 60)}: ${e.message.slice(0, 200)}`));
  p.on('worker', (w) => w.on('console', (m) => { if (/Content Security Policy|Refused to|Trusted Type/i.test(m.text())) consola.push(`worker ${w.url().slice(0, 80)}: ${m.text().slice(0, 200)}`); }));
};
ctx.on('page', vigila);

await ctx.addInitScript(() => {
  try {
    if (location.hostname !== 'claw.elffuss.com') return;
    localStorage.setItem('elffuss.welcomed', '1');
    localStorage.setItem('elffuss.model', 'ext:ollama');
    localStorage.setItem('elffuss.model.elegido', 'ext:ollama');
    localStorage.setItem('elffuss.providers', JSON.stringify({ ollama: { enabled: true, baseURL: 'https://claw.elffuss.com/fake-llm/v1', model: 'guion', apiKey: 'x' } }));
    if (!localStorage.getItem('elffuss.grants')) localStorage.setItem('elffuss.grants', JSON.stringify(['memory', 'apps']));
  } catch { /* — */ }
});

// ── 1. Carga ────────────────────────────────────────────────────────────────
const p = await ctx.newPage();
const resp = await p.goto(CLAW + '/', { waitUntil: 'domcontentloaded' });
const h = resp.headers();
ok(`fase ${PHASE}: la página llega con la política ${PHASE === 2 ? 'aplicada' : 'en informe (aplicados solo frame-ancestors, object-src y base-uri)'}`,
  PHASE === 2 ? /script-src 'self' 'wasm-unsafe-eval' 'sha256-/.test(h['content-security-policy'] || '')
    : /^frame-ancestors [^;]+; object-src 'none'; base-uri 'none'$|^object-src 'none'; base-uri 'none'; frame-ancestors [^;]+$/.test(h['content-security-policy'] || '') && /script-src/.test(h['content-security-policy-report-only'] || ''), h['content-security-policy']);
ok('Trusted Types en informe (no aplicado)', /require-trusted-types-for 'script'/.test(h['content-security-policy-report-only'] || '') && !/trusted-types/.test(h['content-security-policy'] || ''));
ok('COOP unsafe-none (Claw contesta a quien lo abre), HSTS, nosniff, sin referrer, OAC',
  h['cross-origin-opener-policy'] === 'unsafe-none' && /max-age=/.test(h['strict-transport-security'] || '') && h['x-content-type-options'] === 'nosniff'
  && h['referrer-policy'] === 'no-referrer' && h['origin-agent-cluster'] === '?1');
ok('Claw arranca con el cerebro guionado', await hasta(() => p.evaluate(() => document.getElementById('model-select')?.value === 'ext:ollama'
  && document.getElementById('model-status')?.classList.contains('on')), { veces: 250 }));

// ── 2. Un turno que crea una app ────────────────────────────────────────────
const corrio = p.evaluate(() => new Promise((ok) => {
  addEventListener('message', (e) => { if (e.data?.cspf0 === 'app-ran') ok(e.data); });
  setTimeout(() => ok(null), 20000);
}));
const antes = srv.llm.length;
await p.fill('#prompt', 'hazme un reloj');
await p.press('#prompt', 'Enter');
ok('el modelo guionado contesta (la petición sale a /fake-llm, mismo origen)', await hasta(() => srv.llm.length > antes, { veces: 100 }));
const msg = await corrio;
ok('la app se crea y su script EN LÍNEA corre (en /sandbox/run.html)', !!msg, JSON.stringify(msg));
ok('…con origen opaco (no puede tocar el almacenamiento de Claw)', msg?.origin === 'null', msg?.origin);
const marco = p.frames().find((f) => f.url().startsWith(CLAW + '/sandbox/run.html'));
ok('…y pinta lo que debe', !!marco && (await marco.evaluate(() => document.getElementById('t')?.textContent).catch(() => '')) === 'corre-42');
ok('el visor sabe qué enseña (frameHtml, antes srcdoc)', await p.evaluate(async (html) => (await import('/js/sandbox-frame.js')).frameHtml(document.getElementById('appframe')) === html, APP_HTML));
await hasta(() => p.evaluate(() => !document.getElementById('send').classList.contains('is-stop')), { veces: 100 });

// ── 3. El panel de Apps la vuelve a abrir ───────────────────────────────────
await p.click('#tab-apps');
await hasta(() => p.evaluate(() => !!document.querySelector('#panel-apps .card[data-app="reloj"] button')));
const abierta = p.evaluate(() => new Promise((ok) => {
  addEventListener('message', (e) => { if (e.data?.cspf0 === 'app-ran') ok(true); });
  setTimeout(() => ok(false), 10000);
})).catch(() => false);
const abrio = await p.evaluate(() => {
  const b = document.querySelector('#panel-apps .card[data-app="reloj"] button:not(.borrar-app)');
  if (!b) return false;
  b.click(); return true;
});
ok('Apps: la app guardada se abre otra vez y corre', abrio && await abierta);

// ── 4. Adjuntar un PDF (PDF.js de la copia del SDK, con su worker) ──────────
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj ' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj ' +
  '4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 20 100 Td (hola csp) Tj ET\nendstream endobj ' +
  '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const input = await p.$('input.att-input[accept*="pdf"], input#att-doc, input.att-input');
if (input) {
  await input.setInputFiles({ name: 'prueba.pdf', mimeType: 'application/pdf', buffer: pdf });
  ok('adjuntar un PDF: se lee en el navegador (sin CDN)', await hasta(() => p.evaluate(() =>
    [...document.querySelectorAll('#att-chips .att-chip-state')].some((s) => !/leyendo|reading/i.test(s.textContent || ''))), { veces: 150 }),
    await p.evaluate(() => document.getElementById('att-chips')?.textContent?.slice(0, 120)));
} else ok('adjuntar: hay un campo de fichero', false);

// ── 5. Nota de voz con un micrófono de mentira ─────────────────────────────
const conMic = await p.evaluate(() => !!document.getElementById('mic-btn'));
if (conMic) {
  await p.evaluate(() => document.getElementById('mic-btn').click());
  ok('nota de voz: graba (getUserMedia permitido por Permissions-Policy microphone=(self))',
    await hasta(() => p.evaluate(() => document.getElementById('mic-btn')?.getAttribute('aria-pressed') === 'true'), { veces: 60 }));
  await espera(1500);
  await p.evaluate(() => document.querySelector('.rec-send')?.click());
  await hasta(() => p.evaluate(() => !!document.getElementById('perm-dialog')?.open || /transcrib|escrib/i.test(document.getElementById('att-chips')?.textContent || '')), { veces: 60 });
  // La descarga del modelo de voz pide permiso: se deniega (en esta prueba no hay pesos).
  await p.evaluate(() => document.getElementById('perm-deny')?.click()).catch(() => {});
  ok('nota de voz: termina sin colgarse', await hasta(() => p.evaluate(() => document.getElementById('mic-btn')?.getAttribute('aria-pressed') === 'false'), { veces: 80 }));
} else ok('nota de voz: hay botón de micrófono', false);

// ── 6. La Mente (three.js vendorizado) ──────────────────────────────────────
await p.evaluate(() => document.getElementById('btn-mind')?.click());
ok('la Mente abre con three.js de este origen', await hasta(() => p.evaluate(() => !!document.querySelector('#mind-overlay canvas, .mind canvas, canvas.mind, [id*="mind"] canvas')), { veces: 100 }));
await p.keyboard.press('Escape');

// ── 7. Las librerías vendorizadas cargan y corren aquí ──────────────────────
const libs = await p.evaluate(async () => {
  const out = {};
  try {
    const XLSX = await import('/vendor/third-party/xlsx@0.20.3/xlsx.mjs');
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', 'b'], [1, 2]]), 'h');
    const back = XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), { type: 'array' });
    out.xlsx = XLSX.utils.sheet_to_csv(back.Sheets.h);
  } catch (e) { out.xlsx = 'ERR ' + e.message; }
  try { const w = await import('/vendor/third-party/@mlc-ai/web-llm@0.2.85/lib/index.js'); out.webllm = typeof w.CreateMLCEngine; } catch (e) { out.webllm = 'ERR ' + e.message; }
  try {
    const l = await import('/vendor/third-party/@litert-lm/core@0.15.0/dist/index.js');
    const lib = await l.loadLiteRtLm(location.origin + '/vendor/third-party/@litert-lm/core@0.15.0/wasm/');
    out.litert = typeof lib === 'object' && !!lib ? 'loaded' : String(lib);
  } catch (e) { out.litert = 'ERR ' + e.message; }
  try {
    const tf = await (await import('/js/tf-runtime.js')).loadTransformers();
    out.tf = tf.env.version + ' ' + tf.env.backends.onnx.versions?.web + ' ' + String(tf.env.backends.onnx.wasm.wasmPaths).includes('/vendor/third-party/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/');
    out.ortMjs = typeof (await import('/vendor/third-party/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.asyncify.mjs')).default;
  } catch (e) { out.tf = 'ERR ' + e.message; }
  try { const t = await import('three'); out.three = t.REVISION; } catch (e) { out.three = 'ERR ' + e.message; }
  return out;
});
ok('SheetJS (vendorizado) escribe y lee un .xlsx', libs.xlsx === 'a,b\n1,2', libs.xlsx);
ok('WebLLM (vendorizado) carga', libs.webllm === 'function', libs.webllm);
ok('LiteRT-LM (vendorizado) carga su WebAssembly de este origen', libs.litert === 'loaded', libs.litert);
ok('Transformers.js 4.3.2 (lo que servía el CDN), con el ONNX Runtime que nombra y su WebAssembly de este origen', libs.tf === '4.3.2 1.31.0-dev.20260914-8d85527a0 true', libs.tf);
ok('…y el cargador del WebAssembly de ONNX Runtime se importa de este origen', libs.ortMjs === 'function', libs.ortMjs);
ok('three.js por el import map (con integridad)', libs.three === '160', libs.three);

// ── 8. La página almacén de la memoria ──────────────────────────────────────
const mem = await ctx.newPage();
const rm = await mem.goto(CLAW + '/memory/');
ok('la página almacén abre con su política (connect-src none) y HSTS', /connect-src 'none'/.test(rm.headers()['content-security-policy'] || '') && /max-age/.test(rm.headers()['strict-transport-security'] || ''));
ok('…y pinta', await hasta(() => mem.evaluate(() => document.body.innerText.trim().length > 0)));
await mem.close();

// ── 9. El puente, desde elffuss.com ─────────────────────────────────────────
const chat = await ctx.newPage();
await chat.goto('https://elffuss.com/');
const puente = await chat.evaluate(() => Promise.race([window.puente, new Promise((r) => setTimeout(() => r(null), 10000))]));
ok('el chat (elffuss.com) usa el puente de Claw: apps.list contesta', puente?.ok === true && Array.isArray(puente.result), JSON.stringify(puente)?.slice(0, 120));
// El panel de apps del chat enmarca Claw entero (chat/appview.js): frame-ancestors https://elffuss.com.
ok('el chat (elffuss.com) puede enmarcar Claw (panel de apps)', await hasta(async () => {
  const f = chat.frames().find((x) => x.url() === CLAW + '/');
  return !!f && await f.evaluate(() => !!window.elffuss?.agent || !!document.getElementById('prompt'));
}, { veces: 150 }));
// …y dentro, la caja de Claw sigue funcionando (sus ancestros son Claw y elffuss.com).
const enMarco = chat.frames().find((x) => x.url() === CLAW + '/');
const corrioEnMarco = enMarco && await enMarco.evaluate(async (html) => {
  const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); document.body.appendChild(f);
  const r = new Promise((ok) => { addEventListener('message', (e) => { if (e.data?.cspf0 === 'app-ran') ok(true); }); setTimeout(() => ok(false), 8000); });
  (await import('/js/sandbox-frame.js')).setFrameHtml(f, html);
  return r;
}, APP_HTML).catch(() => false);
ok('…y su caja (/sandbox/) corre dentro del marco (frame-ancestors con los dos ancestros)', corrioEnMarco === true);
await chat.close();

// ── 10. Otros sitios no pueden enmarcar ─────────────────────────────────────
const evil = await ctx.newPage();
await evil.goto('https://evil.test/');
await espera(2500);
const dentro = await evil.evaluate(() => ['claw', 'bridge', 'sbx', 'store'].map((id) => {
  try { return document.getElementById(id).contentWindow.length; } catch { return 'x'; }
}));
const cargados = evil.frames().filter((f) => f !== evil.mainFrame()).map((f) => f.url());
// Chrome dice el origen, no la ruta: Claw y el puente («frame-ancestors https://elffuss.com», dos veces), la caja y
// el almacén de modelos, bloqueados por la política aplicada (no la de informe).
const bloqueos = consola.filter((c) => c.startsWith('https://evil.test/') && /frame-ancestors/.test(c) && !/report-only/.test(c));
const n = (re) => bloqueos.filter((c) => re.test(c)).length;
ok('evil.test no puede enmarcar Claw, el puente, la caja ni el almacén de modelos (frame-ancestors)',
  n(/directive: "frame-ancestors https:\/\/elffuss\.com"/) >= 2 && n(/"frame-ancestors https:\/\/claw\.elffuss\.com https:\/\/elffuss\.com"/) >= 1 && n(/Framing 'https:\/\/models\.elffuss\.com\/'/) >= 1,
  bloqueos.length + ' ' + JSON.stringify(dentro));
await evil.close();

// ── 11. La caja abierta sola es de origen opaco ─────────────────────────────
const sola = await ctx.newPage();
await sola.goto(CLAW + '/sandbox/run.html?n=1');
ok('la caja abierta sola: origen opaco (directiva sandbox)', await sola.evaluate(() => window.origin) === 'null');
await sola.close();

// ── Balance ─────────────────────────────────────────────────────────────────
await espera(500);
const aplicadas = violaciones.filter((v) => v.disp === 'enforce');
const tt = violaciones.filter((v) => v.disp === 'report' && /trusted-types/.test(v.dir));
const informe = violaciones.filter((v) => v.disp === 'report' && !/trusted-types/.test(v.dir));
const resumen = (vs) => [...new Map(vs.map((v) => [`${v.dir} ${v.blocked} @ ${v.src}`, v])).keys()];
ok(`ninguna violación de la política aplicada (${aplicadas.length})`, aplicadas.length === 0, resumen(aplicadas).slice(0, 12).join(' | '));
ok(`ninguna violación en informe fuera de Trusted Types (${informe.length})`, informe.length === 0, resumen(informe).slice(0, 12).join(' | '));
console.log(`ℹ️  Trusted Types (solo informe): ${tt.length} avisos, ${resumen(tt).length} sitios distintos`);
for (const s of resumen(tt).slice(0, 15)) console.log('     · ' + s);
const hosts = [...pedidos.keys()].sort();
ok('ningún CDN pedido', !hosts.some((x) => CDN.test(x.replace(/:\d+$/, ''))), hosts.join(', '));
console.log('ℹ️  hosts pedidos: ' + hosts.map((x) => `${x}×${pedidos.get(x)}`).join(', '));
const extranos = hosts.filter((x) => !/^(claw|models)\.elffuss\.com$|^elffuss\.com$|^evil\.test$/.test(x));
console.log('ℹ️  fuera del servidor de prueba (no resuelven aquí): ' + (extranos.join(', ') || 'ninguno'));
ok('ningún error de página', errores.length === 0, errores.slice(0, 5).join(' | '));
// Lo que evil.test intenta enmarcar se bloquea a propósito (frame-ancestors): esa es la prueba 10, no un fallo.
const cspConsola = consola.filter((c) => /Content Security Policy|Refused to/i.test(c) && !/Report Only|report-only|Trusted Type/i.test(c) && !c.startsWith('https://evil.test/'));
ok('la consola no muestra bloqueos de CSP', cspConsola.length === 0, cspConsola.slice(0, 6).join(' | '));
if (process.env.CSP_F0_OUT) {
  const dir = process.env.CSP_F0_OUT;
  writeFileSync(join(dir, `claw-fase${PHASE}.json`), JSON.stringify({ violaciones, consola, hosts: Object.fromEntries(pedidos), errores }, null, 2));
}
await b.close();
await srv.cerrar();
console.log(fallos ? `\n❌ ${fallos} FALLO(S)` : `\n✅ Claw bajo sus cabeceras de producción (fase ${PHASE})`);
process.exit(fallos ? 1 : 0);
