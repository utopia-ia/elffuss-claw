// Gemma-4 vía LiteRT-LM de Google (early preview, solo WebGPU).
// Patrón copiado de la demo verificada en agentic-install
// (lab/bitacora/posts/08-jspace-live.html).
// DECISIÓN 2026-07-14: cerebro = Gemma BASE (builds oficiales litert-community,
// formato artisan). NO fine-tune propio: `@litert-lm/core` exige empaquetado
// artisan y nuestras conversiones no lo producen (E-010). La agéntica va por el
// system prompt (agent.js), no por pesos.
export let name = 'Gemma · LiteRT-LM';

// Builds .litertlm elegibles. Los «-web» OFICIALES de Google (litert-community)
// están exportados en formato artisan → SÍ cargan en el navegador (son los que
// usaba la demo original). El healed de Elffuss es prefill_decode → hoy no carga
// (E-010), por eso está gateado en el selector.
export const MODELS = {
  'gemma-e2b': { url: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm', label: 'Gemma-4 E2B', tag: '~2 GB · ligero' },
  'gemma-e4b': { url: 'https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm', label: 'Gemma-4 E4B', tag: '~2.8 GB · el mejor' },
  'elffuss-e4b': { url: 'https://huggingface.co/KikoCis/Elffuss-Gemma4-E4B-litert/resolve/main/model.litertlm', label: 'Elffuss E4B (healed)', tag: 'modelo propio' },
};

let MODEL_URL = MODELS['gemma-e2b'].url;
let curLabel = MODELS['gemma-e2b'].label;
let curKey = 'gemma-e2b';
export function configure(key) {
  const m = MODELS[key] || MODELS['gemma-e2b'];
  curKey = MODELS[key] ? key : 'gemma-e2b';
  MODEL_URL = m.url; curLabel = m.label; name = 'Gemma · LiteRT-LM (' + m.label + ')';
}

// Enseñarle solo las herramientas que vienen a cuento (herramientasPara, en
// agent.js) NO SE PUEDE aquí, aunque E4B lo aguante en el banco: la conversación
// de LiteRT fija el prompt de sistema al crearse y chat() solo la recrea si
// cambian sus primeros 200 caracteres, que son la persona. El catálogo del PRIMER
// mensaje se quedaría para toda la conversación: «busca fotos» dejaría solo web
// a la vista, y el «recuérdame…» de después no encontraría tasks. Estuvo así
// unas horas el 2026-09-13; el banco no lo vio porque mide peticiones sueltas.
// Recrear la conversación en cada cambio tiraría la caché KV y el historial.
// false explícito = imposible (ni el interruptor 'on' lo fuerza).
export function enrutaHerramientas() { return false; }

let engine = null, conversation = null, sentCount = 0, sys = '';
// El build que hay en `engine` (configure() solo cambia el que se pedirá), y la
// conversación que está generando ahora mismo, si alguna (ver soltarMotor).
let engineKey = null, generando = null;
// Lo que la conversación de LiteRT ya lleva dentro, en mensajes del historial de
// quien llama: rol y texto de cada uno (ver huellaDe). null = no hay conversación
// de la que fiarse. `respondio`: el modelo ya contestó detrás de eso.
let dentro = null, respondio = false;
// Tras una parada, lo que llevaba la conversación que se tiró (ver
// soltarTrasParada): si la llamada siguiente es esa misma conversación, se
// rehace con eso dentro. null = no hay nada pendiente.
let trasParada = null;
// El último estado vivo (CONTEXTO AHORA) que ya va dentro de la conversación.
// Llega en CADA llamada, y como aquí lo enviado se queda en el KV, mandarlo
// siempre metía un volcado de estado por paso del bucle: contexto gastado en
// copias que el modelo no necesita, y la conversación de verdad se compactaba
// antes. Solo se manda cuando cambia. null = la conversación aún no lleva ninguno.
let estadoDentro = null;

// Muestreo. Por defecto VORAZ, que es como venía: mismo prompt, misma salida.
// Eso hace que generar N veces cueste N y devuelva una sola respuesta distinta,
// así que cualquier técnica de «genera varias y quédate con la mejor» era gasto
// puro. Con temperatura y semilla se puede pedir variedad de verdad.
const TOP_P = 2;
let muestreo = null;                       // null = voraz
export function setSampling(opts) {        // {temperature, seed, p} o null
  const antes = JSON.stringify(muestreo);
  // «k» es OBLIGATORIO aunque el tipo sea TOP_P: sin él el wasm aborta en seco
  // con «Aborted()» y se lleva por delante el motor. Comprobado probando formas.
  muestreo = opts && opts.temperature > 0
    ? { type: TOP_P, k: opts.k ?? 40, p: opts.p ?? 0.95, temperature: opts.temperature, seed: opts.seed ?? 0 }
    : null;
  // cambiar el muestreo exige rehacer la conversación: la sesión ya está creada
  // con los parámetros de antes y no los relee.
  if (JSON.stringify(muestreo) !== antes) { conversation = null; sentCount = 0; dentro = null; }
  return muestreo;
}
export function getSampling() { return muestreo; }
export function __engine() { return engine; }   // solo para el banco de pruebas

// Contexto: probamos de mayor a menor hasta el máximo que acepten el bundle y
// la memoria GPU — así el contexto queda al tope permitido de serie.
const CTX_LADDER = [32768, 16384, 8192, 4096];
export let ctxTokens = 4096; // efectivo tras load() (la UI puede leerlo)

export async function load(onProgress = () => {}) {
  // Ese mismo build ya está cargado: no se crea otro motor. Volver al cerebro
  // que funcionaba tras un cambio fallido (kernel.js) pasa por aquí, y cada
  // llamada creaba un motor nuevo encima del anterior, sin cerrarlo: el modelo
  // dos veces en la GPU, el chat siguiendo en la conversación del primero, y
  // «Liberar el modelo» soltando solo el segundo.
  if (engine && engineKey === curKey) return;
  const clave = curKey, url = MODEL_URL;   // configure() puede cambiarlos mientras se espera
  if (!navigator.gpu) throw new Error('LiteRT-LM necesita WebGPU (Chrome/Edge modernos)');
  // navigator.gpu puede existir como API sin adaptador real (algunos Linux/
  // drivers, entornos sandboxed…) — comprobarlo YA evita bajar 2-4 GB para
  // descubrir el fallo solo al crear el motor, al final de todo.
  let adapter = null;
  try { adapter = await navigator.gpu.requestAdapter(); } catch { /* sin adaptador */ }
  if (!adapter) throw new Error('No hay un adaptador WebGPU real disponible (la API existe pero no hay GPU accesible) — prueba con el modelo ligero, que corre en CPU/wasm.');
  // VERSIÓN FIJADA a propósito. Sin fijarla, la URL apunta siempre a la última
  // publicada: el 2026-08-11 salió 0.16.0, jsdelivr NO consigue construirle el
  // bundle `+esm` (404) y el cerebro Gemma dejó de cargar en producción sin que
  // nosotros tocáramos una línea. Al subir de versión hay que COMPROBAR que
  // `https://cdn.jsdelivr.net/npm/@litert-lm/core@<v>/+esm` responde 200.
  const litertlm = await import('https://cdn.jsdelivr.net/npm/@litert-lm/core@0.15.0/+esm');
  // El .litertlm lo descargamos NOSOTROS (cache-first en Cache Storage) y se lo
  // pasamos a Engine.create como Blob (la API acepta string|Blob|ReadableStream).
  // Motivo: el fetch interno de LiteRT baja el peso con XHR+Range desde un WORKER
  // que el service worker no intercepta → antes se re-descargaba SIEMPRE. Bajándolo
  // aquí queda cacheado de verdad y damos progreso real en MB.
  const model = await cachedModelBlob(url, onProgress);
  onProgress('Preparando el modelo IA en la GPU…');
  // Otro build cargado (E4B → E2B): fuera ANTES de crear el nuevo, que los dos
  // no caben en la GPU. Después de la descarga y no antes: si la descarga falla,
  // el que funcionaba sigue cargado y kernel.js vuelve a él sin recrearlo. Si lo
  // que falla es crear el nuevo, kernel.js vuelve al anterior y lo recrea.
  await soltarMotor();
  let lastErr = null;
  for (const n of CTX_LADDER) {
    try {
      engine = await litertlm.Engine.create({ model, mainExecutorSettings: { maxNumTokens: n } });
      engineKey = clave;
      ctxTokens = n;
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      // Errores de formato/carga no dependen del contexto: no insistir con la escalera.
      if (/not supported|tokenizer|format/i.test(String(e?.message))) throw e;
      onProgress(`Contexto ${n} no cabe, probando ${n / 2}…`);
    }
  }
  if (lastErr) throw lastErr;
}

const MODEL_CACHE = 'elffuss-models-v1';
// Devuelve el .litertlm como Blob desde Cache Storage; si no está, lo descarga
// con progreso real y lo cachea (persistente). Ante cualquier fallo, devuelve la
// URL para que LiteRT lo baje por su cuenta (nunca bloquea la carga del modelo).
export async function cachedModelBlob(url, onProgress = () => {}) {
  // Caché COMPARTIDA + OPFS (runtime propio): un modelo bajado en cualquier web
  // de Elffuss se reutiliza sin re-descargar. Si no está disponible, caemos al
  // Cache Storage de siempre.
  try {
    const { getModelFile } = await import('../runtime/model-store.js');
    const f = await getModelFile(url, onProgress);
    if (f) return f;
  } catch (e) {
    console.warn('[elffuss] OPFS/broker no disponible, uso Cache Storage:', e);
    // Si lo que falló fue GUARDARLO en el disco del navegador (cuota, ventana
    // privada…), se dice, igual que con Cache Storage más abajo: el progreso
    // promete guardarlo, y callado el usuario se re-baja el modelo cada sesión
    // sin saber por qué. Un fallo de red no es esto y no se anuncia así.
    if (/Quota|NoModificationAllowed|InvalidModification|InvalidState|NotAllowed|Security|NotReadable/.test(e?.name || '')) {
      onProgress(`No se pudo guardar el modelo en el disco del navegador (${e.name}): lo intento en la caché; si tampoco ` +
        `se puede, habrá que descargarlo otra vez la próxima. Suele ser ventana privada o falta de espacio.`);
    }
  }

  if (!self.caches) return url;
  try {
    const cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(url);
    if (hit) { onProgress('Cargando el modelo IA desde caché (sin descargar)…'); return await hit.blob(); }
    const net = await fetch(url);
    if (!net.ok || !net.body) return url;
    const total = +net.headers.get('content-length') || 0;
    const t0 = performance.now();
    // Progreso SIN tee(): con un modelo de gigabytes, tee() crea dos ramas que
    // se consumen a ritmos distintos y el navegador tiene que bufferizar la
    // diferencia en memoria → el cache.put acababa reventando y el modelo NO se
    // cacheaba NUNCA (medido con E4B: 2832 MB bajados y cero guardados). Peor
    // aún: al fallar se devolvía la URL suelta y `Engine.create({model: <URL>})`
    // monta un motor que CARGA pero no genera («Aborted()»). Con un
    // TransformStream hay un solo consumidor: contamos al vuelo y el mismo flujo
    // va a la caché.
    let loaded = 0;
    const counted = net.body.pipeThrough(new TransformStream({
      transform(chunk, ctrl) {
        loaded += chunk.byteLength ?? chunk.length;
        onProgress(fmtBytes(loaded, total, t0));
        ctrl.enqueue(chunk);
      },
    }));
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (total) headers['Content-Length'] = String(total);
    // Cachear GIGABYTES puede fallar de verdad: ventana privada (Cache Storage
    // en memoria), disco lleno, cuota del origen. Si falla hay que DECIRLO: el
    // progreso ya ha prometido «se cachea para la próxima vez» y, callándolo,
    // el usuario se re-baja el modelo entero cada sesión sin saber por qué.
    try {
      await cache.put(url, new Response(counted, { headers }));
    } catch (e) {
      onProgress(`No se pudo guardar el modelo en caché (${e.name || 'error'}): habrá que descargarlo otra vez la próxima. ` +
        `Suele ser ventana privada o falta de espacio.`);
      console.warn('[elffuss] modelo NO cacheado:', e);
      return url;
    }
    const cached = await cache.match(url);
    if (!cached) { onProgress('No se pudo guardar el modelo en caché: habrá que descargarlo otra vez la próxima.'); return url; }
    return await cached.blob();
  } catch (e) {
    console.warn('[elffuss] caché de modelo no disponible:', e);
    return url;
  }
}
function fmtBytes(loaded, total, t0) {
  const mb = n => (n / 1048576).toFixed(0);
  const secs = (performance.now() - t0) / 1000;
  const spd = secs > 0 ? (loaded / 1048576 / secs).toFixed(1) : '0';
  return total
    ? `Descargando el modelo IA… ${mb(loaded)}/${mb(total)} MB (${spd} MB/s) · se cachea para la próxima vez`
    : `Descargando el modelo IA… ${mb(loaded)} MB (${spd} MB/s)`;
}

// Liberar el modelo («Liberar el modelo» en Ajustes y el vigilante de RAM).
export async function unload() { await soltarMotor(); }

// Suelta el motor cargado y su conversación. @litert-lm/core 0.15.0 libera el
// motor con delete(): no tiene close(), y el `engine?.close?.()` de antes no
// soltaba nada, así que «Liberar el modelo» y el vigilante de RAM dejaban el
// modelo en la GPU. delete() espera al mutex del ejecutor: lo que esté
// generando se corta primero para no esperar a que termine (chatEnTurno lo ve,
// ver motorDelTurno). close() queda para un motor que solo tenga ese.
async function soltarMotor() {
  const m = engine, c = conversation, g = generando;
  engine = null; engineKey = null; generando = null;
  conversation = null; sentCount = 0; sys = ''; dentro = null; respondio = false; trasParada = null;
  if (g) { try { g.cancel?.(); } catch { /* ya terminó */ } }
  if (c) { try { await c.delete?.(); } catch { /* ya no estaba */ } }
  if (m) { try { await (typeof m.delete === 'function' ? m.delete() : m.close?.()); } catch { /* mejor esfuerzo */ } }
}

// UNA llamada a la vez. Todo lo que habla con el modelo comparte este proveedor
// y su única conversación de LiteRT: el chat, Hard Work y el cerebro CEO, que
// piensa con sus tres perfiles A LA VEZ, cada uno con su historial. Sin turno,
// la llamada de un perfil rehacía la conversación —y borraba la anterior—
// mientras otro aún generaba en ella, y el estado de abajo (qué lleva dentro,
// cuánto se envió) era el de quien hubiera escrito el último. El motor genera de
// una en una de todos modos, así que esperar turno no cuesta nada. Quien se para
// mientras espera sale al momento, y el siguiente sigue esperando al que va
// delante (no a él).
let turno = Promise.resolve();
const hastaQue = (p, signal) => !signal ? p : new Promise(r => {
  const fin = () => { signal.removeEventListener('abort', fin); r(); };
  signal.addEventListener('abort', fin, { once: true });
  p.then(fin, fin);
});

// El 4º argumento es la señal sola o `{ signal, onPrefill }` (ver senalDe). Sin
// normalizarlo, con el objeto de opciones `signal.aborted` no existía y parar no
// paraba: la respuesta seguía hasta el final.
export async function chat(history, system, onToken = () => {}, opciones = null) {
  if (!engine) throw new Error('Modelo no cargado');
  const signal = senalDe(opciones);
  if (signal?.aborted) return '';   // parado antes de empezar: ni se toca la conversación
  const delante = turno;
  let soltar;
  const mio = new Promise(r => { soltar = r; });
  turno = delante.then(() => mio);
  try {
    await hastaQue(delante, signal);
    if (signal?.aborted) return '';   // parado mientras esperaba: no llegó a tocar nada
    return await chatEnTurno(history, system, onToken, signal);
  } finally { soltar(); }
}

async function chatEnTurno(history, system, onToken, signal) {
  if (!engine) throw new Error('Modelo no cargado');   // descargado mientras esperaba turno
  // El motor de este turno: si se suelta a mitad (otro build, o «Liberar el
  // modelo»), el turno no sigue en el motor nuevo ni en ninguno (ver el catch).
  const motorDelTurno = engine;
  // El prompt de sistema ENTERO. Antes se comparaban sus primeros 200
  // caracteres, porque el CONTEXTO AHORA iba al final del sistema y cambiaba en
  // cada turno. Ya no va ahí (viaja como mensaje `efimero`, ver agent.js), y
  // comparar solo la cabeza escondía lo que SÍ cambia al final: las skills.
  // Instalar una a mitad de conversación no llegaba nunca al modelo —seguía con
  // el sistema de antes— y «mejora la interfaz con la skill que acabas de
  // instalar» se contestaba sin ella.
  const sysKey = system;
  // ¿Es ESTA la conversación que LiteRT tiene dentro? Todas las pestañas del
  // chat (y el cerebro CEO, Hard Work, el Lab…) comparten este proveedor, y
  // antes solo se miraba si el historial era más corto que lo ya enviado: el
  // turno de otra pestaña con un historial más LARGO seguía dentro de la
  // conversación de la primera. El modelo veía lo hablado allí (una fuga entre
  // conversaciones) y lo anterior de esta no le llegaba nunca. Ahora se compara
  // el contenido: se sigue solo si el historial empieza por lo que la
  // conversación ya lleva dentro (ver dondeSigue). Un chat nuevo, más corto,
  // tampoco empieza así: tampoco hereda el anterior.
  let desde = conversation && sysKey === sys ? dondeSigue(history) : -1;
  const rehecha = desde < 0;
  if (rehecha) {
    sys = sysKey;
    // Si no, se rehace desde ESTE historial: lo anterior entra en el prefacio,
    // empaquetado como cuando no cabe, y solo se manda lo nuevo (los mensajes de
    // usuario del final). Antes una conversación nueva recibía SOLO los mensajes
    // de usuario de todo el historial, juntos en uno: el modelo perdía todo lo
    // que ya había contestado y hecho.
    //
    // Tras una parada de esta misma conversación (ver soltarTrasParada), lo que
    // había al parar, la pregunta parada incluida, va al prefacio con su propia
    // cabecera; lo que falta de la respuesta parada no está en el historial, así
    // que no entra. Si entre medias habló otra conversación, esto espera a que
    // vuelva la parada.
    const parada = cubre(trasParada, history);
    const trasPararla = parada > 0 && parada < history.length;
    if (trasPararla) trasParada = null;
    const nuevo = inicioDeLoNuevo(history);
    desde = trasPararla ? Math.max(parada, nuevo) : nuevo;
    if (desde > 0) {
      await rehacerCompactada(history, desde, system, history.slice(desde).filter(m => m.role === 'user'),
        trasPararla ? CABECERA_TRAS_PARADA : CABECERA_RETOMADA);
    } else {
      // La que había se borra: cada cambio de conversación dejaba una atrás.
      tirar(conversation);
      conversation = null; dentro = null;
      conversation = await crearConversacion(system);
      dentro = []; respondio = false;
    }
  }
  sentCount = desde;
  if (signal?.aborted) return '';   // parado mientras se preparaba: aún no se ha mandado nada
  // La conversación LiteRT mantiene su propio KV-cache: enviamos solo lo nuevo.
  const fresh = history.slice(sentCount)
    .filter(m => m.role === 'user' && !(m.efimero && m.content === estadoDentro));
  const nuevos = fresh.length ? fresh : [history.at(-1)];
  let text = nuevos.map(m => m.content).join('\n');

  // ¿Cabe? Si no: compactar lo anterior y, si ni así, recortar (ver CONTEXTO).
  // Recién rehecha, lo anterior ya va compactado: hacerlo otra vez daría el
  // mismo prefacio y costaría procesarlo dos veces.
  let antes = await tokensUsados();
  if (antes != null && estimaTokens(text) > ctxTokens - antes - RESERVA_SALIDA) {
    const ocupaba = estimaTokens(text);
    if (sentCount > 0 && !rehecha) { await rehacerCompactada(history, sentCount, system, nuevos); antes = await tokensUsados(); }
    if (signal?.aborted) return '';
    const largo = text.length;
    text = ajustarAlContexto(nuevos, libreEnCaracteres(antes, 0.9));
    console.warn(`[litert] el mensaje nuevo (~${ocupaba} tokens) no cabía en un contexto de ${ctxTokens}: ` +
      `${sentCount > 0 ? 'conversación compactada' : 'conversación vacía'}, mensaje ${text.length < largo ? 'recortado' : 'entero'} ` +
      `· usados ${antes} · se mandan ${text.length} caracteres (${largo} tenía) · ${charsPorToken} caracteres/token`);
  }

  let out = '', enviado = false;
  // Parar también corta el prefill: LiteRT no recibe la señal, y antes solo se
  // miraba al llegar cada trozo, así que un resultado grande (o el prefacio de
  // una conversación rehecha) se procesaba entero mientras el botón decía
  // «Parando…». cancel() es lo mismo que hace LiteRT al cancelar su propio flujo.
  const enviar = async t => {
    if (signal?.aborted) return;   // parado antes de mandar: no se manda
    const corta = () => { try { conversation?.cancel?.(); } catch { /* ya terminó */ } };
    signal?.addEventListener?.('abort', corta, { once: true });
    enviado = true;
    const esta = conversation;
    generando = esta;
    try {
      for await (const chunk of esta.sendMessageStreaming(t)) {
        if (signal?.aborted) break;   // parar: se devuelve lo generado hasta aquí
        for (const item of (chunk.content || [])) {
          if (signal?.aborted) break;   // un trozo puede traer varios textos: ni uno más tras parar
          if (item.type === 'text') { out += item.text; onToken(item.text); }
        }
      }
    } finally {
      if (generando === esta) generando = null;
      signal?.removeEventListener?.('abort', corta);
    }
  };
  try {
    await enviar(text);
  } catch (e) {
    // Parado: lo mismo que si el flujo terminara al parar (cancel() puede
    // acabarlo con un error), se devuelve lo generado y la conversación se tira.
    if (signal?.aborted) { soltarTrasParada(history); return out.trim(); }
    // El motor se soltó a mitad (soltarMotor lo cortó): ni reintento ni nada
    // que tocar, que la conversación ya no existe.
    if (engine !== motorDelTurno) throw new Error('Modelo no cargado');
    // Si falla ANTES de escribir nada, lo normal es que no cupiera (la cuenta de
    // caracteres por token se quedó corta): se rehace compactada, se recorta a la
    // mitad de lo libre y se intenta UNA vez más. Si ya había escrito algo,
    // reintentar lo duplicaría: se deja subir el error.
    if (out) throw e;
    console.warn(`[litert] el envío falló sin respuesta (usados ${antes} · ${text.length} caracteres); ` +
      `rehago la conversación compactada y reintento una vez: ${e?.message || e}`);
    await rehacerCompactada(history, sentCount, system, nuevos);
    antes = await tokensUsados();
    text = ajustarAlContexto(nuevos, libreEnCaracteres(antes, 0.5));
    console.warn(`[litert] reintento: usados ${antes} · se mandan ${text.length} caracteres`);
    enviado = false;   // la conversación rehecha aún no ha recibido nada
    await enviar(text);
  }
  // El motor se soltó mientras generaba y el flujo terminó sin error: lo
  // generado se devuelve, pero no se apunta en un estado que ya es de otro.
  if (engine !== motorDelTurno) return out.trim();
  // Parado a media respuesta: se devuelve lo generado, pero la conversación de
  // LiteRT se TIRA. Ya lleva dentro ese trozo de respuesta, y el agente no lo
  // guarda en su historial (un turno parado no deja respuesta): seguir con ella
  // haría que el turno siguiente heredara una respuesta a medias que el usuario
  // nunca vio terminar. La próxima llamada la rehace desde el historial. Parado
  // antes de mandar nada, la conversación sigue intacta y se conserva.
  if (signal?.aborted) {
    if (enviado) soltarTrasParada(history);
    return out.trim();
  }
  // Se marca como enviado DESPUÉS de enviarlo. Antes se marcaba al principio, y
  // un envío fallido dejaba el mensaje por enviado sin haber llegado nunca.
  sentCount = history.length;
  dentro = huellaDe(history); respondio = true;
  const estado = nuevos.findLast(m => m.efimero);
  if (estado) estadoDentro = estado.content;
  const despues = await tokensUsados();
  if (antes != null && despues != null && despues - antes > 64)
    charsPorToken = Math.min(2, Math.max(1.2, (text.length + out.length) / (despues - antes)));
  return out.trim();
}

// La conversación se tira, y se BORRA: delete() es lo que libera la
// conversación del wasm (y su sesión), y sin él cada parada dejaba una atrás.
// Sin await: delete() espera al mutex del ejecutor, que la generación cancelada
// suelta cuando termina, y este turno no tiene por qué esperarlo.
function soltarTrasParada(history) {
  const vieja = conversation;
  conversation = null; sentCount = 0; dentro = null; respondio = false;
  trasParada = huellaDe(history);
  tirar(vieja);
}
function tirar(c) {
  try { Promise.resolve(c?.delete?.()).catch(() => {}); } catch { /* ya no estaba */ }
}

// ── ¿De qué conversación es este historial? ─────────────────────────────────
// La huella de un historial: rol y texto de cada mensaje. Guardarla no copia
// nada (los textos son inmutables y son los mismos del historial). Se salta el
// estado vivo del IDE («CONTEXTO AHORA», marcado `efimero` en agent.js): va
// justo antes del último mensaje en CADA llamada y en la siguiente ya no está,
// así que no forma parte de la conversación.
const huellaDe = h => h.filter(m => !m.efimero).map(m => [m.role, m.content]);

// Si `h` empieza por `huella`, cuántos mensajes de `h` cubre (contando el
// estado vivo que haya en medio). Si no, -1.
function cubre(huella, h) {
  if (!huella) return -1;
  let i = 0;
  for (const [rol, texto] of huella) {
    while (i < h.length && h[i].efimero) i++;
    if (i >= h.length || h[i].role !== rol || h[i].content !== texto) return -1;
    i++;
  }
  return i;
}

// ¿Este historial es la conversación que LiteRT ya lleva, con algo nuevo
// detrás? Lo nuevo es la respuesta que dio el modelo (si quien llama la apuntó)
// y, después, solo mensajes de usuario. Devuelve dónde empieza lo que hay que
// mandar, o -1 si es otra conversación (o la misma sin nada nuevo). Una
// respuesta de asistente que el modelo no dio aquí (el informe del cerebro CEO,
// la de Hard Work) tampoco la tiene: se rehace para que entre.
function dondeSigue(h) {
  let i = cubre(dentro, h);
  if (i < 0) return -1;
  if (respondio && h[i]?.role === 'assistant') i++;
  if (i >= h.length) return -1;
  for (let j = i; j < h.length; j++) if (h[j].role !== 'user') return -1;
  return i;
}

// Dónde empieza lo que el usuario (o las herramientas) han dicho desde la
// última respuesta: los mensajes de usuario del final. Siempre deja al menos uno.
function inicioDeLoNuevo(h) {
  let i = h.length;
  while (i > 0 && h[i - 1].role === 'user') i--;
  return Math.min(i, Math.max(0, h.length - 1));
}

// El 4º argumento de chat() llega de dos formas y las dos valen, igual que en
// chat() del motor propio: la señal de parar sola, o un objeto de opciones que
// la lleva dentro (`{ signal, onPrefill }`, el que manda el agente cuando pinta
// la espera del motor). Lo que este proveedor no usa, como onPrefill, se ignora.
// La señal se reconoce por la forma y no por la clase, como en el motor: una de
// otro reino (un iframe, un worker) no es `instanceof` de la de esta página.
function senalDe(x) {
  if (!x || typeof x !== 'object') return null;
  if (typeof x.aborted === 'boolean') return x;
  return x.signal && typeof x.signal.aborted === 'boolean' ? x.signal : null;
}

function crearConversacion(system) {
  estadoDentro = null;   // conversación nueva: no lleva ningún estado vivo
  return engine.createConversation({
    preface: { messages: [{ role: 'system', content: system }] },
    // Exprimir el navegador: no persistir los tokens de canal (tool-call/thinking)
    // del modelo en el KV-cache → libera KV → más contexto útil. Y prefill del
    // system prompt al crear la conversación → primera respuesta más rápida.
    filterChannelContentFromKvCache: true,
    prefillPrefaceOnInit: true,
    ...(muestreo ? { sessionConfig: { samplerParams: muestreo } } : {}),
  });
}

// ── CONTEXTO: que un resultado grande no tumbe la conversación ───────────────
// Los proveedores sin estado pasan el historial por acer-core en cada llamada.
// Este no: LiteRT guarda la conversación en su caché KV y aquí solo se le manda
// lo nuevo, así que NADA la empaquetaba. Y lo nuevo puede ser enorme: fs.read
// devuelve hasta 200.000 caracteres, decenas de miles de tokens, con un
// contexto de 4.096 a 32.768. Antes de mandar se mira lo que queda
// (getTokenCount) y, si no cabe:
//   1. se rehace la conversación con lo anterior EMPAQUETADO por acer-core
//      —puntuado con la pregunta de ahora— dentro del prompt de sistema. Va como
//      texto y no como mensajes con rol a propósito: qué roles acepta el
//      preámbulo de Gemma no está documentado, y el texto no depende de eso;
//   2. si ni así cabe, se recortan por el medio los resultados de herramienta
//      del mensaje nuevo (cabeza y cola, que es donde suele estar lo que
//      importa), avisando al modelo de que puede pedir un trozo concreto.
// Si cabe, el mensaje sale exactamente igual que antes.
//
// Los caracteres por token no se saben de antemano (el tokenizador vive dentro
// del wasm): se empieza en 2 y lo medido con getTokenCount solo puede BAJARLO.
// Medido con Gemma E4B: la prosa sale a ~2,8 y un informe cargado de cifras a
// 2,35. Dejando que subiera, el saludo calibraba a 2,81 y el informe de después
// se mandaba contado con esa cifra: 77.112 caracteres que eran ~32.800 tokens, y
// el envío fallaba («Too many tokens requested») hasta el reintento, pagando dos
// veces la espera. Una proporción medida con un contenido no vale para otro, y
// equivocarse por arriba cuesta un fallo; por abajo, solo recortar algo de más.
const RESERVA_SALIDA = 1024;       // tokens que se dejan para que conteste
const FRAC_HISTORIAL = 0.35;       // techo del historial empaquetado al rehacer
let charsPorToken = 2;
const estimaTokens = s => Math.ceil(s.length / charsPorToken);

async function tokensUsados() {
  try { const n = await conversation.getTokenCount(); return Number.isFinite(n) ? n : null; }
  catch { return null; }
}
const libreEnCaracteres = (usados, fraccion) =>
  Math.floor(Math.max(256, ctxTokens - (usados ?? 0) - RESERVA_SALIDA) * charsPorToken * fraccion);

const CABECERA_COMPACTADA = 'CONVERSACIÓN HASTA AHORA (no cabía entera: va lo más relevante para lo que se pide ahora):';
const CABECERA_TRAS_PARADA = 'CONVERSACIÓN HASTA AHORA (la última respuesta se interrumpió; si no cabe entera, va lo más relevante para lo que se pide ahora):';
const CABECERA_RETOMADA = 'CONVERSACIÓN HASTA AHORA (si no cabe entera, va lo más relevante para lo que se pide ahora):';

async function rehacerCompactada(history, hasta, system, nuevos, cabecera = CABECERA_COMPACTADA) {
  let bloque = '';
  const previos = history.slice(0, hasta).map(aligerar);
  if (previos.length) {
    const { packHistoryAsync } = await import('../context.js');
    const { estimateTokens } = await import('../acer-core.js');
    // El presupuesto de acer-core va en SUS tokens estimados, no en los del modelo.
    const caracteres = previos.reduce((a, m) => a + m.content.length, 0) || 1;
    const suyos = previos.reduce((a, m) => a + estimateTokens(m.content), 0);
    const presupuesto = Math.max(100, Math.round(ctxTokens * FRAC_HISTORIAL * charsPorToken * suyos / caracteres));
    // La pregunta de AHORA va al final para que acer-core puntúe con ella; luego se quita.
    const noEsResultado = m => m.role === 'user' && !m.content.startsWith('[resultado');
    const pregunta = ([...nuevos].reverse().find(noEsResultado) || [...history].reverse().find(noEsResultado))?.content || '';
    const empaquetado = (await packHistoryAsync([...previos, { role: 'user', content: pregunta }], presupuesto)).slice(0, -1);
    bloque = '\n\n' + cabecera + '\n' +
      empaquetado.map(m => `${m.role === 'assistant' ? 'Elffuss' : 'Usuario'}: ${m.content}`).join('\n');
  }
  try { await conversation?.delete?.(); } catch { /* ya no estaba */ }
  conversation = null; dentro = null;
  conversation = await crearConversacion(system + bloque);
  dentro = huellaDe(history.slice(0, hasta)); respondio = false;
}

// Una app creada son miles de tokens de HTML en el historial (y en Code, un
// fichero escrito entero), y al compactar competían con la conversación por el
// mismo presupuesto: tres o cuatro de esas y lo que el usuario había dicho (para
// quién, qué le gusta, qué buscó) se quedaba fuera. Para el resumen basta con
// saber QUÉ se hizo; el contenido está en la app o en el fichero.
const PESADO = 1500;
function aligerar(m) {
  const c = m.content;
  if (m.role !== 'assistant' || c.length < PESADO) return m;
  const esApp = /<!doctype html|<html[\s>]/i.test(c);
  const herramienta = c.match(/"tool"\s*:\s*"([\w.]+)"/)?.[1] || c.match(/<function\s+name=["']([\w.\-]+)["']/)?.[1];
  if (!esApp && !herramienta) return m;
  const arg = k => c.match(new RegExp(`"${k}"\\s*:\\s*"([^"]{1,80})"`))?.[1] || c.match(new RegExp(`<param\\s+name=["']${k}["']\\s*>\\s*([^<\\n]{1,80})`))?.[1];
  const titulo = c.match(/<title>([^<]{1,60})<\/title>/i)?.[1];
  const como = (arg('name') || arg('path') || (esApp ? titulo : null) || '').trim();
  // Lo que el modelo dijera FUERA del bloque se conserva.
  const fuera = c.replace(/```[\s\S]*?(```|$)/g, '').replace(/<function[\s\S]*?(<\/function>|$)/g, '')
    .replace(/<!doctype html[\s\S]*$/i, '').trim().slice(0, 400);
  const linea = esApp && (!herramienta || herramienta === 'app.create')
    ? `[creé la app${como ? ` «${como}»` : ''}; su HTML está en la app]`
    : `[llamé a ${herramienta}${como ? ` («${como}»)` : ''}; el contenido largo se omite]`;
  return { ...m, content: linea + (fuera ? '\n' + fuera : '') };
}

function ajustarAlContexto(nuevos, maxCaracteres) {
  const entero = nuevos.map(m => m.content).join('\n');
  if (entero.length <= maxCaracteres) return entero;
  // Un mensaje puede traer VARIOS resultados seguidos (Elffuss Code junta los de
  // un mismo paso): se recorta cada uno por su lado, o el primero se comería el
  // sitio de los demás.
  const mensajes = nuevos.map(m => m.content.split(/\n\n(?=\[resultado )/));
  const esResultado = b => b.startsWith('[resultado');
  const deResultados = mensajes.flat().reduce((a, b) => a + (esResultado(b) ? b.length : 0), 0);
  const hueco = Math.max(0, maxCaracteres - (entero.length - deResultados));
  const t = deResultados
    ? mensajes.map(bs => bs.map(b => (esResultado(b) ? recortarPorElMedio(b, Math.floor(b.length * hueco / deResultados)) : b)).join('\n\n')).join('\n')
    : entero;
  return t.length <= maxCaracteres ? t : recortarPorElMedio(t, maxCaracteres);
}

function recortarPorElMedio(s, max) {
  if (s.length <= max) return s;
  const aviso = `\n… [recortado: ${s.length - max} caracteres no caben en el contexto; si hace falta, pide un fragmento concreto] …\n`;
  const util = Math.max(0, max - aviso.length);
  const cabeza = Math.ceil(util * 0.7);
  return s.slice(0, cabeza) + aviso + s.slice(s.length - (util - cabeza));
}

// Solo para pruebas (tests/litert-contexto.mjs, litert-stop.mjs, chat-opts.mjs):
// probar chat() en node con un motor de mentira. Inerte si la prueba no lo pide
// a propósito (globalThis.__ELFFUSS_PRUEBAS__): en la app de verdad no cambia el
// motor cargado por nada.
export function __usarMotor(motor, contexto) {
  if (!globalThis.__ELFFUSS_PRUEBAS__) throw new Error('__usarMotor es solo para pruebas');
  engine = motor; ctxTokens = contexto; conversation = null; sentCount = 0; sys = ''; charsPorToken = 2;
  dentro = null; respondio = false; trasParada = null; turno = Promise.resolve();
  engineKey = null; generando = null;
}
