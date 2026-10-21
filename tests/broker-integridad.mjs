// El broker no marca completo lo que no llegó entero, y cura una caché envenenada.
// ─────────────────────────────────────────────────────────────────────────────
// El fallo (visto en vivo, 30-sep): tras una descarga interrumpida y reanudada, el
// broker dejó UNA parte de un modelo multi-parte 381 MB corta y escribió igualmente
// el marcador `.done`. El cargador veía una parte de tamaño equivocado y bajaba el
// modelo ENTERO en cada arranque.
//
// Sin navegador ni red: se extrae el <script> real de server/broker/index.html y se
// ejecuta en un contexto de Node con un OPFS falso en memoria (directorio, ficheros,
// createWritable con escritura diferida hasta close, como el real), un fetch falso
// con Range, cortes y 200 cortos inyectables, y el addEventListener('message')
// capturado: se le habla con los mismos mensajes que la página (get / has).
//
//   node tests/broker-integridad.mjs
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(process.env.BROKER_FILE || join(RAIZ, 'server/broker/index.html'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log((c ? '✅' : '❌') + ' ' + n + (e ? '  — ' + e : '')); if (!c) fails++; };
const sha = b => createHash('sha256').update(b).digest('hex');

// ── el código real de la página, con dos ajustes de escala para el test ──────
let codigo = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const ajusta = (de, a) => { if (!codigo.includes(de)) throw new Error('el broker cambió, ajusta el test: ' + de); codigo = codigo.replace(de, a); };
ajusta('const TRAMO = 64 * 1024 * 1024;', 'const TRAMO = 1000;');                  // varias partes con pocos bytes
ajusta('Math.min(15000, 1000 * 2 ** (fallos - 1))', '1');                          // sin esperas reales

// ── OPFS falso ───────────────────────────────────────────────────────────────
class FH {
  constructor(dir, nombre) { this.dir = dir; this.name = nombre; this.kind = 'file'; }
  async getFile() { return new Blob([this.dir.datos.get(this.name)]); }
  async createWritable() {
    const dir = this.dir, nombre = this.name; const trozos = [];
    return { write: async v => { trozos.push(Buffer.from(v)); },
             close: async () => { dir.datos.set(nombre, Buffer.concat(trozos)); },
             abort: async () => {} };
  }
}
class Dir {
  constructor() { this.datos = new Map(); this.sub = new Map(); }
  async getFileHandle(n, o = {}) {
    if (!this.datos.has(n)) { if (!o.create) throw Object.assign(new Error('NotFoundError'), { name: 'NotFoundError' }); this.datos.set(n, Buffer.alloc(0)); }
    return new FH(this, n);
  }
  async getDirectoryHandle(n, o = {}) { if (!this.sub.has(n)) this.sub.set(n, new Dir()); return this.sub.get(n); }
  async removeEntry(n) { if (!this.datos.delete(n)) throw new Error('NotFoundError'); }
  async *keys() { for (const n of [...this.datos.keys()]) yield n; }
}

// ── servidor falso: un fichero, con Range y fallos inyectables ───────────────
function servidor(datos, cfg = {}) {
  const peticiones = [];
  const f = async (url, init = {}) => {
    const rango = init.headers?.Range || init.headers?.range || '';
    const m = /bytes=(\d+)-(\d*)/.exec(rango);
    peticiones.push(rango || 'entero');
    const total = datos.length;
    const ini = m ? +m[1] : 0, fin = m && m[2] ? +m[2] : total - 1;
    const sonda = rango === 'bytes=0-0';
    let cuerpo = datos.subarray(ini, fin + 1);
    const cab = { etag: '"v1"', 'accept-ranges': 'bytes' };
    let status = 200;
    if (m && !cfg.sinRango) { status = 206; cab['content-range'] = `bytes ${ini}-${fin}/${total}`; cab['content-length'] = String(cuerpo.length); }
    else if (!cfg.sinContentLength) cab['content-length'] = String(total);
    if (!sonda) {
      const k = peticiones.length;                              // n.º de petición de DATOS
      const n = peticiones.filter(r => r !== 'bytes=0-0').length;
      if (cfg.cortaTrasEn && cfg.cortaTrasEn[n] != null) {      // la conexión se cae tras N bytes
        const hasta = cfg.cortaTrasEn[n]; const parte = cuerpo.subarray(0, hasta);
        return new Response(new ReadableStream({ pull(c) { if (!c.__dado) { c.__dado = true; c.enqueue(parte); } else c.error(new TypeError('network error')); } }), { status, headers: cab });
      }
      if (cfg.recorteFinal) cuerpo = cuerpo.subarray(0, cuerpo.length - cfg.recorteFinal);   // fin limpio pero CORTO
    }
    return new Response(sonda ? cuerpo.subarray(0, 1) : cuerpo, { status, headers: cab });
  };
  f.peticiones = peticiones; return f;
}

// ── un broker nuevo (OPFS vacío) por caso ────────────────────────────────────
function nuevoBroker(fetch, raiz = new Dir()) {
  const oyentes = [];
  const ctx = vm.createContext({
    navigator: { storage: { getDirectory: async () => raiz, persist: async () => true, persisted: async () => true, estimate: async () => ({}) } },
    location: { search: '', origin: 'http://localhost' }, URLSearchParams, URL, fetch, Blob, Response, ReadableStream,
    TextEncoder, TextDecoder, AbortController, DOMException, console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON,
    Uint8Array, Promise, Error, crypto: globalThis.crypto, parent: { postMessage() {} },
    addEventListener: (t, h) => { if (t === 'message') oyentes.push(h); },
  });
  vm.runInContext(codigo, ctx);
  const store = raiz.sub.get('elffuss-models') ?? (raiz.sub.set('elffuss-models', new Dir()), raiz.sub.get('elffuss-models'));
  const hablar = (data) => new Promise(res => {
    const msgs = [];
    const source = { postMessage: m => { msgs.push(m); if (['file', 'error', 'has', 'cancelled', 'put'].includes(m.kind)) res(msgs); } };
    for (const h of oyentes) h({ origin: 'http://localhost', data, source });
  });
  return { store, get: (url, bytes) => hablar({ type: 'elffuss-model-get', id: 1, url, bytes }), has: (url, bytes) => hablar({ type: 'elffuss-model-has', id: 2, url, bytes }),
           put: (url, file) => hablar({ type: 'elffuss-model-put', id: 3, url, file }) };
}
const url = 'https://m1.elffuss.com/modelo.part1.bin';
const contenido = n => { const b = Buffer.alloc(n); let x = 12345; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >> 16; } return b; };
const DATOS = contenido(3456);                                  // 4 partes de 1000 (la última de 456)
const marcador = async b => { try { return JSON.parse(await (await b.store.getFileHandle(Object.keys([...b.store.datos.keys()].reduce((o, n) => (o[n.replace(/\.done$/, '')] = 1, o), {}))[0] + '.done')).getFile().then(f => f.text())); } catch { return null; } };
const hayMarca = b => [...b.store.datos.keys()].some(n => n.endsWith('.done'));
const nombresPartes = b => [...b.store.datos.keys()].filter(n => /\.p\d+$/.test(n));
const bytesFile = async f => Buffer.from(await f.arrayBuffer());
const ultimo = m => m[m.length - 1];

// 1) descarga correcta -> marcador, y se sirve de caché sin red
{
  const fx = servidor(DATOS); const b = nuevoBroker(fx);
  const r = ultimo(await b.get(url, DATOS.length));
  ok('descarga correcta: responde con el fichero', r.kind === 'file', r.message);
  ok('descarga correcta: SHA-256 idéntico', r.file && sha(await bytesFile(r.file)) === sha(DATOS));
  const man = JSON.parse(b.store.datos.get([...b.store.datos.keys()].find(n => n.endsWith('.done'))).toString());
  ok('descarga correcta: marcador con tamaño, total y partes', man.size === DATOS.length && man.total === DATOS.length && man.parts === 4, JSON.stringify(man));
  const antes = fx.peticiones.length;
  const h = ultimo(await b.has(url, DATOS.length));
  const r2 = ultimo(await b.get(url, DATOS.length));
  ok('has: cacheado con el tamaño declarado', h.cached === true && h.size === DATOS.length);
  ok('segunda lectura sin tocar la red', r2.kind === 'file' && fx.peticiones.length === antes);
}

// 2) interrumpida y REANUDADA: se corta a mitad, el broker reintenta con Range y termina entero
{
  const fx = servidor(DATOS, { cortaTrasEn: { 1: 1500 } }); const b = nuevoBroker(fx);
  const msgs = await b.get(url, DATOS.length); const r = ultimo(msgs);
  ok('corte + reanudación: completa', r.kind === 'file', r.message);
  ok('corte + reanudación: pide el resto con Range (no desde cero)', fx.peticiones.some(p => /^bytes=1500-/.test(p) || /^bytes=1[0-9]{3}-/.test(p)), fx.peticiones.join(' | '));
  ok('corte + reanudación: SHA-256 idéntico', r.file && sha(await bytesFile(r.file)) === sha(DATOS));
  ok('corte + reanudación: avisó del reintento', msgs.some(m => m.reintento));
}

// 3) el servidor termina CORTO y limpio, una y otra vez (la parte que se quedó corta): ni marcador ni «completo»
{
  const fx = servidor(DATOS, { recorteFinal: 381 }); const b = nuevoBroker(fx);
  const r = ultimo(await b.get(url, DATOS.length));
  ok('parte corta: devuelve ERROR, no el fichero', r.kind === 'error' && !r.file, r.message);
  ok('parte corta: NO hay marcador .done', !hayMarca(b));
  const h = ultimo(await b.has(url, DATOS.length));
  ok('parte corta: has dice no-cacheado', h.cached === false);
}
// 3b) 200 corto sin Content-Length ni Range, con el tamaño declarado por el registro -> integridad, se descarta
{
  const fx = servidor(DATOS, { sinRango: true, sinContentLength: true, recorteFinal: 381 }); const b = nuevoBroker(fx);
  const r = ultimo(await b.get(url, DATOS.length));
  ok('200 corto sin total: error de integridad', r.kind === 'error' && r.tipo === 'integridad', `${r.tipo}: ${r.message}`);
  ok('200 corto sin total: sin marcador y sin partes huérfanas', !hayMarca(b) && nombresPartes(b).length === 0, nombresPartes(b).join());
}
// 3c) el servidor mide otra cosa que lo declarado -> se corta antes de bajar nada
{
  const fx = servidor(DATOS); const b = nuevoBroker(fx);
  const r = ultimo(await b.get(url, DATOS.length + 381));
  ok('tamaño declarado distinto del del servidor: integridad, sin marcador',
    r.kind === 'error' && r.tipo === 'integridad' && !hayMarca(b), `${r.tipo}: ${r.message}`);
  ok('…y sin bajar los datos', fx.peticiones.every(p => p === 'bytes=0-0'), fx.peticiones.join(' | '));
}

// 4) AUTOCURACIÓN: marcador viejo que no cuadra con lo que hay
const sembrar = (b, k, partes, marca) => {
  partes.forEach((p, i) => b.store.datos.set(k + '.p' + i, p));
  b.store.datos.set(k + '.done', Buffer.from(typeof marca === 'string' ? marca : JSON.stringify(marca)));
};
const K = 'https_m1.elffuss.com_modelo.part1.bin';
{
  const b = nuevoBroker(servidor(DATOS)); const k = [...[url].map(u => u.replace(/[?#].*$/, '').replace(/[^\w.\-]+/g, '_').slice(-180))][0];
  ok('(la clave de prueba coincide con la del broker)', k === K, k);
  sembrar(b, K, [DATOS.subarray(0, 1000), DATOS.subarray(1000, 2000)], { size: 3456, total: 3456, parts: 2 });   // marcador dice 3456, hay 2000
  const h = ultimo(await b.has(url));
  ok('marcador que no cuadra con las partes: has = no cacheado', h.cached === false);
  ok('…y el marcador y las partes se BORRAN (autocuración)', !hayMarca(b) && nombresPartes(b).length === 0, [...b.store.datos.keys()].join());
}
{
  const b = nuevoBroker(servidor(DATOS));
  sembrar(b, K, [DATOS.subarray(0, 3000)], { size: 3000, total: 3000, parts: 1 });             // coherente consigo mismo, pero el registro dice 3456
  const h = ultimo(await b.has(url, 3456));
  ok('copia coherente pero distinta de lo declarado (la de 381 MB corta): no cacheado y curada', h.cached === false && !hayMarca(b));
}
{
  const fx = servidor(DATOS); const b = nuevoBroker(fx);
  sembrar(b, K, [DATOS.subarray(0, 3000)], { size: 3000, total: 3000, parts: 1 });
  const r = ultimo(await b.get(url, DATOS.length));
  ok('get sobre copia envenenada: la rehace entera y bien', r.kind === 'file' && sha(await bytesFile(r.file)) === sha(DATOS));
}
{
  const b = nuevoBroker(servidor(DATOS));
  sembrar(b, K, [DATOS], '3456');                                                              // marcador del broker ANTIGUO: solo un número
  const h = ultimo(await b.has(url, 3456));
  ok('marcador antiguo (solo un número): no cacheado y curado', h.cached === false && !hayMarca(b));
}
{
  const b = nuevoBroker(servidor(DATOS));
  sembrar(b, K, [DATOS.subarray(0, 2000), DATOS.subarray(2000)], { size: 3456, total: 3456, parts: 2 });
  const h = ultimo(await b.has(url, 3456));
  ok('copia sana con marcador sano: SE CONSERVA (la curación no tira lo bueno)', h.cached === true && h.size === 3456 && hayMarca(b));
}
{
  const b = nuevoBroker(servidor(DATOS));
  sembrar(b, K, [DATOS.subarray(0, 2000)], { size: 3456, total: 3456, parts: 2 });             // falta una parte entera
  const h = ultimo(await b.has(url));
  ok('marcador que apunta a una parte inexistente: curado', h.cached === false && !hayMarca(b));
}

// (Las comprobaciones del cliente —qué broker usa Claw para cada fichero— van con el
// cambio del SDK en la rama resume-fix; aquí solo se prueba la página del broker.)

// 6) COPIA desde la web (migrar su caché vieja): solo si casa con la huella del Hub
{
  const PESOS = contenido(2600), JSONB = Buffer.from('{"a":1}\n');
  const sha1git = b => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');
  const HUBURL = 'https://huggingface.co/org/modelo/resolve/main/';
  const hub = () => {
    const peticiones = [];
    const f = async (u) => {
      peticiones.push(String(u));
      if (String(u) === 'https://huggingface.co/api/models/org/modelo/tree/main/onnx')
        return new Response(JSON.stringify([{ type: 'file', path: 'onnx/m.onnx', size: PESOS.length, oid: 'x', lfs: { oid: sha(PESOS), size: PESOS.length } }]), { status: 200 });
      if (String(u) === 'https://huggingface.co/api/models/org/modelo/tree/main')
        return new Response(JSON.stringify([{ type: 'file', path: 'config.json', size: JSONB.length, oid: sha1git(JSONB) }, { type: 'directory', path: 'onnx' }]), { status: 200 });
      return new Response('no', { status: 404 });
    };
    f.peticiones = peticiones; return f;
  };
  {
    const fx = hub(); const b = nuevoBroker(fx);
    const r = ultimo(await b.put(HUBURL + 'onnx/m.onnx', new Blob([PESOS])));
    ok('copia de pesos con su SHA-256: se guarda', r.kind === 'put' && r.size === PESOS.length, r.message);
    const h = ultimo(await b.has(HUBURL + 'onnx/m.onnx'));
    const g = ultimo(await b.get(HUBURL + 'onnx/m.onnx'));
    ok('…y se sirve igual que una descarga, sin bajar nada', h.cached === true && g.kind === 'file' && sha(await bytesFile(g.file)) === sha(PESOS) &&
      fx.peticiones.every(u => u.includes('/api/models/')), fx.peticiones.join(' | '));
    ok('…en partes de tramo, con su marcador', nombresPartes(b).length === 3 && hayMarca(b), nombresPartes(b).join());
  }
  {
    const b = nuevoBroker(hub());
    const r = ultimo(await b.put(HUBURL + 'config.json', new Blob([JSONB])));
    ok('copia de un JSON con su huella de git: se guarda', r.kind === 'put', r.message);
  }
  {
    const b = nuevoBroker(hub()); const malo = Buffer.from(PESOS); malo[7] ^= 1;
    const r = ultimo(await b.put(HUBURL + 'onnx/m.onnx', new Blob([malo])));
    ok('copia con un byte cambiado: rechazada por integridad y sin nada en disco',
      r.kind === 'error' && r.tipo === 'integridad' && !hayMarca(b) && nombresPartes(b).length === 0, `${r.tipo}: ${r.message}`);
  }
  {
    const b = nuevoBroker(hub());
    const r = ultimo(await b.put(HUBURL + 'onnx/otro.onnx', new Blob([PESOS])));
    ok('copia de un fichero que el Hub no publica: rechazada', r.kind === 'error' && r.tipo === 'integridad' && !hayMarca(b), r.message);
  }
  {
    const b = nuevoBroker(hub());
    const r = ultimo(await b.put(url, new Blob([DATOS])));
    ok('copia de algo que no es de Hugging Face: rechazada', r.kind === 'error' && !hayMarca(b), r.message);
  }
}

console.log(fails ? `\n${fails} FALLO(S)` : '\nTodo en verde');
process.exit(fails ? 1 : 0);
