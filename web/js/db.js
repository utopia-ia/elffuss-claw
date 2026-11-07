// IndexedDB mínima: stores clave→valor.
const NAME = 'elffuss', VERSION = 2;
const STORES = ['kv', 'apps', 'tasks', 'vault', 'fs', 'memory'];

// Una conexión IndexedDB que sobrevive a que el navegador la cierre. Safari
// cierra por su cuenta las conexiones de una página (pestaña dormida en segundo
// plano, falta de memoria, almacenamiento desalojado) y desde entonces cada
// db.transaction() lanza «The database connection is closing». Así que la
// conexión se olvida al cerrarse o cuando otra pestaña pide una versión nueva,
// y una transacción que no pudo empezar, o que el navegador abortó, se repite
// UNA vez con una conexión nueva. Nunca escribe dos veces: una transacción
// abortada no confirma nada, y la que falla por sí misma (una clave mala, la
// cuota) no se repite.
//   abrir()  → promesa de una conexión NUEVA
//   run(fn)  → fn(db) abre una transacción y devuelve su promesa
const CONEXION_PERDIDA = new Set(['InvalidStateError', 'AbortError', 'UnknownError']);
export function conexion(abrir) {
  let actual = null;
  const olvida = p => { if (actual === p) actual = null; };
  const open = () => {
    if (actual) return actual;
    const p = actual = abrir().then(db => {
      db.onclose = () => olvida(p);
      db.onversionchange = () => { db.close(); olvida(p); };
      return db;
    });
    p.catch(() => olvida(p));
    return p;
  };
  const run = async fn => {
    for (let otra = false; ; otra = true) {
      const p = open();
      const db = await p;
      try { return await fn(db); }
      catch (e) {
        if (otra || !CONEXION_PERDIDA.has(e?.name)) throw e;
        olvida(p);
        try { db.close(); } catch { /* ya se estaba cerrando */ }
      }
    }
  };
  return { open, run };
}

const { run } = conexion(() => new Promise((resolve, reject) => {
  const req = indexedDB.open(NAME, VERSION);
  req.onupgradeneeded = () => {
    for (const s of STORES)
      if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
}));

// Resuelve con el resultado de la petición cuando la transacción TERMINA (una
// escritura ya está guardada); rechaza si la transacción se aborta.
function tx(store, mode, fn) {
  return run(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req.result);
    t.onabort = () => reject(t.error || req.error || new Error('transacción abortada'));
  }));
}

// Leer-modificar-escribir en UNA transacción: entre la lectura y la escritura
// nadie más puede escribir esa clave (IndexedDB ejecuta las transacciones de
// escritura sobre un mismo almacén una detrás de otra, también entre pestañas).
// `fn(actual)` devuelve el valor nuevo, o undefined para no escribir nada. La
// promesa se resuelve con lo que devolvió `fn`, cuando la transacción termina.
// Si el navegador cierra la conexión a medias, se repite entera: `fn` vuelve a
// recibir lo que hay guardado, y nada de la vez abortada quedó escrito.
export const update = (store, key, fn) => run(db => new Promise((resolve, reject) => {
  const t = db.transaction(store, 'readwrite');
  const s = t.objectStore(store);
  let nuevo;
  const req = s.get(key);
  req.onsuccess = () => {
    try { nuevo = fn(req.result); } catch (e) { t.abort(); reject(e); return; }
    if (nuevo !== undefined) s.put(nuevo, key);
  };
  t.oncomplete = () => resolve(nuevo);
  t.onerror = () => reject(t.error);
  t.onabort = () => reject(t.error || new Error('transacción abortada'));
}));

export const get  = (store, key)      => tx(store, 'readonly',  s => s.get(key));
export const set  = (store, key, val) => tx(store, 'readwrite', s => s.put(val, key));
export const del  = (store, key)      => tx(store, 'readwrite', s => s.delete(key));
export const keys = (store)           => tx(store, 'readonly',  s => s.getAllKeys());
export const all  = (store)           => tx(store, 'readonly',  s => s.getAll());
// Vacía un almacén entero. Para «Borrar todo del navegador», que borra TODOS
// (ALMACENES), no solo los que se enseñan en «Qué hay guardado».
export const clear = (store)          => tx(store, 'readwrite', s => s.clear());
export const ALMACENES = [...STORES];
