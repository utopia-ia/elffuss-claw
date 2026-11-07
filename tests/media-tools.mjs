// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
// Las herramientas de imagen, audio y vídeo y los adjuntos de Claw, en el Chrome del sistema, con un modelo de guion
// (un proveedor que escribe las llamadas que haría el modelo) y el SDK de medios sustituido por un doble con la misma
// API (fixtures/stub-media-sdk.js, fixtures/stub-asr.js): se prueba Claw alrededor de las tareas, no los modelos.
//
//   PLAYWRIGHT_MODULE=<playwright/index.mjs> node tests/media-tools.mjs
//
// Sirve web/ en un puerto libre de localhost (contexto seguro: IndexedDB, micrófono), con los index.js de las tareas
// de vendor/elffuss-ai/sdk/ y vendor/elffuss-asr/ cambiados por los dobles. Comprueba:
//   - image.generate: la descarga se pregunta una vez (diálogo de permisos), tarjeta con la imagen, su id y Descargar,
//     guardada en IndexedDB; el cerebro se suelta antes y se vuelve a cargar después; la tarea se libera (dispose);
//   - la segunda imagen no pregunta; video.animate con el id de la primera recibe esa imagen;
//   - estimate() que no cabe: la tarjeta da el motivo y el cerebro no se suelta;
//   - Parar en la tarjeta aborta la tarea por su señal y el cerebro vuelve;
//   - al recargar, las tarjetas se repintan con su medio leído de este navegador;
//   - el «+»: un .txt y un .pdf se leen aquí y su texto llega al modelo (no a la burbuja); una foto tiene id y
//     video.animate la usa; una nota de voz (micrófono de mentira) llega al modelo como mensaje del usuario.
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..', 'web');
const STUB = join(HERE, 'fixtures', 'stub-media-sdk.js'), STUB_ASR = join(HERE, 'fixtures', 'stub-asr.js');
const MEDIA_INDEX = /^\/vendor\/elffuss-ai\/sdk\/(text-to-image|audio|video|video-gen)\/index\.js$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = MEDIA_INDEX.test(path) ? STUB : path === '/vendor/elffuss-asr/index.js' ? STUB_ASR : normalize(join(WEB, path));
  if (!file.startsWith(WEB) && file !== STUB && file !== STUB_ASR) { res.writeHead(403).end(); return; }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://localhost:${server.address().port}`;

let fails = 0, passes = 0;
const ok = (n, c, e = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && e ? '  -- ' + e : '')); if (c) passes++; else fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, { tries = 100, every = 100 } = {}) {
  for (let i = 0; i < tries; i++) { try { if (await cond()) return true; } catch { /* aún no */ } await wait(every); }
  return false;
}
function pdf(text) {
  const objs = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>', null, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  objs[3] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const xref = [];
  objs.forEach((o, i) => { xref.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const at = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + xref.map((x) => String(x).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${at}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');

// El modelo de guion: decide por el último mensaje del usuario (sin los adjuntos de delante).
const scripted = () => {
  const calls = (window.__llm = []), events = (window.__llmEvents = []);
  const call = (tool, args) => '```tool\n' + JSON.stringify({ tool, args }) + '\n```';
  window.__scripted = {
    label: 'guion', load: async () => { events.push('load'); }, unload: async () => { events.push('unload'); },
    chat: async (history) => {
      calls.push(history.map((m) => ({ role: m.role, content: m.content })));
      const real = history.filter((m) => !(m.role === 'user' && /^CONTEXTO AHORA/.test(m.content)));
      const last = real[real.length - 1];
      if (last.role === 'user' && last.content.startsWith('[resultado')) return 'Hecho.';
      const all = history.map((m) => m.content).join('\n');
      const u = last.content.replace(/^\[(?:document|documento) [\s\S]*?\[(?:end of document|fin del documento)\]\s*/g, '').replace(/^(\[(?:attached|adjunto|nota de voz|voice note)[^\]]*\]\s*)+/, '');
      if (/^\[img\]/.test(u)) return call('image.generate', { prompt: 'a red fox in the snow', aspect: '16:9' });
      if (/^\[speak\]/.test(u)) return call('audio.speak', { text: u.replace(/^\[speak\]\s*/, '') });
      if (/^\[animate\]/.test(u)) { const ids = [...all.matchAll(/\bimg-[a-z0-9]{4}\b/g)].map((x) => x[0]); return call('video.animate', { image: ids.pop() || '', preset: 'orbit' }); }
      if (/^\[doc\]/.test(u)) { const m = [...all.matchAll(/\[(?:documento|document) doc-[^\n]*\n([\s\S]*?)\n\[(?:fin del documento|end of document)\]/g)].pop(); return 'DOC: ' + (m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 60) : '(nada)'); }
      if (/hola desde la nota de voz/.test(u)) return 'VOZ: ' + u;
      return 'Vale.';
    },
  };
};

const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const errores = [];
try {
  const ctx = await b.newContext({ locale: 'es-ES', viewport: { width: 1400, height: 900 }, permissions: ['microphone'] });
  await ctx.addInitScript(() => {
    try { if (!sessionStorage.getItem('t.init')) { localStorage.setItem('elffuss.model', 'rules'); localStorage.setItem('elffuss.welcomed', '1'); localStorage.removeItem('elffuss.grants'); sessionStorage.setItem('t.init', '1'); } } catch { /* — */ }
  });
  await ctx.addInitScript(scripted);
  // Fuera de esta web no se sale (el almacén de modelos, fuentes, telemetría).
  await ctx.route((u) => !u.href.startsWith(BASE), (r) => r.abort());
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { if (!/allow-same-origin/.test(e.message)) errores.push(e.message); });
  const arrancar = async () => {
    await p.waitForFunction(() => !!window.elffuss?.agent && document.body.classList.contains('modo-basico'), null, { timeout: 20000 });
    // El arranque termina de elegir cerebro (Básico) un poco después: hasta entonces, cambiarlo no dura.
    await wait(2500);
    await p.evaluate(() => window.elffuss.agent.setProvider(window.__scripted));
  };
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await arrancar();
  const reposo = () => p.evaluate(() => !document.getElementById('send').classList.contains('is-stop') && !document.querySelector('#log .msg.thinking'));
  const mediaLog = () => p.evaluate(() => (window.__media || []).slice());
  const events = () => p.evaluate(() => window.__llmEvents.slice());
  let dialogos = 0;
  const responder = setInterval(async () => {
    try { if (await p.evaluate(() => document.getElementById('perm-dialog').open)) { dialogos++; await p.click('#perm-allow'); } } catch { /* cerrada */ }
  }, 60);
  async function decir(texto) {
    // El arranque elige su cerebro (Básico aquí) cuando quiere: el de guion se pone justo antes de cada mensaje.
    await p.evaluate(() => window.elffuss.agent.setProvider(window.__scripted));
    await p.fill('#prompt', texto);
    await p.press('#prompt', 'Enter');
    await wait(200);
    if (!(await until(reposo, { tries: 200 }))) throw new Error('el turno no acabó: ' + texto);
  }
  const ultimaTarjeta = () => p.locator('#log .media-card').last();

  // 1. Una imagen.
  await decir('[img] hazme un zorro');
  ok('la primera imagen pregunta la descarga', dialogos === 1, String(dialogos));
  const t1 = ultimaTarjeta();
  ok('la llamada deja una tarjeta con la imagen', await until(() => t1.locator('img.media-el').evaluate((i) => i.complete && i.naturalWidth > 0)));
  const id1 = await t1.getAttribute('data-media');
  ok('la tarjeta dice su id y tiene Descargar', /^img-[a-z0-9]{4}$/.test(id1 || '') && (await t1.innerText()).includes(id1) && /^blob:/.test(await t1.locator('a.md-download').getAttribute('href') || ''), id1);
  ok('el cerebro se suelta antes y vuelve después', await until(async () => (await events()).join(',') === 'unload,load'), (await events()).join(','));
  let log = await mediaLog();
  ok('estimate, tarea y dispose', /estimate.*construct.*run.*dispose/.test(log.map((x) => x.ev).join(',')));
  ok('el prompt va en inglés tal cual', log.find((x) => x.ev === 'run')?.args?.prompt === 'a red fox in the snow');
  const sys = await p.evaluate(() => window.elffuss.agent.history.length);
  ok('el turno acaba en la tarjeta (un paso del modelo)', (await p.evaluate(() => window.__llm.length)) === 1 && sys >= 3);

  // 2. Otra: ya no pregunta. 3. Animar la primera por su id.
  await decir('[img] otro');
  ok('la segunda imagen no pregunta', dialogos === 1, String(dialogos));
  await decir('[animate] anímala');
  log = await mediaLog();
  const anim = [...log].reverse().find((x) => x.ev === 'run' && x.task === 'image-to-video');
  ok('video.animate recibe la imagen que nombra', anim?.input?.type === 'image/png' && anim.input.size > 0, JSON.stringify(anim));
  ok('y deja una tarjeta de vídeo', await until(() => ultimaTarjeta().locator('video.media-el').count().then((n) => n === 1)));

  // 4. No cabe.
  const antes = (await events()).length;
  await p.evaluate(() => { window.__mediaStub = { fits: false, reason: 'not-enough-memory' }; });
  await decir('[img] un gato');
  ok('si no cabe, la tarjeta da el motivo', /No en este dispositivo/.test(await ultimaTarjeta().innerText()) && /memoria suficiente/.test(await ultimaTarjeta().innerText()), await ultimaTarjeta().innerText());
  ok('y el cerebro no se suelta', (await events()).length === antes);
  await p.evaluate(() => { window.__mediaStub = {}; });

  // 5. Parar.
  await p.evaluate(() => { window.__mediaStub = { slow: true }; });
  await p.evaluate(() => window.elffuss.agent.setProvider(window.__scripted));
  await p.fill('#prompt', '[speak] Hola, esto es una prueba');
  await p.press('#prompt', 'Enter');
  ok('la tarjeta enseña el progreso por etapas', await until(() => ultimaTarjeta().locator('.md-progress').innerText().then((s) => /Paso \d de 4/.test(s)), { tries: 80 }));
  const antesParar = (await events()).length;
  await ultimaTarjeta().locator('.md-stop').click();
  await until(reposo, { tries: 100 });
  ok('Parar aborta la tarea por su señal y la libera', await until(async () => (await mediaLog()).filter((x) => x.task === 'text-to-speech').map((x) => x.ev).join(',').endsWith('abort,dispose')));
  ok('la tarjeta dice Parado', /Parado/.test(await ultimaTarjeta().innerText()), await ultimaTarjeta().innerText());
  ok('el cerebro vuelve tras parar', await until(async () => (await events()).slice(antesParar - 1).join(',') === 'unload,load'), (await events()).join(','));
  ok('audio.speak lleva el idioma del usuario', (await mediaLog()).find((x) => x.ev === 'run' && x.task === 'text-to-speech')?.input?.lang === 'es');
  await p.evaluate(() => { window.__mediaStub = {}; });

  // 6. Recargar.
  await p.reload({ waitUntil: 'domcontentloaded' });
  await arrancar();
  ok('al recargar, la tarjeta vuelve con su imagen', await until(() => p.locator(`#log .media-card[data-media="${id1}"] img.media-el`).evaluate((i) => i.complete && i.naturalWidth > 0)));

  // 7. Adjuntos.
  await p.click('#att-btn');
  ok('el + abre el menú de adjuntar', await p.locator('#att-menu').isVisible());
  await p.keyboard.press('Escape');
  await p.setInputFiles('#att-doc', [{ name: 'notas.txt', mimeType: 'text/plain', buffer: Buffer.from('Comprar pan, leche y huevos.') }]);
  await until(() => p.locator('.att-chip .att-chip-state').innerText().then((s) => /^doc-/.test(s)));
  await decir('[doc] qué dice');
  ok('el texto de un .txt llega al modelo', /DOC: Comprar pan, leche y huevos\./.test((await p.locator('#log .msg.assistant').last().innerText())));
  const burbuja = await p.locator('#log .msg.user').last().innerText();
  ok('la burbuja enseña la tarjeta, no el texto', /notas\.txt/.test(burbuja) && !/huevos/.test(burbuja), burbuja);
  await p.setInputFiles('#att-doc', [{ name: 'factura.pdf', mimeType: 'application/pdf', buffer: pdf('Factura numero 42') }]);
  ok('un PDF se lee aquí', await until(() => p.locator('.att-chip .att-chip-state').innerText().then((s) => /^doc-/.test(s)), { tries: 150 }));
  await decir('[doc] resume');
  ok('el texto de un .pdf llega al modelo', /DOC: Factura numero 42/.test(await p.locator('#log .msg.assistant').last().innerText()));
  await p.setInputFiles('#att-media', [{ name: 'foto.png', mimeType: 'image/png', buffer: PNG }]);
  await until(() => p.locator('.att-chip .att-chip-state').innerText().then((s) => /^img-/.test(s)));
  const foto = await p.locator('.att-chip .att-chip-state').innerText();
  await decir('[animate] mi foto');
  const ult = (await mediaLog()).filter((x) => x.ev === 'run' && x.task === 'image-to-video').pop();
  const hist = await p.evaluate(() => window.elffuss.agent.history.map((m) => m.content).join('\n'));
  ok('video.animate usa la foto adjunta por su id', ult?.input?.size === PNG.length && hist.includes(`"image":"${foto}"`), foto);

  // 8. Nota de voz.
  ok('hay micrófono en la caja', await p.locator('#mic-btn').isVisible());
  await p.evaluate(() => window.elffuss.agent.setProvider(window.__scripted));
  await p.click('#mic-btn');
  ok('un toque empieza a grabar', await until(() => p.locator('.rec-chip.is-rec').count().then((n) => n === 1)));
  await wait(1500);
  const dAntes = dialogos;
  await p.click('#mic-btn');
  await until(async () => /VOZ:/.test(await p.locator('#log .msg.assistant').last().innerText().catch(() => '')), { tries: 150 });
  const asr = (await mediaLog()).filter((x) => x.ev === 'asr').pop();
  ok('la primera nota pregunta el modelo de voz', dialogos === dAntes + 1, `${dAntes} → ${dialogos}`);
  ok('Whisper recibe 16 kHz y el idioma (es)', asr?.language === 'es' && asr.rate16k && asr.samples > 12000, JSON.stringify(asr));
  ok('la nota llega al modelo como mensaje del usuario', /VOZ: hola desde la nota de voz/.test(await p.locator('#log .msg.assistant').last().innerText()));
  ok('y se ve como tarjeta de audio', await p.evaluate(() => !![...document.querySelectorAll('#log .msg.user')].pop()?.querySelector('.att-card audio')));
  clearInterval(responder);
  ok('sin pageerror', errores.length === 0, errores.join(' | '));
} catch (e) {
  ok('la prueba terminó', false, e.stack || String(e));
} finally {
  await b.close();
  server.close();
}
console.log(`${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
