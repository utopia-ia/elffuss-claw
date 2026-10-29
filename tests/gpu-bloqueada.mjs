// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 UtopiaIA
//
// Con WebGPU presente pero sin adaptador (el navegador tiene la GPU bloqueada),
// Claw lo dice en vez de ofrecer en silencio solo los modelos sin GPU. Y con
// adaptador no lo dice. Sirve web/ en local; no carga ningún modelo de GPU.
//
//   node tests/gpu-bloqueada.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const srv = http.createServer(async (req, res) => {
  try {
    let f = join(WEB, normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, ''));
    if ((await stat(f)).isDirectory()) f = join(f, 'index.html');
    res.writeHead(200, { 'content-type': TIPOS[extname(f)] || 'application/octet-stream' });
    res.end(await readFile(f));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}/`;
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu'] });
let fallos = 0;
async function caso(nombre, bloquear, esperaAviso) {
  const ctx = await browser.newContext();
  // Básico guardado: el arranque no carga ningún modelo.
  await ctx.addInitScript(b => {
    localStorage.setItem('elffuss.model.elegido', 'rules');
    if (b) { if (!navigator.gpu) Object.defineProperty(navigator, 'gpu', { value: {} }); navigator.gpu.requestAdapter = async () => null; }
  }, bloquear);
  const page = await ctx.newPage();
  await page.goto(base);
  if (!bloquear && !(await page.evaluate(async () => !!(navigator.gpu && await navigator.gpu.requestAdapter())))) {
    console.log(`PREMISA ROTA (${nombre}): este Chrome no da adaptador WebGPU`); process.exitCode = 2; await ctx.close(); return;
  }
  let vio = false;
  for (let i = 0; i < 12 && !vio; i++) {
    await page.waitForTimeout(500);
    vio = await page.evaluate(() => [...document.querySelectorAll('.toast')].some(t => /GPU bloqueada|GPU blocked/.test(t.textContent)));
  }
  const ok = vio === esperaAviso;
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'MAL '} ${nombre}: aviso ${vio ? 'sí' : 'no'}`);
  await ctx.close();
}
await caso('GPU bloqueada: avisa', true, true);
await caso('sin bloquear: no avisa', false, false);
await browser.close(); srv.close();
if (process.exitCode !== 2) process.exitCode = fallos ? 1 : 0;
