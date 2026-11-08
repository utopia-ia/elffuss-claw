// Elffuss Runtime · SDK de la caché compartida de modelos.
// ─────────────────────────────────────────────────────────────────────────────
// Embebe un iframe oculto al BROKER (origen compartido de Elffuss) y le pide los
// modelos por postMessage. Como el broker vive en un subdominio de elffuss.com
// —igual que todas las webs de Elffuss (mismo «site»)—, comparte UNA sola OPFS:
// el modelo se descarga UNA vez y se reutiliza en claw/translator/copilot/code…
// Si el broker no está disponible, el llamador cae a su OPFS local (model-store).
// Lo guardado bajo los nombres viejos (*.elffuss.utopiaia.com) es de otro «site»
// y no se ve desde aquí: tras el cambio de dominio el modelo se baja otra vez.
export const BROKER_URL = 'https://models.elffuss.com/';
// La página del broker se pide con la versión que el cliente espera: se servía sin Cache-Control y Safari siguió
// usando una copia de días aunque la del servidor ya era otra (8-nov: la de antes del arreglo de WebKit, que no
// dejaba cargar ningún modelo grande en el iPhone). Una dirección nueva no la contesta ninguna copia vieja. Subirla
// cuando la página cambie algo que el cliente necesita. Las claves (orígenes) no cambian.
export const BROKER_PAGE = '2026-11-08';
const paginaBroker = (u) => { const x = new URL(u); if (!x.searchParams.has('v')) x.searchParams.set('v', BROKER_PAGE); return x.href; };

// Un iframe POR ORIGEN. La maquinaria está, pero OJO con para qué sirve, porque
// medirlo costó una tarde y el resultado no es el que parecía.
//
// MEDIDO con el registro del servidor —no con tiempos, que engañan porque la
// caché HTTP los imita—: se guarda desde un sitio y se lee desde otro, y se
// cuentan las peticiones REALES que llegan a nginx.
//
//   broker models  → 1 petición   · leer desde el otro sitio: CERO
//                                   peticiones nuevas. COMPARTE.
//   broker m1      → 2 peticiones · leer desde el otro sitio se lo vuelve a
//                                   bajar entero. NO comparte.
//
// Mismo sitio (utopiaia.com), mismas cabeceras, misma página de broker. La
// diferencia es real y reproducible; la CAUSA sigue sin explicar. No confundir
// «no explicado» con «no medido»: esto está medido con el testigo bueno.
//
// Consecuencia práctica, y es una disyuntiva de verdad:
//   · compartir entre sitios → un solo origen de broker (models), una sola cuota.
//   · multiplicar la cuota   → repartir entre orígenes, y cada sitio se lo baja.
// Hoy no se pueden las dos. Para modelos por debajo del techo (~7 GB) compensa
// compartir; por encima, repartir y pagar la descarga por sitio.
const _brokers = new Map();          // origen → { iframe, ready }
let _seq = 0;

function ensure(brokerURL) {
  const clave = new URL(brokerURL).origin;
  const ya = _brokers.get(clave);
  if (ya) return ya.ready;
  const entrada = {};
  _brokers.set(clave, entrada);
  return _ensureNuevo(brokerURL, entrada);
}

function _ensureNuevo(brokerURL, entrada) {
  let _iframe = null, _ready = null;
  const _url = brokerURL;
  _iframe = document.createElement('iframe');
  _iframe.src = paginaBroker(brokerURL); _iframe.setAttribute('aria-hidden', 'true');
  _iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;left:-9999px;visibility:hidden';
  _ready = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('broker timeout')), 8000);
    const h = e => { if (e.source === _iframe.contentWindow && e.data?.kind === 'elffuss-broker-ready') { clearTimeout(to); removeEventListener('message', h); resolve(); } };
    addEventListener('message', h);
    _iframe.addEventListener('error', () => { clearTimeout(to); reject(new Error('broker no cargó')); });
  });
  (document.body || document.documentElement).appendChild(_iframe);
  entrada.iframe = _iframe;
  entrada.ready = _ready;
  return _ready;
}
const origin = url => new URL(url).origin;
const ventana = url => _brokers.get(new URL(url).origin)?.iframe?.contentWindow;

// Qué broker guarda un fichero.
// ─────────────────────────────────────────────────────────────────────────────
// El del ORIGEN DEL PROPIO FICHERO cuando ese origen sirve la página del broker
// (models, m1, m2… de elffuss.com, o del dominio anterior mientras dure el
// cambio): así cada trozo lo guarda quien lo sirve, la petición es del mismo
// origen (sin CORS) y ocupa la cuota de ESE subdominio. Cualquier otro fichero
// va al broker compartido.
//
// Antes se usaba el origen del fichero SIEMPRE, y con un modelo de Hugging Face
// eso embebía huggingface.co como si fuera el broker: nadie contestaba, cada
// sesión se comía los 8 s del timeout y después daba el broker por caído.
const HOST_BROKER = /^(models|m\d+)\.elffuss\.(com|utopiaia\.com)$/;
export function brokerFor(url) {
  // Relativa → lanza, como antes: el broker vive en otro origen y la
  // resolvería contra el suyo, que es otro fichero.
  const u = new URL(url);
  return u.protocol === 'https:' && HOST_BROKER.test(u.hostname) ? u.origin + '/' : BROKER_URL;
}

// Modelo como Blob (el navegador lo respalda en disco), desde la caché compartida.
// Descarga una vez para TODO Elffuss; el resto de webs lo leen sin red.
export async function getSharedModel(url, onProgress = () => {}, brokerURL = null) {
  // Por defecto, el broker que le toca a ESE fichero (ver brokerFor).
  brokerURL = brokerURL || brokerFor(url);
  await ensure(brokerURL);
  return new Promise((resolve, reject) => {
    const id = ++_seq;
    // Timeout por INACTIVIDAD: sin CUALQUIER mensaje del broker (progreso/file/
    // error) en IDLE ms, la carga está colgada → rechazar para caer a OPFS local.
    // No es un tope total (una descarga real tarda minutos): cada mensaje del
    // broker reinicia el reloj, así que solo salta si el broker enmudece de verdad.
    const IDLE = 30000;
    let timer;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { removeEventListener('message', h); reject(new Error('broker sin respuesta (timeout de inactividad)')); }, IDLE); };
    const done = fn => (...a) => { clearTimeout(timer); removeEventListener('message', h); fn(...a); };
    const h = e => {
      if (e.source !== ventana(brokerURL) || e.data?.id !== id) return;
      const m = e.data;
      arm();                                    // cualquier señal del broker reinicia el reloj
      if (m.kind === 'progress') onProgress(m);
      // El broker devuelve un File respaldado en disco (structured-clone por
      // referencia): no copia los GB a RAM. Se lee con .stream() al subirlo a GPU.
      else if (m.kind === 'file') done(resolve)(m.file);
      else if (m.kind === 'error') done(reject)(new Error(m.message));
    };
    addEventListener('message', h);
    arm();
    ventana(brokerURL).postMessage({ type: 'elffuss-model-get', id, url }, origin(brokerURL));
  });
}

// ¿ya está en la caché compartida? (para la UI: «cargando desde caché, sin bajar»)
export async function isSharedCached(url, brokerURL = null) {
  brokerURL = brokerURL || brokerFor(url);
  try { await ensure(brokerURL); } catch { return false; }
  return new Promise(resolve => {
    const id = ++_seq; const to = setTimeout(() => { removeEventListener('message', h); resolve(false); }, 4000);
    const h = e => { if (e.source !== ventana(brokerURL) || e.data?.id !== id) return; if (e.data.kind === 'has') { clearTimeout(to); removeEventListener('message', h); resolve(!!e.data.cached); } };
    addEventListener('message', h);
    ventana(brokerURL).postMessage({ type: 'elffuss-model-has', id, url }, origin(brokerURL));
  });
}

// Cuánto ocupa el almacén COMPARTIDO, y cómo vaciarlo.
// ─────────────────────────────────────────────────────────────────────────────
// `navigator.storage.estimate()` mide SOLO el origen que lo llama, y el modelo
// grande no vive aquí: lo guarda el broker, en su propio origen. Así que el
// panel de ajustes contaba los megas del modelo pequeño y se dejaba fuera los
// gigas del grande — decía «0,82 GB cacheados» con 7,2 GB guardados al lado— y
// su botón de vaciar tampoco los tocaba. Esto es el canal que faltaba.

// Lo que ocupa el almacén del broker. Devuelve 0 si no se puede preguntar: la
// cifra se SUMA a la local, y un fallo aquí tiene que quedarse en «no sé contar
// esto», nunca en romper el panel entero.
/**
 * Cuanto ocupa el almacen compartido. Acepta UN broker o VARIOS.
 *
 * Varios porque cada fragmento lo guarda el broker de su propio host: un modelo
 * repartido entre dos servidores ocupa DOS origenes, y preguntar solo al broker
 * por defecto enseñaba una fraccion. Con el 27B guardado en dos hosts, el panel
 * contaba un tercer origen que no tenia nada y mostraba menos de la mitad de lo
 * que habia en disco.
 *
 * Los origenes se deduplican: dos fragmentos del mismo host son un solo
 * almacen, y sumarlo dos veces seria el error contrario.
 */
export async function sharedUsage(brokerURL = BROKER_URL) {
  // Lista VACIA -> al defecto, no a cero. Un cero calculado sobre «no he
  // preguntado a nadie» se lee igual que «no hay nada guardado», y es el error
  // que este arreglo venia a quitar.
  if (Array.isArray(brokerURL) && brokerURL.length === 0) return sharedUsageUno(BROKER_URL);
  if (Array.isArray(brokerURL)) {
    const vistos = new Set();
    const unicos = brokerURL.filter(u => {
      try { const o = new URL(u).origin; if (vistos.has(o)) return false; vistos.add(o); return true; }
      catch { return false; }
    });
    const partes = await Promise.all(unicos.map(u => sharedUsage(u)));
    return {
      usage: partes.reduce((n, p) => n + (p.usage || 0), 0),
      quota: partes.reduce((n, p) => Math.max(n, p.quota || 0), 0),
      ok: partes.some(p => p.ok),
      porOrigen: unicos.map((u, i) => ({ origen: u, ...partes[i] })),
    };
  }
  return sharedUsageUno(brokerURL);
}

async function sharedUsageUno(brokerURL = BROKER_URL) {
  try { await ensure(brokerURL); } catch { return { usage: 0, quota: 0, ok: false }; }
  return new Promise(resolve => {
    const id = ++_seq;
    const to = setTimeout(() => { removeEventListener('message', h); resolve({ usage: 0, quota: 0, ok: false }); }, 5000);
    const h = e => {
      if (e.source !== ventana(brokerURL) || e.data?.id !== id || e.data.kind !== 'diag') return;
      clearTimeout(to); removeEventListener('message', h);
      resolve({ usage: e.data.usado || 0, quota: e.data.quota || 0, ok: true });
    };
    addEventListener('message', h);
    // Sin `probar`: el diagnóstico solo hace la prueba de escritura cuando se le
    // pide un tope, y aquí solo se quiere la cifra.
    ventana(brokerURL).postMessage({ type: 'elffuss-broker-diag', id }, origin(brokerURL));
  });
}

// Vacía el almacén compartido. Devuelve cuánto se liberó DE VERDAD (el broker lo
// mide antes y después), para poder decirlo en vez de suponerlo.
export async function clearShared(brokerURL = BROKER_URL) {
  try { await ensure(brokerURL); } catch { return { liberado: 0, ok: false }; }
  return new Promise(resolve => {
    const id = ++_seq;
    const to = setTimeout(() => { removeEventListener('message', h); resolve({ liberado: 0, ok: false }); }, 20000);
    const h = e => {
      if (e.source !== ventana(brokerURL) || e.data?.id !== id) return;
      if (e.data.kind !== 'cleared' && e.data.kind !== 'error') return;
      clearTimeout(to); removeEventListener('message', h);
      resolve({ liberado: e.data.liberado || 0, ok: e.data.kind === 'cleared' });
    };
    addEventListener('message', h);
    ventana(brokerURL).postMessage({ type: 'elffuss-model-clear', id }, origin(brokerURL));
  });
}
