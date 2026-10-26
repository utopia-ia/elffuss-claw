// Las herramientas de elffuss-ai solo leen del almacén: bajan o consultan los
// ficheros de su registro, fijados a su commit y con su tamaño exacto, y nada más.
// ─────────────────────────────────────────────────────────────────────────────
// tools, cutout, ocr, detect y depth .elffuss.com abren ficheros del usuario
// (imágenes, PDF). Si una de esas páginas fallara, no debe poder vaciar el almacén
// (se llevaría la Gemma de Claw), ni guardar copias, ni llenarlo con lo que quiera,
// ni listar lo que guardan las demás webs, ni borrar lo que guardó otra web.
//
// Esto último pasaba con la versión anterior del permiso: el almacén cura (borra)
// la copia completa que no mide lo que dice quien pregunta, y una herramienta podía
// decir cualquier tamaño. Ahora solo puede nombrar un fichero de su lista con el
// tamaño de la lista, y lo que pide una herramienta nunca cura nada: una copia
// completa que no cuadra se contesta con «integridad» y se queda donde está.
//
// Como tests/broker-integridad.mjs: sin navegador ni red, con el <script> real de
// la página en un contexto de Node, un OPFS falso y un fetch falso. Por defecto
// prueba las dos copias de la página (server/broker/index.html, la que se sirve,
// y broker/index.html); BROKER_FILE=<ruta> prueba solo una.
//
//   node tests/broker-herramientas.mjs
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGINAS = process.env.BROKER_FILE ? [process.env.BROKER_FILE] : ['server/broker/index.html', 'broker/index.html'];
let fails = 0, total = 0;
const ok = (n, c, e = '') => { total++; console.log((c ? '✅' : '❌') + ' ' + n + (e ? '  — ' + e : '')); if (!c) fails++; };
const sha = b => createHash('sha256').update(b).digest('hex');

class FH {
  constructor(dir, nombre) { this.dir = dir; this.name = nombre; this.kind = 'file'; }
  async getFile() { return new Blob([this.dir.datos.get(this.name)]); }
  async createWritable() {
    const dir = this.dir, nombre = this.name; const trozos = [];
    return { write: async v => { trozos.push(Buffer.from(v)); }, close: async () => { dir.datos.set(nombre, Buffer.concat(trozos)); }, abort: async () => {} };
  }
}
class Dir {
  constructor() { this.datos = new Map(); this.sub = new Map(); }
  async getFileHandle(n, o = {}) {
    if (!this.datos.has(n)) { if (!o.create) throw Object.assign(new Error('NotFoundError'), { name: 'NotFoundError' }); this.datos.set(n, Buffer.alloc(0)); }
    return new FH(this, n);
  }
  async getDirectoryHandle(n) { if (!this.sub.has(n)) this.sub.set(n, new Dir()); return this.sub.get(n); }
  async removeEntry(n, o = {}) {
    if (o.recursive && this.sub.has(n)) { this.sub.delete(n); return; }
    if (!this.datos.delete(n)) throw new Error('NotFoundError');
  }
  async *keys() { for (const n of [...this.datos.keys()]) yield n; }
  async *entries() { for (const n of [...this.datos.keys()]) yield [n, new FH(this, n)]; }
}

// Un servidor falso que contesta a cualquier URL con los bytes que se le dan para
// ella (o con `porDefecto`), con Range.
function servidor(porUrl, porDefecto) {
  const peticiones = [];
  const f = async (url, init = {}) => {
    peticiones.push(String(url));
    const datos = porUrl.get(String(url)) || porDefecto;
    const rango = init.headers?.Range || '';
    const m = /bytes=(\d+)-(\d*)/.exec(rango);
    const tot = datos.length, ini = m ? +m[1] : 0, fin = m && m[2] ? +m[2] : tot - 1;
    const cab = { etag: '"v1"' };
    if (m) { cab['content-range'] = `bytes ${ini}-${fin}/${tot}`; cab['content-length'] = String(fin - ini + 1); }
    else cab['content-length'] = String(tot);
    return new Response(datos.subarray(ini, fin + 1), { status: m ? 206 : 200, headers: cab });
  };
  f.peticiones = peticiones; return f;
}

const ultimo = m => m[m.length - 1] || {};
const bytesFile = async f => Buffer.from(await f.arrayBuffer());
const datosDe = n => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + n) & 255));
const OCR = 'https://ocr.elffuss.com', DEPTH = 'https://depth.elffuss.com', CLAW = 'https://claw.elffuss.com';

async function probar(pagina) {
  console.log(`\n── ${pagina}`);
  const html = readFileSync(join(RAIZ, pagina), 'utf8');
  let codigo = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  // Partes pequeñas, para que un fichero de unos cientos de bytes tenga varias.
  if (codigo.includes('const TRAMO = 16 * 1024 * 1024;')) codigo = codigo.replace('const TRAMO = 16 * 1024 * 1024;', 'const TRAMO = 300;');
  const conClear = codigo.includes("'elffuss-model-clear'");
  const conCura = codigo.includes('async function invalidar(');
  const lista = new vm.Script(codigo + '\n;this.__lista = FICHEROS_HERRAMIENTAS;');

  function nuevoBroker(fetch, raiz = new Dir(), fuente = lista) {
    const oyentes = [];
    const ctx = vm.createContext({
      navigator: { storage: { getDirectory: async () => raiz, persist: async () => true, persisted: async () => true, estimate: async () => ({ usage: 0, quota: 1e9 }) } },
      location: { search: '', origin: 'https://models.elffuss.com' }, URLSearchParams, URL, fetch, Blob, Response, ReadableStream,
      TextEncoder, TextDecoder, AbortController, DOMException, console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON,
      Uint8Array, Promise, Error, Map, Set, Number, String, crypto: globalThis.crypto, parent: { postMessage() {} },
      addEventListener: (t, h) => { if (t === 'message') oyentes.push(h); },
    });
    (fuente instanceof vm.Script ? fuente : new vm.Script(fuente)).runInContext(ctx);
    const store = () => raiz.sub.get('elffuss-models');
    const claves = () => [...(store()?.datos.keys() || [])].sort();
    // Devuelve los mensajes de la respuesta, o [] si el broker no contesta nada.
    const hablar = (origin, data) => new Promise(res => {
      const msgs = [];
      const fin = setTimeout(() => res(msgs), 300);
      const source = { postMessage: m => { msgs.push(m); if (['file', 'error', 'has', 'cancelled', 'put', 'cleared', 'diag'].includes(m.kind)) { clearTimeout(fin); res(msgs); } } };
      for (const h of oyentes) h({ origin, data, source });
    });
    return { store, claves, hablar, lista: ctx.__lista, raiz };
  }

  const L = nuevoBroker(servidor(new Map(), Buffer.alloc(1))).lista;
  ok('la lista tiene los ficheros del registro, cada uno con su tamaño', L instanceof Map && L.size >= 15 && [...L].every(([u, n]) => /^https:\/\/huggingface\.co\/[^?#]+\/resolve\/[0-9a-f]{40}\/[^?#]+$/.test(u) && Number.isInteger(n) && n > 0), `${L?.size} ficheros`);
  const urls = [...L.keys()];
  const de = parte => urls.find(u => u.includes(parte));
  // Dos ficheros pequeños de la lista, de dos herramientas distintas.
  const YML = de('PP-OCRv6_small_det_onnx') && urls.find(u => u.includes('PP-OCRv6_small_det_onnx') && u.endsWith('/inference.yml'));
  const CFG = urls.find(u => u.includes('depth-anything-v2-small') && u.endsWith('/config.json'));
  const nY = L.get(YML), nC = L.get(CFG);
  const DY = datosDe(nY), DC = datosDe(nC);
  const datos = new Map([[YML, DY], [CFG, DC]]);
  const otroSha = YML.replace(/resolve\/[0-9a-f]{40}/, 'resolve/' + '0'.repeat(40));
  const fueraDeLaLista = YML.replace(/inference\.yml$/, 'README.md');
  const main = YML.replace(/resolve\/[0-9a-f]{40}/, 'resolve/main');

  // 1) una herramienta baja y consulta un fichero de su lista, con su tamaño
  {
    const fx = servidor(datos); const b = nuevoBroker(fx);
    const r = ultimo(await b.hablar(OCR, { type: 'elffuss-model-get', id: 1, url: YML, bytes: nY }));
    ok('herramienta: get de un fichero de la lista con su tamaño → el fichero', r.kind === 'file' && sha(await bytesFile(r.file)) === sha(DY), r.message);
    const h = ultimo(await b.hablar(OCR, { type: 'elffuss-model-has', id: 2, url: YML, bytes: nY }));
    ok('herramienta: has del mismo fichero → guardado', h.kind === 'has' && h.cached === true && h.size === nY);
    const h2 = ultimo(await b.hablar(DEPTH, { type: 'elffuss-model-has', id: 3, url: YML }));
    ok('otra herramienta: has sin tamaño → guardado (el tamaño es el de la lista)', h2.kind === 'has' && h2.cached === true);
  }
  // 1b) cada fichero de la lista recibe respuesta
  {
    const fx = servidor(datos); const b = nuevoBroker(fx);
    let todos = true;
    for (const url of urls) { const h = ultimo(await b.hablar(OCR, { type: 'elffuss-model-has', id: 50, url, bytes: L.get(url) })); todos &&= h.kind === 'has' && h.cached === false; }
    ok(`herramienta: has de cada uno de los ${urls.length} ficheros de la lista → contesta, sin red`, todos && fx.peticiones.length === 0);
  }
  // 2) lo que no puede pedir, sin tocar la red
  for (const [nombre, data] of [
    ['get de resolve/main', { type: 'elffuss-model-get', id: 3, url: main, bytes: nY }],
    ['get de otro commit del mismo repo', { type: 'elffuss-model-get', id: 4, url: otroSha, bytes: nY }],
    ['get de un fichero del mismo commit que no está en la lista', { type: 'elffuss-model-get', id: 5, url: fueraDeLaLista, bytes: 100 }],
    ['get sin tamaño', { type: 'elffuss-model-get', id: 6, url: YML }],
    ['get con un tamaño falso', { type: 'elffuss-model-get', id: 7, url: YML, bytes: nY + 1 }],
    ['get con tamaño no entero', { type: 'elffuss-model-get', id: 8, url: YML, bytes: String(nY) + '.5' }],
    ['has con un tamaño falso', { type: 'elffuss-model-has', id: 9, url: YML, bytes: 1 }],
    ['get de m1', { type: 'elffuss-model-get', id: 10, url: 'https://m1.elffuss.com/bonsai-27b.p0', bytes: 3602907136 }],
    ['get con query', { type: 'elffuss-model-get', id: 11, url: YML + '?x=1', bytes: nY }],
    ['get de otro host que imita el Hub', { type: 'elffuss-model-get', id: 12, url: YML.replace('huggingface.co', 'huggingface.co.evil.net'), bytes: nY }],
    ['get con «..» en la ruta', { type: 'elffuss-model-get', id: 13, url: YML.replace('inference.yml', '../../../../otro/repo-grande/resolve/main/pesos.bin'), bytes: nY }],
    ['get con «%2e%2e» en la ruta', { type: 'elffuss-model-get', id: 14, url: YML.replace('inference.yml', '%2e%2e/%2e%2e/otro/repo-grande/resolve/main/pesos.bin'), bytes: nY }],
    ['cancel de un fichero que no está en la lista', { type: 'elffuss-model-cancel', id: 15, url: fueraDeLaLista }],
    ['put', { type: 'elffuss-model-put', id: 16, url: YML, file: new Blob([DY]) }],
    ['diag', { type: 'elffuss-broker-diag', id: 17 }],
    ['diag con prueba de techo', { type: 'elffuss-broker-diag', id: 18, probar: 64 }],
    ['clear', { type: 'elffuss-model-clear', id: 19 }],
  ]) {
    const fx = servidor(datos); const b = nuevoBroker(fx);
    const r = ultimo(await b.hablar(OCR, data));
    ok(`herramienta: ${nombre} → «permiso» y sin red`, r.kind === 'error' && r.tipo === 'permiso' && fx.peticiones.length === 0,
      `${r.kind}/${r.tipo} · peticiones=${fx.peticiones.length}`);
  }
  // 3) con un tamaño falso no se borra lo que guardó otra herramienta (el fallo de la versión anterior)
  {
    const fx = servidor(datos); const raiz = new Dir(); const b = nuevoBroker(fx, raiz);
    const g = ultimo(await b.hablar(DEPTH, { type: 'elffuss-model-get', id: 20, url: CFG, bytes: nC }));
    ok('(depth guarda su config.json)', g.kind === 'file', g.message);
    const antes = b.claves(); const pAntes = fx.peticiones.length;
    const h = ultimo(await b.hablar(OCR, { type: 'elffuss-model-has', id: 21, url: CFG, bytes: 1 }));
    const g2 = ultimo(await b.hablar(OCR, { type: 'elffuss-model-get', id: 22, url: CFG, bytes: 5 }));
    ok('otra herramienta: has y get con un tamaño falso sobre ese fichero → «permiso», nada borrado, sin red',
      h.tipo === 'permiso' && g2.tipo === 'permiso' && JSON.stringify(b.claves()) === JSON.stringify(antes) && antes.length > 0 && fx.peticiones.length === pAntes, `claves ${antes.length}→${b.claves().length}`);
    const h3 = ultimo(await b.hablar(OCR, { type: 'elffuss-model-has', id: 23, url: CFG, bytes: nC }));
    ok('…y con su tamaño de verdad sigue guardado', h3.kind === 'has' && h3.cached === true);
  }
  // 4) una copia completa que no cuadra: «integridad» para la herramienta, y la copia se queda
  if (conCura) {
    const fx = servidor(datos); const raiz = new Dir(); const b = nuevoBroker(fx, raiz);
    // Claw guardó bajo esa URL algo que no mide lo que debe (una copia envenenada).
    const malo = datosDe(nY - 7);
    const fxClaw = servidor(new Map([[YML, malo]]));
    const bClaw = nuevoBroker(fxClaw, raiz);
    const gc = ultimo(await bClaw.hablar(CLAW, { type: 'elffuss-model-get', id: 30, url: YML }));
    ok('(Claw guarda una copia que no cuadra con la lista)', gc.kind === 'file' && gc.file.size === nY - 7, gc.message);
    const antes = b.claves();
    const h = ultimo(await b.hablar(OCR, { type: 'elffuss-model-has', id: 31, url: YML, bytes: nY }));
    ok('herramienta: has de esa copia → no guardado, y la copia sigue', h.kind === 'has' && h.cached === false && JSON.stringify(b.claves()) === JSON.stringify(antes));
    const g = ultimo(await b.hablar(OCR, { type: 'elffuss-model-get', id: 32, url: YML, bytes: nY }));
    ok('herramienta: get de esa copia → «integridad», sin red y sin borrar nada',
      g.kind === 'error' && g.tipo === 'integridad' && fx.peticiones.length === 0 && JSON.stringify(b.claves()) === JSON.stringify(antes), `${g.kind}/${g.tipo} · peticiones=${fx.peticiones.length}`);
    // Claw, que sí puede curar, la rehace con su tamaño.
    const gc2 = ultimo(await bClaw.hablar(CLAW, { type: 'elffuss-model-has', id: 33, url: YML, bytes: nY }));
    ok('(Claw, con el tamaño bueno, sí cura su copia)', gc2.kind === 'has' && gc2.cached === false && b.claves().length < antes.length);
  }
  // 5) una herramienta no vacía lo que guardó Claw; Claw sigue pudiendo
  {
    const fx = servidor(datos, DY); const raiz = new Dir(); const b = nuevoBroker(fx, raiz);
    const g = ultimo(await b.hablar(CLAW, { type: 'elffuss-model-get', id: 40, url: main, bytes: nY }));
    ok('(Claw guarda un modelo de resolve/main)', g.kind === 'file', g.message);
    const antes = b.claves();
    const c = ultimo(await b.hablar(OCR, { type: 'elffuss-model-clear', id: 41 }));
    ok('herramienta: clear rechazado y el almacén intacto', c.tipo === 'permiso' && JSON.stringify(b.claves()) === JSON.stringify(antes) && antes.length > 0, `antes=${antes.length}`);
    const h = ultimo(await b.hablar(OCR, { type: 'elffuss-model-has', id: 42, url: main, bytes: 1 }));
    ok('herramienta: has con un tamaño falso sobre una clave de Claw → «permiso», sin curar nada', h.tipo === 'permiso' && JSON.stringify(b.claves()) === JSON.stringify(antes));
    if (conClear) {
      const c2 = ultimo(await b.hablar(CLAW, { type: 'elffuss-model-clear', id: 43 }));
      ok('Claw: clear sigue funcionando', c2.kind === 'cleared');
    }
  }
  // 6) cancelar una descarga de la lista sí puede
  {
    const fx = servidor(datos); const b = nuevoBroker(fx);
    const r = ultimo(await b.hablar(OCR, { type: 'elffuss-model-cancel', id: 45, url: YML }));
    ok('herramienta: cancel de un fichero de la lista → contesta', r.kind === 'cancelled' || r.kind === undefined, `${r.kind}`);
  }
  // 7) imitaciones: el broker ni contesta
  for (const origen of ['https://ocr.elffuss.utopiaia.com', 'http://ocr.elffuss.com', 'https://ocr.elffuss.com.evil.net', 'https://x.ocr.elffuss.com']) {
    const fx = servidor(datos); const b = nuevoBroker(fx);
    const r = await b.hablar(origen, { type: 'elffuss-model-get', id: 50, url: YML, bytes: nY });
    ok(`${origen}: sin respuesta y sin red`, r.length === 0 && fx.peticiones.length === 0, `${r.length} mensajes`);
  }
  // 8) controles positivos: sin la regla, un clear desde ocr vaciaría el almacén;
  //    sin la lectura sin curar, un has con un tamaño falso borraría la copia de otra herramienta.
  {
    const sinRegla = codigo.replace(/if \(!permisoHerramienta\(type, url, d\.bytes\)\) \{|if \(HERRAMIENTAS\.test\(e\.origin\) && !permisoHerramienta\(type, url, d\.bytes\)\) \{/, m => m.startsWith('if (!') ? 'if (false) {' : 'if (false) {');
    ok('(control: la regla está donde el test la busca)', sinRegla !== codigo);
    if (conClear && sinRegla !== codigo) {
      const fx = servidor(datos, DY); const raiz = new Dir(); const b = nuevoBroker(fx, raiz, sinRegla + '\n;this.__lista = FICHEROS_HERRAMIENTAS;');
      await b.hablar(CLAW, { type: 'elffuss-model-get', id: 60, url: main, bytes: nY });
      const r = ultimo(await b.hablar(OCR, { type: 'elffuss-model-clear', id: 61 }));
      ok('(control: sin la regla, el clear de una herramienta sí vaciaría el almacén)', r.kind === 'cleared');
    }
    if (conCura) {
      const sinLectura = codigo.replace("const f = await cachedFile(url, tam, false); post({ kind:'has'", "const f = await cachedFile(url, 1); post({ kind:'has'");
      ok('(control: la lectura sin curar está donde el test la busca)', sinLectura !== codigo);
      const fx = servidor(datos); const raiz = new Dir(); const b = nuevoBroker(fx, raiz, sinLectura + '\n;this.__lista = FICHEROS_HERRAMIENTAS;');
      await b.hablar(DEPTH, { type: 'elffuss-model-get', id: 62, url: CFG, bytes: nC });
      const antes = b.claves().length;
      await b.hablar(OCR, { type: 'elffuss-model-has', id: 63, url: CFG, bytes: nC });
      ok('(control: si el has de una herramienta curara con otro tamaño, la copia de depth desaparecería)', antes > 0 && b.claves().length < antes, `${antes}→${b.claves().length}`);
    }
  }
}

for (const p of PAGINAS) await probar(p);
console.log(fails ? `\n${fails} de ${total} FALLAN` : `\n${total}/${total} en verde`);
process.exit(fails ? 1 : 0);
