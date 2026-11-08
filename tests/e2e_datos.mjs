// E2E de casos de uso con datos reales:
//   A) Visualización de datos desde EXCEL (.xlsx de verdad, y CSV):
//      «visualiza ventas.xlsx» → fs.read (SheetJS→CSV) → app de gráfico en el visualizador.
//   B) Automatización entre carpetas («pones un fichero y te lo deja procesado en otra»):
//      fs.watch vigila `entrada`; dejar ventas.xlsx ahí → aparece ventas.csv en `salida`;
//      dejar nota.txt → se copia tal cual. También fs.copy one-shot.
//
// Corre contra el modo básico (determinista): valida la PLATAFORMA (tools,
// bucle agéntico, visualizador), no la calidad del modelo. Las carpetas son
// OPFS sembradas por el test (los handles nativos requieren gesto de usuario).
//
// Requisitos: `python3 server/serve.py` corriendo y `npm i` en tests/.
//   node tests/e2e_datos.mjs   (o ELFFUSS_URL=… para otro entorno)
import { chromium } from 'playwright';

const BASE = process.env.ELFFUSS_URL || 'http://localhost:8642';
let fails = 0;
const check = (name, ok, extra = '') =>
  { console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? '  ' + extra : '')); if (!ok) fails++; };

const browser = await chromium.launch();
// En español: las comprobaciones leen los avisos del chat («Automatización …
// activa»), que van en el idioma de la página.
const ctx = await browser.newContext({ locale: 'es-ES' });
await ctx.addInitScript(() => {
  localStorage.setItem('elffuss.model', 'rules');       // determinista, sin GPU
  localStorage.setItem('elffuss.welcomed', '1');        // sin splash
  localStorage.setItem('elffuss.grants', JSON.stringify(['fs', 'apps', 'tasks', 'vault', 'web', 'memory']));
});
const page = await ctx.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE);
await page.waitForTimeout(800);

// ---- sembrar carpetas OPFS y autorizarlas en Elffuss ----
await page.evaluate(async () => {
  const XLSX = await import('/vendor/third-party/xlsx@0.20.3/xlsx.mjs');
  const db = await import('/js/db.js');
  const opfs = await navigator.storage.getDirectory();
  const mk = n => opfs.getDirectoryHandle(n, { create: true });
  const write = async (dir, name, data) => {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable(); await w.write(data); await w.close();
  };
  // datos/: un Excel DE VERDAD (SheetJS) + su gemelo CSV
  const datos = await mk('datos');
  const ws = XLSX.utils.aoa_to_sheet([['mes', 'ventas'], ['enero', 120], ['febrero', 150], ['marzo', 95], ['abril', 210]]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'ventas2026');
  await write(datos, 'ventas.xlsx', XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
  await write(datos, 'ventas.csv', 'mes,ventas\nenero,120\nfebrero,150\nmarzo,95\nabril,210\n');
  // origen/ y destino/ para copia one-shot; entrada/ y salida/ para el watcher
  const origen = await mk('origen');
  await write(origen, 'a.txt', 'contenido A');
  await write(origen, 'b.txt', 'contenido B');
  await write(origen, 'notas.md', 'no copiar');
  await mk('destino'); const entrada = await mk('entrada'); await mk('salida');
  for (const [n, h] of [['datos', datos], ['origen', origen], ['destino', await mk('destino')], ['entrada', entrada], ['salida', await mk('salida')]])
    await db.set('fs', n, h);
});

const send = async (text, wait = 3000) => {
  await page.fill('#prompt', text);
  await page.press('#prompt', 'Enter');
  await page.waitForTimeout(wait);
  if (await page.isVisible('#perm-dialog')) { await page.click('#perm-allow'); await page.waitForTimeout(1000); }
};
const toolMsgs = () => page.locator('.msg.tool').allTextContents();

// ============ A · visualización desde Excel ============
await send('visualiza ventas.xlsx', 5000);
const frameVisible = await page.isVisible('#appframe');
const canvasCount = await page.frameLocator('#appframe').locator('canvas').count().catch(() => 0);
const chartTitle = await page.frameLocator('#appframe').locator('h2').textContent().catch(() => '');
check('A1 · xlsx real → app de gráfico renderizada', frameVisible && canvasCount > 0, '| título: ' + chartTitle.trim());
check('A2 · el gráfico usa la columna correcta', /ventas/.test(chartTitle));
let tools = await toolMsgs();
check('A3 · cadena fs.read → app.create', tools.some(x => x.includes('fs.read')) && tools.some(x => x.includes('app.create')));

await send('grafica ventas.csv', 4000);
tools = await toolMsgs();
check('A4 · CSV → gráfico (segunda app)', tools.filter(x => x.includes('app.create')).length >= 2);
await page.screenshot({ path: new URL('./out_excel_viz.png', import.meta.url).pathname });

// ============ B · automatización entre carpetas ============
// B.0 copia one-shot
await send('copia los .txt de origen a destino', 3500);
const copiaOk = await page.evaluate(async () => {
  const opfs = await navigator.storage.getDirectory();
  const destino = await opfs.getDirectoryHandle('destino');
  const names = []; for await (const e of destino.values()) names.push(e.name);
  const a = names.includes('a.txt')
    ? await (await (await destino.getFileHandle('a.txt')).getFile()).text() : null;
  return { names: names.sort(), a };
});
check('B0 · fs.copy: .txt copiados, .md fuera, contenido intacto',
  copiaOk.names.includes('a.txt') && copiaOk.names.includes('b.txt') &&
  !copiaOk.names.includes('notas.md') && copiaOk.a === 'contenido A',
  JSON.stringify(copiaOk.names));

// B.1 crear la automatización
await send('vigila la carpeta entrada y deja lo procesado en salida', 3000);
const watchReply = (await page.locator('.msg.assistant').allTextContents()).join(' ');
check('B1 · automatización creada', /Automatización w[a-z0-9]+ activa/.test(watchReply));

// B.2 dejar un Excel en `entrada` DESPUÉS de crear la vigilancia
await page.evaluate(async () => {
  const XLSX = await import('/vendor/third-party/xlsx@0.20.3/xlsx.mjs');
  const opfs = await navigator.storage.getDirectory();
  const entrada = await opfs.getDirectoryHandle('entrada');
  const ws = XLSX.utils.aoa_to_sheet([['producto', 'unidades'], ['drones', 7], ['baterías', 32]]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'stock');
  const fh = await entrada.getFileHandle('stock.xlsx', { create: true });
  const w = await fh.createWritable(); await w.write(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })); await w.close();
  const fh2 = await entrada.getFileHandle('nota.txt', { create: true });
  const w2 = await fh2.createWritable(); await w2.write('hola elfa'); await w2.close();
});
console.log('   (archivos dejados en `entrada`; esperando al vigilante…)');
await page.waitForTimeout(12000); // el poller corre cada 8 s

const salida = await page.evaluate(async () => {
  const opfs = await navigator.storage.getDirectory();
  const dir = await opfs.getDirectoryHandle('salida');
  const files = {};
  for await (const e of dir.values())
    if (e.kind === 'file') files[e.name] = await (await e.getFile()).text();
  return files;
});
check('B2 · xlsx dejado en entrada → CSV procesado en salida',
  salida['stock.csv']?.includes('drones,7') && salida['stock.csv']?.includes('baterías,32'),
  '| salida: ' + Object.keys(salida).join(', '));
check('B3 · txt dejado en entrada → copiado a salida', salida['nota.txt'] === 'hola elfa');
const avisos = (await page.locator('.msg.assistant').allTextContents()).filter(x => x.includes('He cogido'));
check('B4 · Elffuss avisa por chat de cada procesado', avisos.length >= 2, '| avisos: ' + avisos.length);
await page.screenshot({ path: new URL('./out_watch.png', import.meta.url).pathname });

console.log(fails ? `\n❌ ${fails} FALLO(S)` : '\n✅ TODO VERDE');
await browser.close();
process.exit(fails ? 1 : 0);
