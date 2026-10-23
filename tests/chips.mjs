// Las sugerencias («Hazme un reloj», «Crea una app de notas»…) sirven para empezar
// una conversación: tras el primer mensaje del usuario tienen que desaparecer.
//
//   A) Página nueva: se ven las sugerencias.
//   B) Primer mensaje escrito en la caja: desaparecen, y el alto del pie
//      (--alto-pie) deja de contarlas.
//   C) Recargar con la conversación guardada: siguen ocultas (el histórico
//      restaurado entra por el mismo camino que un mensaje nuevo).
//   D) Pulsar una sugerencia: desaparecen y el foco pasa a la caja (en un
//      puntero fino; en el móvil no, para no abrir el teclado).
//   E) 🧹 Nueva conversación: recarga y las sugerencias vuelven.
//
// Corre en modo básico (determinista, sin GPU). Arranca su propio servidor.
//   node tests/chips.mjs          (necesita `npm i` en tests/, o Playwright a mano)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = createRequire(import.meta.url)('playwright')); }

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUERTO = 18600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PUERTO}`;
let fallos = 0;
const check = (nombre, ok, extra = '') => {
  console.log((ok ? '✅' : '❌') + ' ' + nombre + (extra ? '  ' + extra : ''));
  if (!ok) fallos++;
};

const servidor = spawn('python3', ['server/serve.py', String(PUERTO)], { cwd: RAIZ, stdio: 'ignore' });
try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/')).ok) break; } catch { /* aún no */ }
    await new Promise(r => setTimeout(r, 100));
  }

  const browser = await chromium.launch(process.env.CHROMIUM_CHANNEL ? { channel: process.env.CHROMIUM_CHANNEL } : {});
  const nuevoContexto = (opts = {}) => browser.newContext({ locale: 'es-ES', ...opts }).then(async ctx => {
    await ctx.addInitScript(() => {
      if (window.top !== window.self) return;           // no en los iframes aislados de las apps
      localStorage.setItem('elffuss.model', 'rules');   // determinista, sin GPU
      localStorage.setItem('elffuss.welcomed', '1');    // sin splash
      localStorage.setItem('elffuss.grants', JSON.stringify(['fs', 'apps', 'tasks', 'vault', 'web', 'memory']));   // sin diálogos de permisos
    });
    return ctx;
  });

  const visibles = page => page.evaluate(() => {
    const c = document.getElementById('chips');
    return { hidden: c.hidden, alto: c.offsetHeight, botones: c.querySelectorAll('.chip').length };
  });
  const respuesta = page => page.waitForFunction(
    () => document.querySelector('#log .msg.assistant:not(.md:empty)') && document.querySelectorAll('#log .msg.assistant').length > 0,
    null, { timeout: 20000 }).catch(() => null);
  const errores = [];

  // ---- A + B + C: escribir en la caja, y recargar ----
  const ctx = await nuevoContexto();
  const page = await ctx.newPage();
  page.on('pageerror', e => errores.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(BASE);
  await page.waitForSelector('#prompt');
  await page.waitForTimeout(600);

  let v = await visibles(page);
  check('A · página nueva: las sugerencias se ven', !v.hidden && v.alto > 0 && v.botones >= 4, JSON.stringify(v));
  const altoPieAntes = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--alto-pie'));

  await page.fill('#prompt', 'hazme un reloj');
  await page.press('#prompt', 'Enter');
  await page.waitForSelector('#log .msg.user', { timeout: 10000 });
  v = await visibles(page);
  check('B · tras el primer mensaje desaparecen', v.hidden && v.alto === 0, JSON.stringify(v));
  await page.waitForTimeout(400);
  const altoPieDespues = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--alto-pie'));
  check('B · el alto del pie ya no cuenta las sugerencias', parseInt(altoPieDespues) < parseInt(altoPieAntes),
    `${altoPieAntes.trim()} → ${altoPieDespues.trim()}`);

  await respuesta(page);
  await page.waitForTimeout(1500);                        // que el histórico se commitee en IndexedDB
  await page.reload();
  await page.waitForSelector('#prompt');
  await page.waitForSelector('#log .msg.user', { timeout: 10000 }).catch(() => null);
  v = await visibles(page);
  const restaurado = await page.evaluate(() => document.querySelectorAll('#log .msg.user').length);
  check('C · conversación restaurada al recargar: siguen ocultas', restaurado > 0 && v.hidden && v.alto === 0,
    `mensajes restaurados=${restaurado} ${JSON.stringify(v)}`);

  // ---- E: 🧹 recarga y vuelven ----
  await page.click('#btn-clear');
  await page.waitForFunction(() => document.querySelectorAll('#log .msg.user').length === 0 && !document.getElementById('chips').hidden,
    null, { timeout: 15000 }).catch(() => null);
  v = await visibles(page);
  check('E · 🧹 nueva conversación: las sugerencias vuelven', !v.hidden && v.alto > 0, JSON.stringify(v));
  await ctx.close();

  // ---- D: pulsar una sugerencia (escritorio) ----
  const ctx2 = await nuevoContexto();
  const p2 = await ctx2.newPage();
  p2.on('pageerror', e => errores.push(e.message));
  await p2.setViewportSize({ width: 1440, height: 900 });
  await p2.goto(BASE);
  await p2.waitForSelector('#prompt');
  await p2.waitForTimeout(600);
  await p2.locator('#chips .chip').nth(1).click();
  await p2.waitForSelector('#log .msg.user', { timeout: 10000 });
  v = await visibles(p2);
  const foco = await p2.evaluate(() => document.activeElement?.id);
  check('D · pulsar una sugerencia: desaparecen', v.hidden && v.alto === 0, JSON.stringify(v));
  check('D · y el foco pasa a la caja', foco === 'prompt', `foco en «${foco}»`);
  await ctx2.close();

  // ---- móvil: el foco NO salta a la caja (abriría el teclado) ----
  const ctx3 = await nuevoContexto({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p3 = await ctx3.newPage();
  p3.on('pageerror', e => errores.push(e.message));
  await p3.goto(BASE);
  await p3.waitForSelector('#prompt');
  await p3.waitForTimeout(600);
  await p3.locator('#chips .chip').nth(1).tap();
  await p3.waitForSelector('#log .msg.user', { timeout: 10000 });
  v = await visibles(p3);
  const foco3 = await p3.evaluate(() => document.activeElement?.id);
  check('móvil · desaparecen', v.hidden && v.alto === 0, JSON.stringify(v));
  check('móvil · el foco no salta a la caja', foco3 !== 'prompt', `foco en «${foco3}»`);
  await ctx3.close();

  check('sin errores de JavaScript', errores.length === 0, errores.join(' | '));
  await browser.close();
} finally {
  servidor.kill();
}
console.log(fallos ? `\n${fallos} comprobaciones fallan` : '\ntodo bien');
process.exit(fallos ? 1 : 0);
