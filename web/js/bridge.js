// Puente de Claw para el chat de elffuss.com: la MISMA memoria y las MISMAS apps, no una copia.
// ─────────────────────────────────────────────────────────────────────────────
// El chat de https://elffuss.com carga bridge.html en un iframe oculto. elffuss.com y claw.elffuss.com son el
// mismo sitio, así que este iframe abre el IndexedDB «elffuss» de Claw sin particionar: lo que el chat guarda
// aquí lo ve Claw, y lo que guarda Claw lo ve el chat.
//
// Contrato (postMessage, ids y nombres en inglés):
//   pide:     { kind: 'elffuss-bridge', v: 1, id, op, args }
//   contesta: { kind: 'elffuss-bridge', v: 1, id, ok: true, result }  o  { …, ok: false, error }
//   al cargar: { kind: 'elffuss-bridge', v: 1, op: 'ready' }
//   op: memory.list · memory.save {fact} · memory.forget {id}
//       apps.list · apps.get {name} · apps.save {name, html} · apps.remove {name}
//
// Lo que NO hace, a propósito:
//   · Contestar a nadie que no sea la ventana que lo contiene, ni a un origen fuera de ALLOWED. A los demás no
//     les contesta NADA (ni un error): no tienen por qué saber que esto existe.
//   · Tocar vault, fs, tasks ni kv. Solo los almacenes 'memory' y 'apps'.
//   · Ejecutar nada de lo que llega. Los mensajes se validan campo a campo (tipos, tamaños, claves conocidas) y
//     el HTML de una app se guarda como texto: lo ejecuta, en su caja, quien lo enseña.
//   · Pedir permisos: el chat pregunta antes de guardar, como Claw (permissions.js), y aquí no hay interfaz.
//
// Las apps son las de Claw: tools/apps.js create() ({name, html, created}, con la misma regla para los nombres
// genéricos «app» y «boceto»). db.js es el de Claw: mismo nombre, versión y almacenes.
//
// MEMORIA: PUENTE DE TRANSICIÓN (v1 → memoria compartida v2). La memoria ya no vive en el almacén 'memory' de
// Claw sino en la memoria compartida de Elffuss (web/memory/, motor js/engine/memory*.js), que el chat nuevo usa
// directamente. Las tres operaciones de memoria de aquí quedan solo para las versiones del chat que aún hablen v1,
// y en modo «casi solo lectura»:
//   · memory.list  responde desde la memoria compartida: los 8 hechos activos más relevantes, en la forma de
//                  siempre {id, fact, at};
//   · memory.save  NO guarda: deja una PROPUESTA etiquetada «no sale de tus palabras» que el usuario confirma
//                  con un clic en Memoria (aquí no hay evidencia de lo que el usuario escribió);
//   · memory.forget se rechaza: olvidar se hace desde Memoria, donde el usuario ve lo que olvida.
// Las peticiones pasan por el almacén con la identidad de la app 'chat' (permiso, límites y reglas del almacén).
// Este puente de memoria se retira 30 días después de que el chat publique la memoria v2.
import * as db from './db.js';

// Solo el chat de producción. Las pruebas abren la página con este mismo origen (resolución de nombres
// apuntada a un servidor local), así que no hace falta ningún origen de pruebas aquí.
const ALLOWED = ['https://elffuss.com'];

const KIND = 'elffuss-bridge';
const MAX_FACT = 300;              // lo que guarda Claw (tools/memory.js)
const MAX_NAME = 80;
const MAX_HTML = 512 * 1024;       // una app hecha por el modelo cabe de sobra
const RE_ID = /^[\w-]{1,40}$/;
const RE_CONTROL = /[\u0000-\u001f\u007f]/;

const esObjeto = (x) => !!x && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const texto = (x, max) => typeof x === 'string' && x.trim().length > 0 && x.length <= max;
const nombre = (x) => texto(x, MAX_NAME) && !RE_CONTROL.test(x);

class Rechazo extends Error { constructor(code) { super(code); this.code = code; } }
const exige = (cond, code = 'bad-request') => { if (!cond) throw new Rechazo(code); };

// Avisa a otras pestañas de Claw de que algo ha cambiado (ui.js repinta su panel si escucha).
let canal = null;
try { canal = new BroadcastChannel(KIND); } catch { /* sin BroadcastChannel */ }
const avisa = (store) => { try { canal?.postMessage({ kind: 'changed', store }); } catch { /* — */ } };

// La memoria compartida, abierta en este proceso (este iframe es del mismo origen que la página almacén). Se
// abre al primer uso; si el motor servido no trae los módulos de memoria, las operaciones de memoria fallan
// cerradas ('failed') y las de apps siguen igual.
const APP_V1 = 'chat';          // el único origen permitido aquí es el chat de elffuss.com
const LISTA_V1 = 8;
let memoria = null;
function almacen() {
  if (!memoria) {
    memoria = (async () => {
      const [{ default: cfg }, { openStore }] = await Promise.all([
        import('../memory/memory.config.js'), import('./engine/memory-store.js')]);
      return openStore(cfg);
    })();
    memoria.catch(() => { memoria = null; });
  }
  return memoria;
}
async function llama(op, args) {
  let st;
  try { st = await almacen(); } catch { throw new Rechazo('failed'); }
  const r = await st.call(op, args, { app: APP_V1 });
  if (!r.ok) throw new Rechazo(r.error?.code === 'too_long' ? 'too-large' : r.error?.code === 'rate' ? 'rate' : r.error?.code === 'no_grant' ? 'no-grant' : 'failed');
  return r.result;
}
export const MEMORIA_V1 = Object.freeze({
  noGuardado: 'Pendiente de confirmar en Memoria · Waiting for confirmation in Memory',
  olvidaEnMemoria: 'Olvídalo desde Memoria · Forget it from Memory',
});

const OPS = {
  'memory.list': { keys: [], run: async () => {
    const r = await llama('search', { query: '', limit: LISTA_V1 });
    return (r.items || []).map(({ id, fact, at }) => ({ id, fact, at })).sort((a, b) => a.at - b.at);
  } },

  'memory.save': { keys: ['fact'], run: async ({ fact }) => {
    exige(texto(fact, MAX_FACT), fact && fact.length > MAX_FACT ? 'too-large' : 'bad-request');
    const r = await llama('propose', { fact, label: 'from-content' });
    // Nunca se dice «guardado»: es una propuesta que el usuario tiene que confirmar.
    throw new Rechazo(r && r.status === 'noop' ? 'failed' : MEMORIA_V1.noGuardado);
  } },

  'memory.forget': { keys: ['id'], run: async ({ id }) => {
    exige(typeof id === 'string' && RE_ID.test(id));
    throw new Rechazo(MEMORIA_V1.olvidaEnMemoria);
  } },

  'apps.list': { keys: [], run: async () =>
    (await db.all('apps')).filter((a) => a && typeof a.name === 'string')
      .map((a) => ({ name: a.name, created: a.created || 0, bytes: String(a.html || '').length })) },

  'apps.get': { keys: ['name'], run: async ({ name }) => {
    exige(nombre(name));
    const a = await db.get('apps', name);
    exige(a && typeof a.html === 'string', 'not-found');
    return { name: a.name, html: a.html, created: a.created || 0 };
  } },

  'apps.save': { keys: ['name', 'html'], run: async ({ name, html }) => {
    exige(nombre(name));
    exige(typeof html === 'string' && html.length > 0, 'bad-request');
    exige(html.length <= MAX_HTML, 'too-large');
    if (name === 'app' || name === 'boceto') {   // como apps.create: un nombre genérico no machaca la anterior
      let n = name, i = 1;
      while (await db.get('apps', n)) n = `${name}-${++i}`;
      name = n;
    }
    const replaced = !!(await db.get('apps', name));
    const created = Date.now();
    await db.set('apps', name, { name, html, created });
    avisa('apps');
    return { name, created, replaced };
  } },

  'apps.remove': { keys: ['name'], run: async ({ name }) => {
    exige(nombre(name));
    const habia = !!(await db.get('apps', name));
    await db.del('apps', name);
    if (habia) avisa('apps');
    return { name, existed: habia };
  } },
};

function valida(m) {
  exige(esObjeto(m) && m.kind === KIND && m.v === 1);
  exige(typeof m.id === 'string' && RE_ID.test(m.id));
  exige(typeof m.op === 'string' && Object.hasOwn(OPS, m.op));
  const args = m.args === undefined ? {} : m.args;
  exige(esObjeto(args));
  const permitidas = OPS[m.op].keys;
  for (const k of Object.keys(args)) exige(permitidas.includes(k));
  return { op: OPS[m.op], args };
}

if (window.parent !== window) {
  addEventListener('message', async (e) => {
    if (!ALLOWED.includes(e.origin) || e.source !== window.parent) return;
    const m = e.data;
    // Sin un id válido no hay a quién contestar: se ignora.
    if (!esObjeto(m) || m.kind !== KIND || typeof m.id !== 'string' || !RE_ID.test(m.id)) return;
    const responde = (cuerpo) => { try { e.source.postMessage({ kind: KIND, v: 1, id: m.id, ...cuerpo }, e.origin); } catch { /* — */ } };
    try {
      const { op, args } = valida(m);
      responde({ ok: true, result: await op.run(args) });
    } catch (err) {
      responde({ ok: false, error: err instanceof Rechazo ? err.code : 'failed' });
    }
  });
  // El origen de quien nos contiene no se puede leer: se avisa a cada origen permitido y postMessage solo lo
  // entrega al que coincide.
  for (const o of ALLOWED) { try { window.parent.postMessage({ kind: KIND, v: 1, op: 'ready' }, o); } catch { /* — */ } }
}
