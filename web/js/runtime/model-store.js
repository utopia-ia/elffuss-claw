// Elffuss Runtime · almacén de modelos en OPFS (persistente, en disco).
// ─────────────────────────────────────────────────────────────────────────────
// Sustituye a Cache Storage para los PESOS del modelo. Motivo real (bug de móvil):
// Cache Storage se desaloja en iOS/Android → el modelo se re-descargaba en CADA
// visita. OPFS (Origin Private File System) + navigator.storage.persist() aguanta
// entre sesiones y se lee como File respaldado por DISCO (no vuelca todo a RAM).
//
// Además es la capa de almacenamiento del loader por shards: el motor leerá los
// pesos por rangos desde el File sin cargar los gigabytes enteros en memoria.
//
// Licencia: código propio (Apache-2.0). Sin dependencias externas.

const DIR = 'elffuss-models';

// Los modelos se guardan PARTIDOS en trozos de este tamaño, y no por gusto: el
// navegador impone un tope POR FICHERO muy por debajo de su cuota declarada.
// Medido escribiendo de verdad en OPFS hasta que el navegador se planta
// (tests/modelparts.mjs comprueba la lógica; el tope se midió a mano):
//
//   · un ÚNICO fichero se corta MUY por debajo de la cuota anunciada por
//     storage.estimate() — en torno a la quinta parte de lo que promete;
//   · el mismo contenido repartido en trozos llega a más del TRIPLE, y con eso
//     un modelo de varios GB entra sin problema;
//   · el error es el mismo en los dos casos («exceed its storage quota»), así
//     que el número anunciado no sirve para decidir nada: hay que escribir para
//     saberlo, y no se puede deducir de storage.estimate().
//
// 1 GiB —y no menos— por una razón concreta: se abre parte nueva solo AL
// llenarse la actual, así que con este corte todos los modelos en uso hoy
// (gemma 760 MB, qwen 0.8B) siguen siendo UN fichero y su camino no cambia ni
// un byte; LiteRT sigue recibiendo el mismo File de siempre. Y queda a la mitad
// del tope observado, que es margen de sobra para otras máquinas.
let PART = 1024 * 1024 * 1024;

// Solo para tests: la lógica de fronteras (repartir un chunk de red entre dos
// partes, leer un rango a caballo) no depende del tamaño, y con 1 GiB haría
// falta bajar gigabytes para ejercitarla. El valor real lo justifica la medición
// de arriba; lo que hay que probar es la aritmética.
export function _setPartSize(n) { PART = Math.max(1, n | 0); }

// WebKit (Safari 26, medido en un iPhone el 8-nov) escribe con write(vista) el
// ArrayBuffer ENTERO de la vista, no solo sus bytes: write(buf.subarray(10, 20))
// de un buffer de 100 dejó un fichero de 200. Al repartir un chunk entre dos
// partes, el modelo salía más largo de lo que mide. Se copia el trozo antes.
const exacto = (v) => (ArrayBuffer.isView(v) && (v.byteOffset !== 0 || v.byteLength !== v.buffer.byteLength) ? v.slice() : v);

// Nombre de fichero estable y seguro a partir de la URL (sin barras ni query).
function keyFor(url) {
  return String(url).replace(/[?#].*$/, '').replace(/[^\w.\-]+/g, '_').slice(-180);
}

// El marcador «.done» lleva dentro cuántas partes hay. Sin él, un modelo a
// medias se serviría como si estuviera entero.
async function leerManifiesto(dir, key) {
  try {
    const f = await (await dir.getFileHandle(key + '.done')).getFile();
    const m = JSON.parse(await f.text());
    return m && typeof m === 'object' ? m : {};
  } catch { return null; }               // no existe, o descarga cortada
}

// Abre las partes ya guardadas, o null si falta alguna. `parts` ausente = modelo
// guardado por una versión anterior en un solo fichero: se sigue leyendo igual.
async function abrirPartes(dir, key, man) {
  const n = Number.isInteger(man.parts) && man.parts > 0 ? man.parts : null;
  const nombres = n === null ? [key] : Array.from({ length: n }, (_, i) => `${key}.p${i}`);
  const out = [];
  for (const nombre of nombres) {
    try {
      const f = await (await dir.getFileHandle(nombre)).getFile();
      if (!f.size) return null;
      out.push(f);
    } catch { return null; }             // parte perdida: no servir un modelo roto
  }
  // El tamaño total tiene que cuadrar con el declarado. Un fichero truncado por
  // un desalojo del navegador se lee sin error y el parser saldría con basura.
  const suma = out.reduce((s, f) => s + f.size, 0);
  if (man.size && suma !== man.size) return null;
  return out;
}

async function requestPersist() {
  try {
    if (navigator.storage?.persist) {
      const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      return already || await navigator.storage.persist();
    }
  } catch { /* no bloquea */ }
  return false;
}

async function dirHandle() {
  const root = await navigator.storage.getDirectory();      // lanza si no hay OPFS
  return await root.getDirectoryHandle(DIR, { create: true });
}

// ¿Hay soporte para escribir en OPFS de forma útil en este navegador?
// Chrome/escritorio: createWritable (stream a disco). iOS Safari: solo
// createSyncAccessHandle (en worker) → en este primer incremento, si no hay
// createWritable en el hilo principal, devolvemos null y el llamador cae a Cache.
async function opfsWritableSupported(dir) {
  try {
    const test = await dir.getFileHandle('.probe', { create: true });
    if (typeof test.createWritable !== 'function') { await dir.removeEntry('.probe').catch(() => {}); return false; }
    const w = await test.createWritable();
    await w.close();
    await dir.removeEntry('.probe').catch(() => {});
    return true;
  } catch { return false; }
}

// ¿Se puede escribir OPFS desde un Worker en este navegador? Se PRUEBA, no se
// deduce del user-agent: la detección por cadena de navegador envejece mal y
// aquí equivocarse significa bajarse gigabytes para tirarlos.
//
// Devuelve el escritor listo, o null si no hay forma — y en ese caso el
// llamador cae a Cache Storage, que es peor pero funciona.
async function abrirWorkerOPFS() {
  if (typeof Worker !== 'function' || !navigator.storage?.getDirectory) return null;
  let w = null;
  try {
    w = new Worker(new URL('./opfs-worker.js', import.meta.url), { type: 'module' });
    const esc = escritorWorker(w);
    // Prueba de verdad: abrir, escribir un byte y cerrar. Si el navegador dice
    // que tiene la API pero falla al usarla, aquí se entera y no al 97 % de una
    // descarga de gigabytes.
    await esc.abrir('.probe-worker');
    await esc.write(new Uint8Array([0]));
    await esc.close();
    const raiz = await navigator.storage.getDirectory();
    const dir = await raiz.getDirectoryHandle(DIR, { create: true });
    await dir.removeEntry('.probe-worker').catch(() => {});
    return esc;
  } catch {
    try { w && w.terminate(); } catch {}
    return null;
  }
}

// ESCRITOR POR WORKER — el camino de iOS.
//
// Expone `write(bytes)` y `close()`, o sea la misma forma que el `writable` de
// `createWritable`, para que el bucle de descarga sea UNO solo y no dos copias
// que se desincronizan. Por dentro manda los trozos a `opfs-worker.js`, que es
// el único sitio donde iOS deja escribir OPFS.
//
// Cada escritura ESPERA su acuse. Sin esperar, el hilo principal lee de la red
// mucho más rápido de lo que el worker escribe, la cola de mensajes crece sin
// límite y los gigabytes acaban en RAM — justo lo que este almacén existe para
// evitar.
function escritorWorker(worker) {
  let seq = 0;
  const pendientes = new Map();
  worker.onmessage = (ev) => {
    const { id, ok, r, error } = ev.data || {};
    const p = pendientes.get(id);
    if (!p) return;
    pendientes.delete(id);
    ok ? p.res(r) : p.rej(new Error(error || 'fallo en el worker de OPFS'));
  };
  // Un worker que revienta dejaría todas las esperas colgadas para siempre: la
  // descarga se quedaría quieta sin mensaje. Se rechazan todas.
  worker.onerror = (e) => {
    const err = new Error('el worker de OPFS falló: ' + (e.message || e.type));
    for (const p of pendientes.values()) p.rej(err);
    pendientes.clear();
  };
  const pedir = (msg, transfer) => new Promise((res, rej) => {
    const id = ++seq;
    pendientes.set(id, { res, rej });
    worker.postMessage({ ...msg, id }, transfer || []);
  });
  return {
    abrir: (nombre) => pedir({ op: 'abrir', carpeta: DIR, nombre }),
    write: (bytes) => {
      // Se COPIA antes de transferir: `bytes` es una vista del buffer del
      // lector de red, y transferir ese buffer lo dejaría neutralizado para el
      // resto del chunk, que todavía hay que repartir entre partes.
      const buf = bytes.slice().buffer;
      return pedir({ op: 'escribir', buf }, [buf]);
    },
    close: () => pedir({ op: 'cerrar' }),
    // `abort()` existe porque el camino de ERROR lo llama. Sin él, un fallo de
    // cuota se convertiría en «writable.abort is not a function» y taparía la
    // causa real justo cuando más falta hace verla. Aquí abortar es cerrar: el
    // fichero a medias lo borra después `borrarPartes`.
    abort: () => pedir({ op: 'cerrar' }).catch(() => {}),
    fin: () => worker.terminate(),
  };
}

// Devuelve un Blob (respaldado en disco) del modelo, entero.
// Para los modelos grandes conviene más `openRanged`, que lee por rangos sin
// juntar las partes. Ver `getModelParts` para el detalle.
export async function getModelFile(url, onProgress = () => {}) {
  const partes = await getModelParts(url, onProgress);
  if (!partes) return null;
  // Concatenar Blobs no copia los bytes (el navegador guarda referencias a los
  // ficheros), pero el motor NO depende de eso: usa openRanged, que va parte a
  // parte de forma explícita.
  return partes.length === 1 ? partes[0] : new Blob(partes);
}

// Devuelve las PARTES del modelo (Files respaldados en disco). Descarga por
// chunks a OPFS la primera vez (con progreso real), lo sirve desde disco a
// partir de entonces. Un marcador «<key>.done» evita servir una descarga
// cortada a medias.
// Devuelve null si OPFS no está disponible/escribible → el llamador usa su
// respaldo (Cache Storage) sin romperse.
export async function getModelParts(url, onProgress = () => {}) {
  // 0) Lo que ESTA web ya tiene entero en su OPFS, antes de preguntar al broker. Si no, con la copia aquí y no en el
  //    broker, cada carga le pedía el modelo entero al broker, que se ponía a bajarlo (visto en un iPhone, 8-nov:
  //    230 MB de un 1 GB a medias en el almacén compartido, y el modelo bueno en el de elffuss.com).
  if (navigator.storage?.getDirectory) {
    try {
      const d0 = await dirHandle();
      const k0 = keyFor(url);
      const m0 = await leerManifiesto(d0, k0);
      const p0 = m0 ? await abrirPartes(d0, k0, m0) : null;
      if (p0) { onProgress('Cargando el modelo desde disco (OPFS, sin descargar)…'); return p0; }
    } catch { /* sigue por el broker */ }
  }
  // 1) Caché COMPARTIDA (broker en origen Elffuss): un modelo bajado en CUALQUIER
  //    web de Elffuss se reutiliza aquí sin re-descargar. Fast-fail por sesión si
  //    el broker no está disponible → caemos a la OPFS local de este origen.
  let brokerDown = false;
  try { brokerDown = sessionStorage.getItem('elffuss.broker.down') === '1'; } catch { /* — */ }
  if (!brokerDown) {
    try {
      const { getSharedModel } = await import('./model-broker.js');
      const blob = await getSharedModel(url, onProgress);
      if (blob && blob.size) return [blob];
    } catch { try { sessionStorage.setItem('elffuss.broker.down', '1'); } catch { /* — */ } }
  }

  if (!navigator.storage?.getDirectory) return null;
  let dir;
  try { dir = await dirHandle(); } catch { return null; }
  await requestPersist();

  const key = keyFor(url);
  const doneName = key + '.done';

  // ¿ya está entero en disco?
  const man = await leerManifiesto(dir, key);
  if (man) {
    const partes = await abrirPartes(dir, key, man);
    if (partes) {
      onProgress('Cargando el modelo desde disco (OPFS, sin descargar)…');
      return partes;
    }
  }

  // TRES caminos, no dos. Antes aquí se devolvía null en cuanto no había
  // `createWritable`, y eso mandaba a iOS a Cache Storage — que se desaloja,
  // así que el teléfono se bajaba el modelo entero en cada visita.
  let porWorker = null;
  if (!(await opfsWritableSupported(dir))) {
    porWorker = await abrirWorkerOPFS();
    if (!porWorker) return null;                 // ni una cosa ni la otra: que decida el llamador
  }

  // descargar → OPFS por chunks (no en RAM), partiendo cada PART bytes
  const net = await fetch(url);
  if (!net.ok || !net.body) throw new Error('descarga del modelo falló: HTTP ' + net.status);
  const total = +net.headers.get('content-length') || 0;

  // Aviso temprano. Bajar gigabytes para que el navegador lo rechace al 97% y
  // quedarse sin nada es la peor forma de enterarse de que no cabe — y pasa, con
  // los modelos grandes es el caso normal, no el raro.
  //
  // Esto NO garantiza que quepa: la cuota anunciada es bastante mayor que lo que
  // de verdad se deja escribir. Descarta el caso claro sin gastar la descarga, y
  // el que se cuela lo caza el mensaje del catch.
  if (total) {
    const est = await navigator.storage.estimate().catch(() => null);
    const libre = est ? (est.quota || 0) - (est.usage || 0) : 0;
    if (est && libre > 0 && total > libre) {
      // El mensaje manda a Ajustes y no «al disco»: lo que ocupa el sitio son
      // casi siempre los modelos que ya se han descargado antes, y eso se vacía
      // con un botón dentro de la app. Mandar a limpiar el disco duro es mandar
      // al sitio equivocado a alguien que tiene la solución a un clic.
      throw new Error(`Este modelo ocupa ${gb(total)} y en el navegador solo quedan ` +
        `${gb(libre)}. Vacía la caché de modelos en Ajustes —ahí se ve cuánto ` +
        `ocupan los que ya has descargado— o elige un modelo más pequeño.`);
    }
  }

  // limpiar restos de un intento previo cortado
  await dir.removeEntry(doneName).catch(() => {});
  await borrarPartes(dir, key);
  const t0 = performance.now();
  let loaded = 0, nPartes = 0, enParte = 0, writable = null;

  const abrirParte = async () => {
    const nombre = `${key}.p${nPartes}`;
    if (porWorker) {
      await porWorker.abrir(nombre);
      writable = porWorker;                                 // misma forma: write/close
    } else {
      const fh = await dir.getFileHandle(nombre, { create: true });
      writable = await fh.createWritable();                 // stream a disco
    }
    nPartes++; enParte = 0;
  };

  try {
    await abrirParte();
    const reader = net.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Un chunk de red no respeta la frontera de parte: se reparte. Sin esto,
      // una parte se pasaría del tope y volvería el error de cuota justo al
      // final de una descarga de gigabytes.
      let off = 0;
      while (off < value.byteLength) {
        if (enParte >= PART) { await writable.close(); await abrirParte(); }
        const cabe = Math.min(PART - enParte, value.byteLength - off);
        await writable.write(exacto(value.subarray(off, off + cabe)));
        off += cabe; enParte += cabe; loaded += cabe;
      }
      onProgress(fmt(loaded, total, t0));
    }
    await writable.close();
    writable = null;
  } catch (e) {
    if (writable) { try { await writable.abort(); } catch { /* — */ } }
    await borrarPartes(dir, key);                           // no dejar basura a medias
    // El mensaje del navegador («exceed its storage quota») no dice ni cuánto
    // entró ni qué hacer, y se le enseña TAL CUAL al usuario. Traducirlo con la
    // cifra real es la diferencia entre «algo ha fallado» y saber qué pasa.
    if (/quota/i.test(String((e && e.message) || e))) {
      const err = new Error(`No cabe: el navegador dejó de admitir datos tras guardar ` +
        `${gb(loaded)} de ${gb(total)}. Su límite real es menor que el espacio que ` +
        `anuncia. Vacía la caché de modelos en Ajustes o elige uno más pequeño.`);
      // Con el nombre del error del navegador (QuotaExceededError…): así quien
      // llama distingue un fallo al GUARDAR de uno de red, y lo dice (litert.js
      // avisa en el progreso). Con un Error a secas se lo tragaba en silencio y
      // el modelo se volvía a bajar entero en cada sesión.
      err.name = e?.name && e.name !== 'Error' ? e.name : 'QuotaExceededError';
      throw err;
    }
    throw e;
  } finally {
    // Soltar el worker SIEMPRE, también al fallar: un worker vivo se queda con
    // el handle del fichero abierto y el siguiente intento no podría truncarlo.
    if (porWorker) { try { porWorker.fin(); } catch { /* — */ } porWorker = null; }
  }

  // ¿Llegó ENTERO? Un stream que se corta a mitad termina sin lanzar: el bucle
  // ve `done` y sale como si hubiera acabado bien. Sin esta comprobación se
  // marcaba como completo lo que se hubiera escrito, y la validación de después
  // pasaba —comprueba que las partes sumen lo APUNTADO, no lo que debía pesar—,
  // así que un modelo truncado quedaba cacheado para siempre: pesos corruptos,
  // sin error, en cada visita. Es el mismo fallo que un rango corto entrando
  // como pesos, un piso más arriba.
  if (total && loaded !== total) {
    await borrarPartes(dir, key);
    throw new Error(`La descarga se cortó: llegaron ${gb(loaded)} de ${gb(total)}. ` +
      `No se guarda a medias porque el modelo no funcionaría. Vuelve a intentarlo.`);
  }

  // marcar completado: el tamaño ESPERADO (no el escrito) y el número de partes,
  // que es lo que hace falta para volver a montarlo y para detectar que el
  // navegador haya truncado algo después.
  const dh = await dir.getFileHandle(doneName, { create: true });
  const dw = await dh.createWritable();
  await dw.write(new TextEncoder().encode(JSON.stringify({ size: loaded, total, parts: nPartes })));
  await dw.close();

  return await abrirPartes(dir, key, { size: loaded, parts: nPartes });
}

// Borra las partes de un modelo (y el fichero único de versiones anteriores).
async function borrarPartes(dir, key) {
  await dir.removeEntry(key).catch(() => {});               // formato antiguo
  const pref = key + '.p';
  try {
    const nombres = [];
    for await (const nombre of dir.keys()) if (nombre.startsWith(pref)) nombres.push(nombre);
    for (const n of nombres) await dir.removeEntry(n).catch(() => {});
  } catch {
    // Sin iteración de directorio: borrar por número hasta que falten dos
    // seguidas (una sola ausencia podría ser un hueco de un borrado a medias).
    let fallos = 0;
    for (let i = 0; i < 512 && fallos < 2; i++) {
      const ok = await dir.removeEntry(`${pref}${i}`).then(() => true, () => false);
      fallos = ok ? 0 : fallos + 1;
    }
  }
}

// Abre un handle de lectura por rangos (para el loader por shards del motor):
// devuelve una función slice(offset, length) → Promise<ArrayBuffer> que lee del
// disco sin cargar el fichero entero. File.slice() es perezoso en disco.
export async function openRanged(url, onProgress = () => {}) {
  const partes = await getModelParts(url, onProgress);
  if (!partes || !partes.length) return null;

  // Índice de comienzos para traducir un offset ABSOLUTO a (parte, offset).
  const inicio = [];
  let size = 0;
  for (const p of partes) { inicio.push(size); size += p.size; }

  const parteDe = abs => {                                   // búsqueda binaria
    let lo = 0, hi = inicio.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (inicio[m] <= abs) lo = m; else hi = m - 1; }
    return lo;
  };

  return {
    size,
    async slice(offset, length) {
      // Math.trunc y no |0: estos ficheros pasan de 2 GiB y el bitwise trunca a
      // 32 bits con signo — un offset de 4 GiB saldría negativo.
      const from = Math.max(0, Math.min(size, Math.trunc(offset) || 0));
      const want = Math.max(0, Math.min(size - from, Math.trunc(length) || 0));
      if (want === 0) return new ArrayBuffer(0);

      // Caso normal: el rango cae entero dentro de una parte y no se copia nada.
      const i0 = parteDe(from);
      const d0 = from - inicio[i0];
      if (d0 + want <= partes[i0].size) {
        return await partes[i0].slice(d0, d0 + want).arrayBuffer();
      }

      // A caballo entre partes. Pasa de verdad: los tensores no se alinean con
      // los 512 MiB, así que uno de cada pocos cruza la frontera.
      const out = new Uint8Array(want);
      let puesto = 0;
      for (let i = i0; i < partes.length && puesto < want; i++) {
        const d = i === i0 ? d0 : 0;
        const trozo = Math.min(partes[i].size - d, want - puesto);
        if (trozo <= 0) continue;
        out.set(new Uint8Array(await partes[i].slice(d, d + trozo).arrayBuffer()), puesto);
        puesto += trozo;
      }
      return puesto === want ? out.buffer : out.buffer.slice(0, puesto);
    },
  };
}

// Borrar un modelo cacheado (para el «liberar espacio» de la UI).
export async function removeModel(url) {
  try {
    const dir = await dirHandle();
    const key = keyFor(url);
    await dir.removeEntry(key + '.done').catch(() => {});
    await borrarPartes(dir, key);
    return true;
  } catch { return false; }
}

// Borra TODOS los modelos guardados en OPFS.
// Existe porque el botón «liberar espacio» de Ajustes solo vaciaba Cache
// Storage: un modelo descargado por este almacén se quedaba ocupando disco sin
// forma de borrarlo desde la interfaz. Y como navigator.storage.estimate() SÍ
// lo cuenta, el usuario veía gigas que el botón no bajaba nunca.
export async function clearAll() {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(DIR, { recursive: true });
    return true;
  } catch { return false; }          // no existe o no hay OPFS: nada que borrar
}

// Bytes ocupados por los modelos en OPFS (aprox, para diagnóstico).
export async function usage() {
  try {
    const est = await navigator.storage.estimate();
    return { usage: est.usage || 0, quota: est.quota || 0 };
  } catch { return { usage: 0, quota: 0 }; }
}

// Tamaños para mensajes de usuario: GB decimales, que es como los cuenta todo
// el mundo fuera de un terminal.
function gb(n) { return (n / 1e9).toFixed(1).replace('.', ',') + ' GB'; }

function fmt(loaded, total, t0) {
  const mb = n => (n / 1048576).toFixed(0);
  const secs = (performance.now() - t0) / 1000;
  const spd = secs > 0 ? (loaded / 1048576 / secs).toFixed(1) : '0';
  // Incluir el % cuando se conoce el total: el escaparate lo extrae para llenar
  // la barra, y el texto queda corto (no envuelve en móvil).
  return total
    ? `Descargando el cerebro · ${mb(loaded)}/${mb(total)} MB · ${Math.round(loaded / total * 100)}%`
    : `Descargando el cerebro · ${mb(loaded)} MB · ${spd} MB/s`;
}
