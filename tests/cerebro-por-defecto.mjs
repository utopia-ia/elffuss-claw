// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 UtopiaIA
//
// Qué cerebro carga el arranque. Sirve web/ en local y abre la página en Chrome
// con GPU, y mira cuál empieza a cargar (<html data-cargando>). No se baja
// ningún peso: las peticiones de pesos que ve la prueba se abortan.
//
//   1. Un 'elffuss.model' guardado por el arranque (el respaldo ligero cuando
//      Gemma no cabía) ya no decide: se pide LFM3, el del motor propio.
//   2. Lo que el usuario eligió en el selector ('elffuss.model.elegido') sí
//      decide: con el ONNX elegido se pide el ONNX.
//
// Sale con 2 si la premisa no se cumple (sin WebGPU real, sin el motor en
// web/js/engine o sin LFM3 en el registro): entonces la prueba no dice nada.
//
//   node tests/cerebro-por-defecto.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME_ARGS } from './chrome-args.mjs';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' };
const srv = http.createServer(async (req, res) => {
  try {
    let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    let f = join(WEB, p);
    if ((await stat(f)).isDirectory()) f = join(f, 'index.html');
    res.writeHead(200, { 'content-type': TIPOS[extname(f)] || 'application/octet-stream' });
    res.end(await readFile(f));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}/`;

const PESOS = [
  [/lfm3-1\.7b\.q8/, 'engine:lfm3-1.7b'],
  [/Qwen3\.5-0\.8B-ONNX|qwen3\.5-0\.8b/i, 'onnx:qwen3.5-0.8b'],
  [/gemma/i, 'litert:gemma'],
  [/Qwen3\.5-0\.8B-GGUF|qwen35-0\.8b/i, 'engine:qwen35-0.8b'],
];

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu', ...CHROME_ARGS] });
let fallos = 0;
async function caso(nombre, storage, esperado) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('__sembrado')) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); sessionStorage.setItem('__sembrado', '1'); } }, storage);
  const page = await ctx.newPage();
  if (process.env.VERBOSE) {
    page.on('console', m => console.log('  [consola]', m.text().slice(0, 200)));
    page.on('request', r => { if (!r.url().startsWith(base)) console.log('  [red]', r.method(), r.url().slice(0, 120)); });
  }
  let pedido = null;
  await ctx.route('**/*', route => {
    const u = route.request().url();
    const h = route.request().headers();
    // La sonda de disponibilidad pide un byte (Range: bytes=0-0): se deja pasar.
    if (h.range === 'bytes=0-0') return route.continue();
    for (const [re, id] of PESOS) if (re.test(u) && !u.startsWith(base)) { pedido ??= id; return route.abort(); }
    return route.continue();
  });
  await page.goto(base);
  const premisa = await page.evaluate(async () => {
    const a = navigator.gpu && await navigator.gpu.requestAdapter();
    const reg = await import('./js/engine/registro.js').catch(() => null);
    return { gpu: !!a && !a.info?.isFallbackAdapter, lfm3: !!(reg && reg.MODELS && reg.MODELS['lfm3-1.7b']) };
  });
  if (!premisa.gpu || !premisa.lfm3) { console.log(`PREMISA ROTA (${nombre}):`, premisa); process.exitCode = 2; await ctx.close(); return; }
  // Lo que el arranque empezó a cargar (kernel.js lo marca en <html data-cargando>);
  // la petición de pesos abortada es la otra señal, por si llega antes.
  for (let i = 0; i < 60 && !pedido; i++) {
    await page.waitForTimeout(500);
    pedido ??= await page.evaluate(() => document.documentElement.dataset.cargando || null);
  }
  const ok = pedido === esperado;
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'MAL '} ${nombre}: pidió ${pedido ?? 'nada'}, esperado ${esperado}`);
  await ctx.close();
}

await caso('respaldo guardado por el arranque no decide', { 'elffuss.model': 'onnx:qwen3.5-0.8b' }, 'engine:lfm3-1.7b');
await caso('sin nada guardado', {}, 'engine:lfm3-1.7b');
await caso('lo elegido por el usuario decide', { 'elffuss.model': 'onnx:qwen3.5-0.8b', 'elffuss.model.elegido': 'onnx:qwen3.5-0.8b' }, 'onnx:qwen3.5-0.8b');

await browser.close();
srv.close();
if (process.exitCode !== 2) process.exitCode = fallos ? 1 : 0;
console.log(fallos ? `${fallos} fallo(s)` : 'todo bien');
