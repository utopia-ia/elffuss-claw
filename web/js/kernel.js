// Núcleo: arranca UI, agente, planificador y el proveedor de modelo activo.
import { Agent, parseToolCall } from './agent.js';
import * as ui from './ui.js';
import * as rules from './providers/rules.js';
import * as db from './db.js';
import * as settings from './settings.js';
import * as skills from './skills.js';
import { applyI18n, t, uiLang } from './i18n.js';
import { ensureModelCache } from './model-cache.js';
import { tasks, watch, fs, apps } from './tools/index.js';
import { hardWork, gatherFolder, deepCreate } from './rlm.js';
import * as workspace from './workspace.js';
import * as ceo from './ceo.js';
import * as mindLog from './mind-log.js';
import { ceoWorkspace, CEO_DEFAULT_PROFILES, propuestasGuardadas, carpetaDelAlma } from './ceo-adapter.js';
import * as perms from './permissions.js';
import * as telemetry from './telemetry.js';
import * as gram from './copilot-grammar.js';
import * as rutas from './rutas.js';
import { abrirModal } from './modal.js';

applyI18n(); // traduce el chrome al idioma del navegador antes de nada
telemetry.init('elffuss-claw'); // opt-in, apagado por defecto — ver Ajustes

// Proveedores LOCALES (corren en TU navegador). Los externos (OpenAI,
// Anthropic, Ollama, servidor) son configuración avanzada y se resuelven
// aparte, bajo el id `ext:<nombre>`.
const localProviders = {
  onnx: () => import('./providers/onnx.js'),
  litert: () => import('./providers/litert.js'),
  webllm: () => import('./providers/webllm.js'),
};

// Devuelve el módulo del proveedor ya configurado, o null si es 'rules'.
async function resolveProvider(id) {
  if (id === 'rules') return null;
  if (localProviders[id]) return localProviders[id]();
  if (id.startsWith('litert:')) {           // Gemma vía LiteRT-LM (build elegido)
    const mod = await import('./providers/litert.js');
    mod.configure(id.slice(7));
    return mod;
  }
  if (id.startsWith('webllm:')) {           // WebLLM/MLC: kernels propios, sin ONNX
    const mod = await import('./providers/webllm.js');
    mod.configure(id.slice(7));
    return mod;
  }
  if (id.startsWith('onnx:')) {             // ONNX concreto (Qwen3.5…)
    const mod = await import('./providers/onnx.js');
    mod.configure(id.slice(5));
    return mod;
  }
  if (id.startsWith('engine:')) {           // runtime WebGPU propio (GGUF)
    // El motor no se versiona aquí: llega a web/js/engine/ por rsync, igual que
    // los pesos de web/models/. Si el directorio no está, el import falla y
    // changeModel lo trata como cualquier otro fallo de carga.
    const mod = await import('./engine/provider.js');
    mod.configure(id.slice(7));
    // El velocímetro lo monta changeModel() tras cargar (montarVelocimetro):
    // solo el motor propio mide tok/s (`alMedir`), y con cualquier otro cerebro
    // se monta con null y el chip se esconde.
    return mod;
  }
  if (id.startsWith('ext:')) {
    const cfg = settings.get(id.slice(4));
    if (!cfg) throw new Error('proveedor externo desconocido');
    const mod = await import('./providers/api.js');
    mod.configure(cfg);
    return mod;
  }
  throw new Error('proveedor desconocido: ' + id);
}

// El Elffuss E4B HEALED no carga aún en navegador (export prefill_decode, E-010):
// se oculta hasta el reexport artisan. Los Gemma E2B/E4B OFICIALES (build -web
// de Google) SÍ cargan y se ofrecen como elegibles (no default: se bajan GB solo
// si el usuario los elige). Poner true cuando el healed sea artisan.
const ELFFUSS_LITERT_READY = false;

// navigator.gpu puede EXISTIR como API sin que haya un adaptador real (ciertos
// Linux/drivers, entornos sandboxed/headless…) — comprobarlo UNA vez al
// arrancar evita ofrecer/elegir Gemma (2-4 GB) cuando de todos modos va a
// fallar al crear el motor (onnx.js y litert.js ya comprueban el adaptador
// por su cuenta como defensa adicional, pero esto evita hasta OFRECERLO).
let realGPU = !!navigator.gpu;
const realGPUCheck = (async () => {
  if (!navigator.gpu) return (realGPU = false);
  try { return (realGPU = !!(await navigator.gpu.requestAdapter())); }
  catch { return (realGPU = false); }
})();

// El runtime propio NO se versiona en este repo: llega a web/js/engine/ por el
// rsync del deploy, igual que los pesos. Se SONDEA en vez de cablear un flag que
// haya que acordarse de cambiar — así aparece en el selector solo donde está
// desplegado de verdad, y ofrecerlo nunca es una promesa que falle al elegirlo.
let ENGINE_READY = false;
const engineCheck = (async () => {
  try {
    const r = await fetch('js/engine/provider.js', { method: 'HEAD', cache: 'no-store' });
    return (ENGINE_READY = r.ok);
  } catch { return (ENGINE_READY = false); }
})();

// El 27B se comprueba APARTE del motor, porque son dos cosas independientes: el
// motor llega por rsync y el modelo es un fichero de gigabytes que puede no
// estar alojado. Con el motor puesto y el modelo no, la opción aparecería y
// fallaría al elegirla — y esta cuesta más que ninguna, porque el fallo llega
// después de esperar.
//
// Un HEAD basta y no descarga nada. Si el modelo se muda a otro alojamiento hay
// que cambiar esta ruta también; el precio de tenerla aquí es ese, y a cambio no
// se importa el motor entero en cada carga de página solo para preguntárselo.
// (RETIRADO Y DEVUELTO). Estuvo fuera porque colgaba el ordenador. La causa se
// encontró y se arregló: el motor pedía a la GPU buffers temporales enormes y no
// los soltaba hasta el final del forward, y sus núcleos corrían tanto sin ceder
// que el sistema no llegaba a refrescar la pantalla.
//   · reciclado entre capas → el pico de memoria de GPU bajó unas 16 veces
//   · lotes de 128 → ningún despacho retiene la GPU tanto rato
// Con eso, una carga completa con generación dejó de colgar nada.
//
// Se devuelve al selector porque el fallo tiene causa medida y corregida, no
// porque haya dejado de reproducirse por suerte. Si vuelve a colgar una
// máquina, el sitio correcto para mirar es el pico de memoria de GPU
// (ops.ctx.picoBytes) y la duración de los despachos, no otra vez el modelo.
//
// El síntoma, por si hay que volver a retirarlo: despachos de GPU tan largos que
// el escritorio dejaba de refrescarse y el sistema acababa reiniciándose. Colgarle
// el ordenador a alguien es peor que cualquier respuesta mala. La regla que lo
// evita: los núcleos troceán su trabajo en despachos cortos para que la GPU pueda
// atender al escritorio entre uno y otro.
const RETIRADO_27B_CUELGA_LA_MAQUINA = false;   // arreglado: ver arriba
// Se le pregunta AL MOTOR por sus propios ficheros, en vez de repetir aquí una
// URL. Aquí había cableada la del 27B de un solo trozo; cuando pasó a dos
// fragmentos en dos hosts, esta línea se quedó apuntando al fichero viejo y
// seguía dando 200 de milagro, porque el fichero aún estaba en el servidor. O
// sea: el selector decidía si ofrecer el modelo mirando un fichero que ya no se
// usa. El día que se borre para recuperar disco, la opción desaparece y nadie
// relaciona las dos cosas.
//
// Se importa `registro.js` y no `provider.js` a propósito: el registro son unos
// kilobytes y el proveedor arrastra el motor entero, que no tiene por qué
// bajarse quien nunca lo elija.
let MODEL27_READY = false;
let MODEL27_LABEL = 'Modelo grande';
let MODEL27_GB = 0;
const modelo27Check = (async () => {
  try {
    const reg = await import('./engine/registro.js');
    // El NOMBRE y el TAMAÑO salen del registro del motor, no de un literal aquí.
    // Estaban escritos a mano y se quedaron mintiendo en tres cosas a la vez al
    // cambiar de modelo: decían «Qwen3.8-27B IQ1» y «~7,6 GB» cuando lo que se
    // sirve es el ternario de Prism y son 7,21 GB. Un nombre duplicado es un
    // nombre que se queda viejo.
    const m27 = reg.MODELS && reg.MODELS['qwen38-27b'];
    if (m27) { MODEL27_LABEL = m27.label || MODEL27_LABEL; MODEL27_GB = (m27.bytes || 0) / 1e9; }
    return (MODEL27_READY = await reg.disponible('qwen38-27b'));
  } catch { return (MODEL27_READY = false); }
})();

// Mismo patrón que el 27B: nombre y tamaño salen del REGISTRO del motor, nunca
// de un literal aquí. Un nombre duplicado es un nombre que se queda viejo.
// ⚠️ Con HANDLE, no «fire and forget». La lista del selector se construye tras
// esperar las sondas de disponibilidad, así que una sonda que nadie espera deja
// su bandera en false cuando se pinta la lista y el modelo no aparece — se sirve
// y nadie puede elegirlo, el mismo modo de fallo que escondió a Bonsai. Pasó con
// esta misma sonda: en una app se colaba por carrera y en la otra no aparecía.
let MINICPM_READY = false, MINICPM_LABEL = 'MiniCPM5 2B', MINICPM_GB = 0;
const minicpmCheck = (async () => {
  try {
    const reg = await import('./engine/registro.js');
    const m = reg.MODELS && reg.MODELS['minicpm5-2b'];
    if (m) { MINICPM_LABEL = m.label || MINICPM_LABEL; MINICPM_GB = (m.bytes || 0) / 1e9; }
    MINICPM_READY = await reg.disponible('minicpm5-2b');
    return MINICPM_READY;
  } catch { return (MINICPM_READY = false); }
})();

// LFM3-1.7B, el modelo por defecto del motor propio. Mismo patrón: nombre y
// tamaño del registro, y una sonda CON handle que la lista espera.
let LFM3_READY = false, LFM3_LABEL = 'LFM3 1.7B', LFM3_GB = 0;
const lfm3Check = (async () => {
  try {
    const reg = await import('./engine/registro.js');
    const m = reg.MODELS && reg.MODELS['lfm3-1.7b'];
    if (m) { LFM3_LABEL = m.label || LFM3_LABEL; LFM3_GB = (m.bytes || 0) / 1e9; }
    LFM3_READY = await reg.disponible('lfm3-1.7b');
    return LFM3_READY;
  } catch { return (LFM3_READY = false); }
})();

// Opciones del selector: locales siempre; externos solo si están activados.
function modelOptions() {
  const local = [];
  if (realGPU) local.push({ id: 'litert:gemma-e4b', label: 'Gemma-4 E4B · LiteRT-LM (~2.8 GB)' });
  if (realGPU) local.push({ id: 'litert:gemma-e2b', label: 'Gemma-4 E2B · LiteRT-LM (~2 GB) — más ligero, carga antes' });
  local.push({ id: 'onnx:qwen3.5-0.8b', label: 'Qwen3.5-0.8B · WebGPU (~600 MB) — ligero' });
  // MiniCPM5-2B por WebLLM: OPCIÓN, no predeterminado. Pesa 1,3 GB y MLC pide
  // del orden de 2 GB en la tarjeta — el mismo orden que Gemma E2B, que ya
  // sabemos que NO cabe en
  // móvil. Antes de ponerlo por defecto en ningún sitio hay que cargarlo en un
  // teléfono de verdad.
  // La entrada de MiniCPM5-2B por WebLLM se retira: no arranca. Se queda el
  // comentario porque la alternativa —borrarlo en silencio— hace que alguien
  // vuelva a añadirlo dentro de seis meses y repita la tarde. El mismo modelo
  // SÍ corre por el motor propio (ver más abajo), porque su GGUF declara
  // arquitectura `llama`, que el motor ya lee.
  // Runtime propio: solo se ofrece si el motor está desplegado (llega por rsync,
  // no por git). Ofrecerlo cuando no está sería prometer algo que falla al
  // elegirlo. Ver ENGINE_READY.
  // LFM3 va PRIMERO entre los del motor: es su modelo por defecto. Comprobado
  // contra llama.cpp token a token, y razona (lo pide el registro). La etiqueta
  // no promete más que eso y el tamaño.
  if (realGPU && ENGINE_READY && LFM3_READY) local.push({ id: 'engine:lfm3-1.7b', label: `${LFM3_LABEL} · Elffuss Engine (${LFM3_GB.toFixed(1)} GB, se guarda) — razona` });
  if (realGPU && ENGINE_READY) local.push({ id: 'engine:qwen35-0.8b', label: 'Qwen3.5-0.8B · Elffuss Engine (~800 MB)' });
  // El 27B no está aquí por dudoso: su forward está verificado contra llama.cpp
  // capa a capa y genera texto coherente. Está aquí por lo que CUESTA, y el coste
  // ya está MEDIDO, no supuesto: además de la descarga, leer un prompt largo
  // —persona, herramientas y contexto, que es todo prompt real de Claw— lo deja
  // muy por debajo de cualquier otro cerebro de la lista, y el retraso cae entero
  // ANTES del primer token, que es donde peor se lleva.
  //
  // Se sigue ofreciendo porque verlo correr tiene valor por sí mismo, pero la
  // etiqueta lo dice: quien lo elija para trabajar se va a arrepentir, y eso no
  // puede descubrirse después de bajar los gigas.
  //
  // Ya SÍ se guarda, y costó entender por qué no podía. El navegador corta un
  // fichero suelto sobre los 1,94 GB, y el broker guardaba cada modelo en uno:
  // 3,8 GB fallaban con «exceed its storage quota», que suena a falta de
  // espacio y no lo era. Troceando en partes de 1 GiB entra, y medido con el
  // registro del servidor la segunda carga son CERO peticiones. La etiqueta
  // pasa de «gigas cada vez» a «gigas una vez», que cambia la decisión.
  //
  // Aquí decía «solo conversa», y era cierto mientras el modelo tuvo 512 tokens
  // de contexto: no le cabía el catálogo de herramientas. Ya tiene 2048, que
  // recibe el prompt completo y el catálogo entero: ya no hay versión recortada
  // con él. La afirmación caducó y se quita.
  //
  // NO se sustituye por «puede usar herramientas»: que reciba el catálogo es un
  // hecho del código, pero que un modelo a 1 bit emita un bloque ```tool bien
  // formado no lo ha comprobado nadie. Prometer eso en una etiqueta es
  // exactamente el error que esta etiqueta existe para evitar.
  if (realGPU && ENGINE_READY && MODEL27_READY && !RETIRADO_27B_CUELGA_LA_MAQUINA) local.push({ id: 'engine:qwen38-27b', label: `${MODEL27_LABEL} · Elffuss Engine (${MODEL27_GB.toFixed(1)} GB, se guarda: solo se baja la primera vez) — lento`, group: '⚠ Avanzado' });
  // MiniCPM5-2B por el motor propio. Va en «Avanzado» y sin estrella a
  // propósito: carga y responde con texto limpio, y eso es TODO lo que está
  // comprobado. No se ha medido contra Gemma E4B, que es el predeterminado, así
  // que la etiqueta no promete velocidad ni calidad — prometerlo antes del duelo
  // es el error que la etiqueta del 27B existe para no repetir.
  if (realGPU && ENGINE_READY && MINICPM_READY) local.push({ id: 'engine:minicpm5-2b', label: `${MINICPM_LABEL} · Elffuss Engine (${MINICPM_GB.toFixed(1)} GB, se guarda)`, group: '⚠ Avanzado' });
  if (realGPU && ELFFUSS_LITERT_READY) local.push({ id: 'litert:elffuss-e4b', label: 'Local · Elffuss E4B (healed) ★' });
  local.push({ id: 'rules', label: 'Básico (sin modelo)' });
  // Elffuss LM (LFM2.5-1.2B) estaba aquí en un grupo «sin garantía de
  // rendimiento», avisado con un toast. FUERA: un cerebro que no rastrea no es
  // una opción avanzada, es una trampa — el que lo elige se lleva una mala
  // impresión del producto y el aviso no la evita. El ligero que SÍ se ofrece
  // es Qwen3.5-0.8B, que es el mismo que usa el respaldo de móvil.
  return [...local, ...settings.enabledExternals()];
}

const isLocal = id => id === 'onnx' || id === 'litert' || id === 'webllm' ||
  id.startsWith('webllm:') || id.startsWith('litert:') ||
  id.startsWith('onnx:') || id.startsWith('engine:');
// Por defecto: Gemma-4 grande vía LiteRT-LM (build oficial -web, VERIFICADO que
// carga y hace tool-calls) SOLO en escritorio (E4B). En MÓVIL no: E2B pesa ~1.9 GB
// y el navegador móvil (mata la pestaña por encima de ~1-2 GB de datos vivos) no lo
// sostiene, así que se re-descargaba y fallaba. Móvil → Qwen3.5-0.8B (onnx):
// entra y funciona. E2B/E4B siguen elegibles a mano para quien tenga músculo.
// (El comentario decía «Móvil → Elffuss LM» y el código devolvía otra cosa
// desde hace tiempo: era el comentario el que estaba desactualizado.)
const isMobile = () => matchMedia('(max-width: 820px)').matches || matchMedia('(pointer: coarse)').matches;
// Para la puerta de móvil: un teléfono o tableta de verdad (dedo y sin «hover»,
// o el navegador lo dice), no el ancho de la ventana.
const esTelefono = () => navigator.userAgentData?.mobile === true ||
  (matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches);
async function gpuCapacity() {
  const mem = navigator.deviceMemory || 8;
  if (!navigator.gpu) return { gpu: false, maxBuf: 0, mem };
  try { const a = await navigator.gpu.requestAdapter();
    return a ? { gpu: true, maxBuf: a.limits?.maxBufferSize || 0, mem, f16: !!a.features?.has('shader-f16') } : { gpu: false, maxBuf: 0, mem };
  } catch { return { gpu: false, maxBuf: 0, mem }; }
}
async function pickLocalBrain() {
  const c = await gpuCapacity();
  // LFM3 1.7B (motor propio) es el cerebro por defecto donde el motor está y
  // hay GPU de verdad: lo comprueban ENGINE_READY y LFM3_READY, que el arranque
  // espera antes de llamar aquí. Sus 1,8 GB piden un búfer de 1 GB como el E2B,
  // y el motor no compila sus shaders sin shader-f16.
  if (c.gpu && c.f16 && !isMobile() && realGPU && ENGINE_READY && LFM3_READY && c.maxBuf >= 2 ** 30) return 'engine:lfm3-1.7b';
  if (c.gpu && !isMobile()) {
    if (c.maxBuf >= 2 ** 31 && c.mem >= 8) return 'litert:gemma-e4b';
    if (c.maxBuf >= 2 ** 30 && c.mem >= 6) return 'litert:gemma-e2b';
  }
  // Móvil: aunque el navegador móvil tenga WebGPU, NO cargar Gemma grande
  // —no cabe en su presupuesto de memoria—. Cerebro ligero: Qwen3.5-0.8B.
  return 'onnx:qwen3.5-0.8b';
}
const defaultBrain = () => (!realGPU || isMobile()) ? 'onnx:qwen3.5-0.8b' : 'litert:gemma-e4b';

const agent = new Agent(rules);
let busy = false;

// AVISAR ANTES DE SALIR si hay un turno en marcha. El historial se guarda, pero
// la respuesta a medio generar no: refrescar ahora la tira, y volver a empezar
// obliga a subir el modelo a la GPU y releer la conversación entera.
//
// El navegador ignora cualquier texto propio y enseña el suyo, así que esto solo
// consigue que PREGUNTE — que ya es la diferencia entre perderlo sin enterarte y
// poder decir que no. Y solo salta si hay algo vivo: un aviso que sale siempre
// se aprende a ignorar y deja de avisar.
// `cargandoModelo` va APARTE de `busy`: `busy` es un turno de chat, y lo más
// caro de perder no es eso — es irse a mitad de subir el modelo a la GPU, que
// con el grande son minutos y hay que rehacerlo entero.
let cargandoModelo = false;
export const hayTrabajoVivo = () => busy || cargandoModelo;
addEventListener('beforeunload', (e) => {
  if (!hayTrabajoVivo()) return;
  e.preventDefault();
  e.returnValue = '';
});
let hardMode = false;   // Hard Work (RLM): la próxima petición se procesa por partes
let activeModel = 'rules';   // qué proveedor está cargado (para el vigilante de RAM)
// El modo Básico, a la vista de la hoja de estilos: con él, el botón «Ejecutar
// esta propuesta» (en el chat y en la Mente) se esconde y en su sitio se dice que
// hace falta un modelo, con un botón para elegirlo (ver elffuss.css). Se llama
// cada vez que cambia activeModel.
function marcarModo() { document.body.classList.toggle('modo-basico', activeModel === 'rules'); }
marcarModo();
let activeMod = null;

// ---- cola de mensajes ----
// Los mensajes se apilan y se procesan en orden. La cola persiste en
// IndexedDB: un refresco a media respuesta NO pierde lo pendiente (el mensaje
// en vuelo solo sale de la cola cuando su turno TERMINA; el histórico también
// se guarda al terminar, así que reprocesarlo tras un refresco no duplica).
const queue = [];
let pumping = false;
let bootReady;
const bootPromise = new Promise(r => { bootReady = r; });

// Se guarda {id, text, intentos, hard} y no solo el texto. El contador es lo
// que impide el bucle de cuelgue: si un turno se lleva la pestaña por delante
// —pasa con el modelo grande y poca memoria— al reabrir se reanuda y la vuelve
// a tumbar, y no hay forma de salir ni cerrando, porque el mensaje sigue en la
// cola. El id es lo que distingue un mensaje de otro igual (ver restoreQueue).
// `hard` es la elección de Hard Work, que va CON el mensaje (ver send) también
// tras recargar: guardando solo el texto, un mensaje de Hard Work que esperaba
// detrás de otro turno se procesaba como chat normal al recargar. `propuesta`
// marca una propuesta del cerebro mandada a ejecutar, también tras recargar
// (ver vaciarCola: en Básico no se ejecuta).
// Las colas guardadas por versiones anteriores son de strings sueltos o sin
// id; restoreQueue las sigue aceptando.
const persistQueue = () =>
  db.set('kv', 'queue', queue.map(paraGuardar)).catch(() => {});
const paraGuardar = q => ({ id: q.id, text: q.text, intentos: q.intentos || 0, hard: !!q.hard, propuesta: !!q.propuesta });
// Lo pendiente ahora mismo (el turno en marcha y lo que espera detrás), en el
// formato de la cola guardada.
const pendientesAhora = () => queue.map(paraGuardar);
const MAX_INTENTOS = 2;
const nuevoId = () => (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));

// `hard`: este mensaje va por Hard Work. Se decide al ENVIARLO, no al
// procesarlo: antes el modo era global y una vez encendido se aplicaba a todo lo
// que llegara después —chips, tareas programadas, «Ejecutar propuesta»—.
// Devuelve el mensaje en la cola (quien lo manda puede colgarle `alCancelar`).
// `propuesta`: es una propuesta del cerebro (ver executeProposal).
function send(text, { hard = false, propuesta = false } = {}) {
  const el = ui.addMsg('user queued', text);
  const item = { id: nuevoId(), text, el, hard, propuesta };
  queue.push(item);
  persistQueue();
  if (queue.length > 1) ui.toast(t('queuedAhead', { n: queue.length - 1 }));
  pump();
  return item;
}

// ---- parar (botón ■) ----
// Un AbortController POR TURNO, creado en process(): lo reciben el agente y
// Hard Work, y stopCurrent() lo aborta. Parar vacía también la cola —lo que
// esperaba detrás tampoco se procesa— y la guarda vacía AL MOMENTO: si no, al
// recargar se reanudaría justo lo que acabas de parar. El turno en curso sale
// de la cola por identidad (ver pump), así que lo que envíes después de parar
// no se pierde aunque llegue antes de que el turno termine de soltarse.
// (turnCtl apunta siempre al ÚLTIMO turno; abortar uno ya terminado no hace nada.)
let turnCtl = null;
// Época del histórico: 🧹 la sube, y un turno que empezó en una época anterior
// no guarda el histórico al terminar (ver el botón 🧹).
let epocaHistorial = 0;
let limpiando = false;          // 🧹 en curso: nada vuelve a guardar el histórico
let pumpFin = Promise.resolve();
// La burbuja de «pensando» del turno en marcha (para que diga «Parando…») y
// cuántos mensajes de la cola canceló la parada (para decirlo al terminar).
let burbujaTurno = null, canceladasEnParada = 0;
function stopCurrent() {
  try { turnCtl?.abort(); } catch { /* */ }
  let canceladas = 0;
  for (const it of queue) {
    // Quien lo mandó se entera (el botón de una propuesta vuelve a estar
    // disponible), también si es el turno en marcha, que se para.
    try { it.alCancelar?.(); } catch { /* — */ }
    if (!it.el?.classList.contains('queued')) continue;   // el que ya está en marcha no se tacha
    ui.markCancelled(it.el);
    canceladas++;
  }
  queue.length = 0;
  persistQueue();
  canceladasEnParada += canceladas;
  if (busy) {
    // Hay un turno soltando el modelo: el botón y su burbuja dicen «Parando…»
    // hasta que termine (pump() devuelve el botón a ➤). El aviso llega al final.
    ui.setStopping();
    burbujaTurno?.stopping?.();
    ui.announce(t('stopping'));
  } else if (canceladas) {
    // Nada en marcha (el cerebro aún cargando, o entre dos turnos): solo se
    // cancelaron mensajes de la cola, y ningún turno va a avisar después.
    avisoParado(null);
  }
}

// El aviso de una parada, en UN sitio. Lo que el modelo llegó a escribir —si era
// texto, no una herramienta a medias— se queda en el chat, apagado: antes se iba
// con la burbuja y solo quedaban la petición y «(Parado.)». Pero NO entra en el
// historial del agente (un turno parado no deja respuesta); por eso mismo LiteRT
// tira su conversación al parar, y el modelo no recuerda un texto que no está en
// su historial. Debajo va «(Parado.)» con cuántos mensajes de la cola se
// cancelaron, y lo mismo se anuncia a los lectores de pantalla.
function avisoParado(thinking) {
  const parcial = thinking?.partial?.();
  if (parcial) ui.addMsg('assistant muted partial', parcial);
  const n = canceladasEnParada;
  canceladasEnParada = 0;
  const aviso = n ? t('stoppedQueued', { n }) : t('stopped');
  // Se anuncia una vez: el chat (#log) es una región viva y este aviso entra en
  // él. Escribirlo además en #stop-status lo leía dos veces seguidas.
  ui.addMsg('assistant muted', aviso);
}

// Mientras haya cola o turno, el botón de enviar es ■. El finally garantiza que
// vuelve a ser ➤ aunque un turno reviente: si no, se quedaría en ■ para siempre.
async function pump() {
  if (pumping) return;
  pumping = true;
  ui.setWorking(true);
  let fin; pumpFin = new Promise(r => { fin = r; });
  try { await vaciarCola(); }
  finally { pumping = false; ui.setWorking(false); fin(); }
}

async function vaciarCola() {
  await bootPromise; // no procesar hasta que el cerebro inicial esté resuelto
  while (queue.length) {
    // Un cerebro cargándose (elegido en el selector): el turno siguiente es suyo,
    // no del anterior con la cabecera diciendo «Cargando» (ver changeModel).
    await cargaEnCurso;
    if (!queue.length) break;
    const item = queue[0];
    // El intento se cuenta y se GUARDA antes de procesar: si el turno mata la
    // pestaña, esto es lo único que queda para saber que ya se intentó —
    // guardarlo después no serviría, porque no habría después.
    item.intentos = (item.intentos || 0) + 1;
    await persistQueue();
    // ■ pulsado MIENTRAS se guardaba: stopCurrent() ya vació la cola y tachó
    // este mensaje (aún estaba marcado en cola). No se procesa: process()
    // crearía un controlador nuevo que nadie aborta y la parada se perdería.
    if (queue[0] !== item) continue;
    // Una propuesta del cerebro que llega a su turno en Básico no se ejecuta: se
    // mandó con un modelo cargado, esperó en la cola, y entretanto el cerebro pasó
    // a Básico (elegido a mano, «Liberar el modelo», el vigilante de RAM, o una
    // recarga con Básico guardado). El motor de reglas haría órdenes sueltas de su
    // texto: creaba una app «reloj» de una propuesta que lo mencionaba. El botón
    // solo lo miraba al pulsarlo; aquí se mira al procesarla, como Hard Work.
    if (item.propuesta && activeModel === 'rules') {
      rechazarPropuesta(item);
      const j = queue.indexOf(item);
      if (j >= 0) queue.splice(j, 1);
      await persistQueue();
      continue;
    }
    item.el?.classList.remove('queued');
    if (item.intentos > MAX_INTENTOS) {
      item.el?.remove();
      ui.addMsg('sys', `⚠️ «${String(item.text).slice(0, 60)}…» se quedó a medias dos veces y no lo reintento solo: ` +
        `puede estar agotando la memoria. Vuelve a enviarlo si quieres insistir.`);
      // Por identidad, como al terminar un turno (ver abajo), y no con shift().
      const j = queue.indexOf(item);
      if (j >= 0) queue.splice(j, 1);
      await persistQueue();
      continue;
    }
    ui.setWorking(true);   // ■ «Parar» para este turno, aunque el anterior dijera «Parando…»
    await process(item.text, item.id, item.hard);
    // Orden anti-pérdida: el histórico ya está COMMITEADO dentro de process()
    // (incluye este turno como lastDone). Solo entonces sacamos de la cola.
    // Si el refresco cae entre ambos commits, el mensaje aparece en histórico
    // Y en cola → restoreQueue lo deduplica; nunca se pierde.
    // Por IDENTIDAD y no con shift(): si se paró a mitad, la cola ya se vació
    // y lo que haya ahora delante es un mensaje nuevo, que shift() tiraría.
    const i = queue.indexOf(item);
    if (i >= 0) queue.splice(i, 1);
    await persistQueue();
  }
}

// `id` es el del mensaje en la cola: se apunta como lastDone al terminar.
// `hard`: este mensaje va por Hard Work (se decide al enviarlo, ver send()).
async function process(text, id = null, hard = false) {
  const signal = (turnCtl = new AbortController()).signal;
  const epoca = epocaHistorial;
  if (hard) return processHardWork(text, signal, epoca, id);
  busy = true;
  const thinking = (burbujaTurno = ui.thinkingBubble());
  // Tasa de resolución y tiempo por tarea: se miden AQUÍ, envolviendo la
  // llamada, y no dentro de `agent.handle`. El motor no sabe qué es una tarea
  // —solo ve turnos— y el bucle del agente es delicado, así que la frontera se
  // pone en el único sitio donde una tarea empieza y acaba de verdad.
  //
  // «Resuelta» = el agente terminó sin lanzar Y sin emitir un evento de error.
  // Contar solo las excepciones daría un 100 % permanente: el fallo típico no
  // es una excepción, es una respuesta que llega como `error` al usuario.
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  // Quién contesta este turno: el velocímetro solo apunta las tareas del motor
  // que mide, cada una con su modelo (las del modo Básico o de otro cerebro no
  // son suyas).
  const cerebro = agent.provider;
  let huboError = false, parado = false;
  try {
    await agent.handle(text, ev => {
      if (ev.type === 'prefill') thinking.prefill?.(ev.hechos, ev.total);
      else if (ev.type === 'token') thinking.tick(ev.text);
      if (ev.type === 'text') { ui.addMsg('assistant', ev.text); if (window.__copilotOpener) { try { window.__copilotEmit(ev.text); } catch { /* */ } } }
      if (ev.type === 'tool') { thinking.tool(ev.call.tool); ui.addTool(ev.call); }
      if (ev.type === 'tool_result') ui.addToolResult(ev.tool, ev.result);
      if (ev.type === 'error') { huboError = true; ui.addMsg('assistant err', ev.text); }
      if (ev.type === 'aborted') { parado = true; avisoParado(thinking); }   // parado: aviso, no error
    }, { signal });
  } catch (e) {
    huboError = true;
    throw e;
  } finally {
    // Un turno PARADO no es una tarea resuelta ni fallida: no se apunta.
    // Contarlo como resuelta inflaría la tasa, y su tiempo sería el que tardaste
    // en pulsar ■, no el de la tarea.
    if (!parado) try {
      const vm = await import('./velocimetro.js');
      const ahora = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      vm.tarea({ ok: !huboError, ms: ahora - t0, cerebro });
    } catch { /* sin velocímetro la app funciona igual */ }
    thinking.remove();
    if (burbujaTurno === thinking) burbujaTurno = null;
    // ■ llegó cuando el turno ya acababa por su cuenta: no hubo «parado», pero
    // la cola sí se canceló, y eso se dice.
    if (canceladasEnParada) avisoParado(null);
    busy = false;
    // Histórico persistente COMMITEADO (await) antes de vaciar la cola: al
    // refrescar, la conversación sigue ahí y ningún mensaje se pierde.
    if (epoca === epocaHistorial) {
      await db.set('kv', 'history', agent.history.slice(-80)).catch(() => {});
      await db.set('kv', 'lastDone', { id, text }).catch(() => {});
      workspace.touch('history');
    }
  }
}

// Hard Work (RLM): trabaja la carpeta autorizada ENTERA por partes. El modelo
// no ve todo de golpe — se trocea, se pregunta a cada parte y se funde. Tarda,
// pero abarca material que no cabe en la ventana del modelo.
// `signal` es el del turno: rlm.js lo pasa a cada llamada al modelo y lo mira
// entre trozos y rondas; al parar lanza un AbortError, que aquí es un aviso.
async function processHardWork(question, signal, epoca, id = null) {
  busy = true;
  const thinking = (burbujaTurno = ui.thinkingBubble());
  const fail = msg => { thinking.remove(); ui.addMsg('assistant', msg); busy = false; };
  const siParado = () => { if (signal?.aborted) throw Object.assign(new Error('parado'), { name: 'AbortError' }); };
  try {
    if (activeModel === 'rules') return fail(t('hwNeedsModel'));
    const names = await fs.folders().catch(() => []);
    if (!names.length) {
      // Sin carpeta que leer → modo CREACIÓN: el modelo hace un borrador, se
      // autocritica y se reescribe. Misma petición, dos pasadas → mejor app.
      const res = await deepCreate({
        brief: question, provider: agent.provider, rounds: 1, signal,
        onProgress: p => thinking.tool(
          p.phase === 'draft' ? t('hwPhDraft')
            : p.phase === 'critique' ? t('hwPhCritique', { n: p.round })
            : p.phase === 'rewrite' ? t('hwPhRewrite', { n: p.round })
            : t('hwPhDone')),
      });
      siParado();
      thinking.remove();
      const name = (question.trim().slice(0, 24) || 'app');
      // Se cuenta lo que PASÓ: antes decía siempre «lo trabajé en dos pasadas y
      // lo dejé en el visualizador», aunque guardar la app hubiera fallado (el
      // error se tragaba) o la reescritura no hubiera salido.
      let fallo = '';
      try { await apps.create({ name, html: res.html }); } catch (e) { fallo = e?.message || String(e); }
      const rondas = Math.max(0, (res.trace?.length || 1) - 1);
      const como = rondas ? t('hwRounds', { n: rondas }) : t('hwDraftOnly');
      if (fallo) ui.addMsg('assistant err', t('hwCreateFailed', { err: fallo }));
      else ui.addMsg('assistant', `${t('hwCreated', { como })}\n\n_⛏ Hard Work: ${como}._`);
      agent.history.push({ role: 'user', content: question, ts: Date.now() });
      agent.history.push({ role: 'assistant', content: fallo ? '(Hard Work: no pude guardar la app: ' + fallo + ')' : '(app creada con Hard Work)', ts: Date.now() });
      return; // el finally resetea busy y guarda el histórico
    }
    thinking.tool(t('hwPhOpening'));
    const root = await fs.root();
    const context = await gatherFolder(root, { maxBytes: 1.5e6 });
    siParado();
    if (!context.trim()) return fail(t('hwEmptyFolder'));
    const res = await hardWork({
      question, context, provider: agent.provider, signal,
      onProgress: p => {
        if (p.phase === 'plan') thinking.tool(t('hwPhPlan', { n: p.chunks, k: Math.round(p.chars / 1000) }) + (p.truncated ? t('hwPhPlanTrunc') : ''));
        else if (p.phase === 'map') thinking.tool(t('hwPhMap', { i: p.i, n: p.n }));
        else if (p.phase === 'reduce-group') thinking.tool(t('hwPhMerge', { g: p.g, n: p.n }));
        else if (p.phase === 'reduce') thinking.tool(t('hwPhSynth'));
      },
    });
    siParado();
    thinking.remove();
    ui.addMsg('assistant', res.answer + `\n\n_${t('hwRead', { folder: names[0], n: res.chunks, kept: res.kept })}${res.truncated ? t('hwReadTrunc') : ''}_`);
    agent.history.push({ role: 'user', content: question, ts: Date.now() });
    agent.history.push({ role: 'assistant', content: res.answer, ts: Date.now() });
  } catch (e) {
    thinking.remove();
    // Parar no es un fallo: aviso discreto, como en el chat normal. Tampoco
    // cuando el AbortError no viene de ■ sino del proveedor (el motor propio
    // corta el turno al descargarse): eso no es «Hard Work falló».
    if (signal?.aborted || e?.name === 'AbortError') avisoParado(null);
    else ui.addMsg('assistant err', t('hwFailed', { err: e?.message || String(e) }));
  } finally {
    if (burbujaTurno === thinking) burbujaTurno = null;
    if (canceladasEnParada) avisoParado(null);   // ver process()
    busy = false;
    if (epoca === epocaHistorial) {
      await db.set('kv', 'history', agent.history.slice(-80)).catch(() => {});
      await db.set('kv', 'lastDone', { id, text: question }).catch(() => {});
    }
  }
}

// Recuperar mensajes que quedaron en cola antes de un refresco. Deduplica el
// posible solapamiento con el último turno ya completado (ver pump()).
async function restoreQueue() {
  let pending = await db.get('kv', 'queue').catch(() => null);
  if (!pending?.length) return;
  // Compatibilidad: lo guardado por versiones anteriores son strings sueltos.
  pending = pending.map(x => (typeof x === 'string' ? { text: x, intentos: 0 } : x)).filter(x => typeof x?.text === 'string');
  const lastDone = await db.get('kv', 'lastDone').catch(() => null);
  // ¿El primero ya se procesó? Se reconoce por su id y no por el texto: antes,
  // reenviar lo mismo que acababas de parar —el reintento natural— y recargar a
  // mitad tiraba el reintento sin decir nada, porque su texto coincidía con el
  // del turno parado. Lo guardado por versiones anteriores no lleva id y se
  // sigue comparando por texto.
  const primero = pending[0];
  const hecho = lastDone && primero && (primero.id && lastDone.id
    ? primero.id === lastDone.id
    : primero.text === (typeof lastDone === 'string' ? lastDone : lastDone.text));
  if (hecho) pending = pending.slice(1); // ya se procesó
  if (!pending.length) { db.set('kv', 'queue', []).catch(() => {}); return; }
  for (const it of pending) {
    const el = ui.addMsg('user queued', it.text);
    queue.push({ id: it.id || nuevoId(), text: it.text, intentos: it.intentos || 0, el, hard: !!it.hard, propuesta: !!it.propuesta });
  }
  ui.toast(t('queueRestored', { n: pending.length }));
  pump();
}

// Reconstruir la conversación guardada (burbujas + memoria del agente).
async function restoreHistory() {
  const saved = await db.get('kv', 'history').catch(() => null);
  if (!saved?.length) return;
  agent.history = saved;
  for (const m of saved) {
    if (m.role === 'user') {
      if (m.content.startsWith('[resultado ')) {
        const nl = m.content.indexOf('\n');
        ui.addToolResult(m.content.slice(11, nl > 0 ? nl - 1 : undefined), nl > 0 ? m.content.slice(nl + 1) : '');
      } else if (!m.content.startsWith('[…')) {
        ui.addMsg('user', m.content);
      }
    } else if (m.propuesta) {
      pintarPropuesta(m);          // aviso del cerebro: vuelve con su botón «Ejecutar»
    } else {
      const call = parseToolCall(m.content);
      if (call) ui.addTool(call);
      else ui.addMsg('assistant', m.content);
    }
  }
  // «restaurada» y, al lado, cómo empezar de cero (antes el aviso decía
  // «Conversación restaurada (para empezar de cero)», que se leía al revés).
  ui.toast(t('chatRestored'), { accion: { label: t('newChat'), run: () => nuevaConversacion() } });
}

// PARAR PRIMERO. Un turno en marcha guarda el histórico al terminar: si lo
// hacía DESPUÉS de un borrado, la conversación «borrada» volvía al recargar.
// Subir la época hace que ese turno ya no guarde, y se espera (con tope) a que
// el turno abortado suelte el modelo antes de recargar. Es una época y no una
// bandera porque la recarga puede no llegar a ocurrir (si el navegador
// pregunta antes de salir y le dices que no): los turnos nuevos tienen que
// seguir guardando. `limpiando` (para lo que guarda fuera de un turno, como el
// aviso del cerebro) se suelta solo si la página sigue viva tras recargar.
//
// `boton` es el que se pulsó (🧹) y `aviso`, qué decir mientras el turno suelta
// el modelo. Que se note YA que el clic ha llegado: hasta que el turno soltaba
// el modelo (o vencía el tope) no cambiaba nada —ni el botón, ni un aviso— y la
// conversación seguía a la vista. Sale de la vista al momento: se va a borrar
// igual, y si la recarga no llega a ocurrir, lo que se ve coincide con lo que
// queda guardado. aria-disabled y no disabled, por el foco (ver setStopping).
async function pararParaBorrar({ boton = null, aviso = '' } = {}) {
  epocaHistorial++;
  limpiando = true;
  stopCurrent();
  if (boton) {
    boton.setAttribute('aria-busy', 'true');
    boton.setAttribute('aria-disabled', 'true');
  }
  if (aviso) ui.toast(aviso);       // #toasts es una región viva: se anuncia una vez
  ui.clearLog();
  await Promise.race([pumpFin, new Promise(r => setTimeout(r, 3000))]);
}
// Si el navegador pregunta antes de salir y le dicen que no, la página sigue
// aquí: se suelta `limpiando` y el botón vuelve a estar disponible.
function recargar(boton = null) {
  location.reload();
  setTimeout(() => {
    limpiando = false;
    boton?.removeAttribute('aria-busy');
    boton?.removeAttribute('aria-disabled');
  }, 3000);
}

// Avisos que tienen que verse DESPUÉS de recargar (🧹 y «Borrar todo»).
const AVISO_KEY = 'elffuss.avisoTrasRecargar';
function avisarTrasRecargar(aviso) { try { sessionStorage.setItem(AVISO_KEY, JSON.stringify(aviso)); } catch { /* — */ } }
function avisoPendiente() {
  try { const a = JSON.parse(sessionStorage.getItem(AVISO_KEY) || 'null'); sessionStorage.removeItem(AVISO_KEY); return a; }
  catch { return null; }
}

// 🧹 Nueva conversación. Sin confirmación, pero con «Deshacer»: la conversación
// que se va se guarda aparte (kv/historyBackup) y, tras recargar, un aviso
// ofrece recuperarla. Esa copia vive hasta la siguiente carga de la página.
//
// La copia lleva también lo PENDIENTE (el turno que se paró y lo que esperaba
// en la cola): antes «Deshacer» devolvía solo el histórico y un mensaje en cola
// se perdía para siempre. Se lee antes de parar, porque parar vacía la cola.
// Formato: { history, queue }; una copia antigua era solo el array del histórico.
const leerCopia = x => Array.isArray(x) ? { history: x, queue: [] }
  : x && Array.isArray(x.history) ? { history: x.history, queue: Array.isArray(x.queue) ? x.queue : [] } : null;
async function nuevaConversacion() {
  const boton = document.getElementById('btn-clear');
  if (boton?.getAttribute('aria-busy') === 'true') return;   // ya se está borrando
  const pendientes = pendientesAhora();
  await pararParaBorrar({ boton, aviso: t('clearing') });
  const actual = await db.get('kv', 'history').catch(() => null);
  if (actual?.length || pendientes.length) {
    await db.set('kv', 'historyBackup', { history: actual || [], queue: pendientes }).catch(() => {});
    avisarTrasRecargar({ tipo: 'limpiado' });
  }
  await db.del('kv', 'history').catch(() => {});
  await db.del('kv', 'queue').catch(() => {});
  agent.history = [];
  recargar(boton);
}
// «Deshacer» no tira lo que hayas empezado DESPUÉS de 🧹: antes lo sustituía
// en silencio. Si hay conversación nueva (o algo pendiente), las dos se
// intercambian —la nueva pasa a ser la copia— y el aviso tras recargar permite
// volver a ella.
async function deshacerNuevaConversacion() {
  const copia = leerCopia(await db.get('kv', 'historyBackup').catch(() => null));
  if (!copia || (!copia.history.length && !copia.queue.length)) { ui.toast(t('undoGone')); return; }
  const pendientes = pendientesAhora();
  await pararParaBorrar();
  const nueva = await db.get('kv', 'history').catch(() => null);
  if (nueva?.length || pendientes.length) {
    await db.set('kv', 'historyBackup', { history: nueva || [], queue: pendientes }).catch(() => {});
    avisarTrasRecargar({ tipo: 'intercambiado' });
  } else {
    await db.del('kv', 'historyBackup').catch(() => {});
  }
  if (copia.history.length) await db.set('kv', 'history', copia.history).catch(() => {});
  else await db.del('kv', 'history').catch(() => {});
  if (copia.queue.length) {
    await db.set('kv', 'queue', copia.queue).catch(() => {});
    await db.del('kv', 'lastDone').catch(() => {});   // que restoreQueue no descarte el primero por error
  } else {
    await db.del('kv', 'queue').catch(() => {});
  }
  recargar();
}
document.getElementById('btn-clear').addEventListener('click', () => nuevaConversacion());

// «Borrar todo del navegador» (Ajustes). Lo mismo que 🧹 —parar primero, que
// nada vuelva a escribir— y RECARGAR: lo que vive en memoria (la conversación,
// las skills, la bóveda abierta, la app actual) también se va.
//
// TODO es todo: antes se borraba solo lo del manifiesto (apps, tareas, memoria,
// conversación, skills, bóveda) y sobrevivían las claves de API de los
// proveedores externos, los permisos concedidos, las carpetas autorizadas, sus
// automatizaciones, la misión y los perfiles de la Mente, la carpeta de trabajo
// y el historial del velocímetro. Ahora se vacían todos los almacenes de Claw y
// todas sus claves «elffuss.*». Se quedan, y el aviso lo dice: los modelos
// descargados (tienen su propio botón) y la marca de bienvenida.
const SE_QUEDA = new Set(['elffuss.welcomed']);
async function borrarTodoDelNavegador() {
  try { ceo.disable(); } catch { /* — */ }          // que el cerebro no vuelva a escribir
  for (const s of db.ALMACENES) await db.clear(s).catch(() => {});
  const fuera = almacen => {
    try {
      for (const k of Object.keys(almacen)) if (k.startsWith('elffuss.') && !SE_QUEDA.has(k)) almacen.removeItem(k);
    } catch { /* sin almacenamiento */ }
  };
  fuera(localStorage);
  fuera(sessionStorage);
}
ui.setOnWipe(async () => {
  await pararParaBorrar();
  await workspace.wipe({ confirm: 'BORRAR' });
  await workspace.forget().catch(() => {});
  await borrarTodoDelNavegador();
  mindLog.olvidar();
  agent.history = [];
  avisarTrasRecargar({ tipo: 'borrado' });
  recargar();
});

// El velocímetro (⚡ tok/s) solo tiene algo que decir con el motor propio, que
// es quien mide (`alMedir`). Con cualquier otro cerebro se monta con null y el
// chip se esconde: antes se quedaba con la última cifra del motor a la vista.
function montarVelocimetro(mod) {
  import('./velocimetro.js').then(vm => { vm.usarTraductor?.(t); vm.montar(mod?.alMedir ? mod : null); })
    .catch(() => { /* sin velocímetro la app funciona igual */ });
}
// Sus textos van en el idioma de la página desde el principio (el módulo lo
// comparte Code, que pone su propio traductor).
import('./velocimetro.js').then(vm => vm.usarTraductor?.(t)).catch(() => { /* — */ });

// Ficha pública de cada cerebro local (ⓘ junto al selector). Sin ficha pública
// —el 27B— no hay ⓘ: nunca se enlazan los ficheros de pesos.
const FICHAS = {
  'litert:gemma-e4b': 'https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm',
  'litert:gemma-e2b': 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm',
  'onnx:qwen3.5-0.8b': 'https://huggingface.co/onnx-community/Qwen3.5-0.8B-ONNX',
  'webllm:minicpm5-2b': 'https://huggingface.co/fatih-can/MiniCPM5-2B-MLC',
  'engine:qwen35-0.8b': 'https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF',
  'engine:lfm3-1.7b': 'https://huggingface.co/LiquidAI/LFM3-1.7B',
};
const etiquetaDe = id => modelOptions().find(o => o.id === id)?.label?.split(' · ')[0] || id;
// Cuánto baja un cerebro local, sacado de su etiqueta en el selector («(~2.8 GB)»,
// «(7.2 GB, se guarda…)»); si no lo dice, lo del ligero.
const tamanoDeDescarga = id => (modelOptions().find(o => o.id === id)?.label?.match(/\((~?[\d.,]+\s*[MG]B)/) || [])[1] || '~600 MB';
function pintarFicha(id) { ui.setFichaModelo(FICHAS[id] || null, etiquetaDe(id)); }

// Errores de carga que se enseñan al usuario: los de providers/api.js (core
// compartido, sin i18n) llegan en español; los conocidos se traducen aquí.
const ERRORES_CARGA = { 'falta la clave de API (config avanzada)': 'errApiKeyMissing', 'proveedor sin configurar': 'errProviderUnset' };
const errorLegible = e => { const m = e?.message || String(e); return ERRORES_CARGA[m] ? t(ERRORES_CARGA[m]) : m; };

// Cambiar de cerebro con un turno en marcha: ese turno se PARA primero, y se
// dice. Antes la cabecera pasaba a «Básico» (o a «Cargando») al momento mientras
// el cerebro anterior seguía escribiendo la respuesta, y un paso más de ese
// turno iría ya con el nuevo. Lo que espera en la cola no se cancela: lo
// contesta el cerebro nuevo, porque la cola espera a que termine de cargar
// (cargaEnCurso, ver vaciarCola) antes de empezar el turno siguiente.
let cargaEnCurso = Promise.resolve();
function pararTurnoPorCambio() {
  if (!busy) return;
  try { turnCtl?.abort(); } catch { /* — */ }
  ui.setStopping();
  burbujaTurno?.stopping?.();
  ui.toast(t('stoppedForModel'));
}
// `volviendo`: es la vuelta al cerebro que funcionaba tras un fallo (no se
// intenta volver otra vez si también falla), dentro de un cambio ya en marcha.
// `elegido`: lo eligió el usuario en el selector. Solo eso se recuerda para el
// próximo arranque (ELEGIDO). Antes se recordaba cualquier carga, también el
// respaldo ligero cuando Gemma no cabía, y desde ese día el arranque cargaba
// Qwen3.5-0.8B para siempre aunque nadie lo hubiera escogido.
const ELEGIDO = 'elffuss.model.elegido';
function changeModel(id, opciones = {}) {
  if (opciones.volviendo) return cambiarModelo(id, opciones);
  pararTurnoPorCambio();
  const carga = cambiarModelo(id, opciones);
  cargaEnCurso = carga.then(() => {}, () => {});
  return carga;
}
async function cambiarModelo(id, { volviendo = false, elegido = false } = {}) {
  const previo = activeModel;         // el que estaba funcionando
  if (id === 'rules') { // modo básico
    agent.setProvider(rules);
    activeModel = 'rules';
    marcarModo();
    activeMod = null;
    montarVelocimetro(null);
    pintarFicha(null);
    ui.modelStatus('off');
    localStorage.setItem('elffuss.model', 'rules');
    if (elegido) localStorage.setItem(ELEGIDO, 'rules');
    ui.setModel('rules');
    ui.toast(t('basicModeOn'));
    return true;
  }
  ui.modelStatus('loading');
  // Qué cerebro se está cargando, a la vista de las pruebas (tests/cerebro-por-defecto.mjs):
  // los pesos del motor pueden llegar por el almacén compartido o el service
  // worker, donde la prueba no ve la petición.
  document.documentElement.dataset.cargando = id;
  // `finally` y no un reset al final del try: si la carga falla —que pasa, de
  // ahí el camino de respaldo de abajo— el flag se quedaría puesto y la web
  // avisaría al salir para siempre, hasta que el usuario aprendiera a ignorar
  // el aviso. Un aviso que miente es peor que no tenerlo.
  cargandoModelo = true;
  ui.modeloCargando(true);            // sin cargas en paralelo: el selector espera
  try {
    const mod = await resolveProvider(id);
    ui.modelProgress(t('modelPreparing'));
    await mod.load(p => ui.modelProgress(p));
    ui.modelProgress(null);
    agent.setProvider(mod);
    activeModel = id;
    marcarModo();
    activeMod = mod;
    montarVelocimetro(mod);
    pintarFicha(id);
    localStorage.setItem('elffuss.model', id);
    if (elegido) localStorage.setItem(ELEGIDO, id);
    ui.setModel(id);
    if (isLocal(id)) ui.contarCompartido();   // sus pesos pueden estar en el almacén compartido
    const where = isLocal(id) ? (realGPU ? t('whereGpu') : t('whereCpu')) : t('whereExt');
    ui.modelStatus(isLocal(id) && realGPU ? 'gpu' : 'on');
    ui.toast(t('modelReady', { where }));
    if (window.__copilotOpener) copilotPostState(t('copilotReady'));
    return true;
  } catch (e) {
    ui.modelProgress(null);
    console.error('[elffuss] fallo cargando modelo', e);
    // Un Gemma (LiteRT) que no cabe no se reintenta solo en esta sesión: el
    // arranque elegiría el ligero en su lugar (ver skipGemma).
    if (id.startsWith('litert')) { try { sessionStorage.setItem('elffuss.skipGemma', '1'); } catch { /* — */ } }
    // Si había un cerebro funcionando, se VUELVE a él en vez de caer a Básico
    // (antes, probar un modelo que no cargaba te dejaba sin el que tenías). Se
    // vuelve a cargar porque el intento fallido puede haber reconfigurado su
    // módulo (los proveedores externos comparten api.js).
    // Va ANTES que el respaldo ligero de Gemma: probar un Gemma con otro cerebro
    // funcionando te dejaba en Qwen3.5-0.8B (otra descarga de ~600 MB) en vez de
    // en el que tenías.
    if (!volviendo && previo && previo !== 'rules' && previo !== id) {
      ui.toast(t('modelFailedBack', { id: etiquetaDe(id), err: errorLegible(e), prev: etiquetaDe(previo) }));
      await changeModel(previo, { volviendo: true });
      return false;
    }
    // Sin otro cerebro (el arranque, o venías de Básico): si un Gemma no cabe o
    // falla, cae al ligero en vez de dejarte sin cerebro.
    if (id.startsWith('litert') && !_fellBack) {
      _fellBack = true;
      ui.toast(t('gemmaFallback'));
      const ok = await changeModel('onnx:qwen3.5-0.8b', { volviendo: true });
      _fellBack = false;
      if (ok) return true;
    }
    ui.modelStatus('off');
    agent.setProvider(rules);
    activeModel = 'rules';
    marcarModo();
    montarVelocimetro(null);
    pintarFicha(null);
    ui.setModel('rules');
    ui.toast(t('modelFailed', { id: etiquetaDe(id), err: errorLegible(e) }));
    return false;
  } finally {
    // Pase lo que pase —éxito, fallo, o el respaldo que vuelve a entrar aquí—
    // la carga ha dejado de estar en curso.
    cargandoModelo = false;
    ui.modeloCargando(false);
  }
}
let _fellBack = false;

// Rehacer el selector (locales + externos activados) tras tocar la config.
function refreshModelOptions() {
  ui.rebuildModelSelect(modelOptions(), activeModel);
}

// Splash de primera visita: galaxia WebGL + promesa de privacidad + guiño.
// Es una capa MODAL (role=dialog, lo de detrás inerte, el foco en «Entrar»):
// antes el primer Tab caía en el selector de modelo de detrás, «Entrar» no se
// alcanzaba en 12 Tab y al cerrar el foco se perdía en <body>. Al entrar, el
// foco va a la caja de texto.
const splash = document.getElementById('splash');
let bienvenido = false;
try { bienvenido = !!localStorage.getItem('elffuss.welcomed'); } catch { /* sin almacenamiento: se enseña */ }
if (!bienvenido) {
  splash.hidden = false;
  splash.setAttribute('role', 'dialog');
  splash.setAttribute('aria-modal', 'true');
  splash.setAttribute('aria-labelledby', 'splash-t');
  const cerrarModal = abrirModal(splash, { foco: '#splash-enter' });
  let galaxy = null;
  import('./splash-gl.js')
    .then(m => { galaxy = m.startGalaxy(splash); })
    .catch(() => {}); // sin WebGL queda el gradiente CSS
  let dentro = false;
  const entrar = () => {
    if (dentro) return;
    dentro = true;
    try { localStorage.setItem('elffuss.welcomed', '1'); } catch { /* — */ }
    galaxy?.burst(); // las estrellas salen despedidas al entrar
    splash.style.opacity = '0';
    splash.removeAttribute('aria-modal');   // ya no es modal: se desvanece y se va
    cerrarModal({ devolverFoco: false });
    document.getElementById('prompt')?.focus();
    setTimeout(() => { splash.hidden = true; galaxy?.stop(); }, 800);
  };
  document.getElementById('splash-enter').addEventListener('click', entrar);
  splash.addEventListener('keydown', e => { if (e.key === 'Escape') entrar(); });
}

skills.usarTraductor(t);   // los textos de skills.js (compartido con Code) en el idioma de la página
skills.initSkills();
// «Autoriza una carpeta» (el chip y /carpeta): el selector nativo se abre AQUÍ,
// en el clic. Mandándoselo al modelo se abría al final de su turno, cuando el
// navegador ya no lo permitía (pide un gesto reciente del usuario).
async function autorizarCarpeta() {
  try {
    const r = await fs.pickFolder();
    ui.addMsg('assistant', r);
    agent.history.push({ role: 'user', content: t('pFolder'), ts: Date.now() }, { role: 'assistant', content: r, ts: Date.now() });
    db.set('kv', 'history', agent.history.slice(-80)).catch(() => {});
  } catch (e) {
    if (e?.name !== 'AbortError') ui.toast('⚠️ ' + (e?.message || e));   // cancelar el selector no es un error
  }
}
// Lo que escribes en la caja: si Hard Work está puesto, ESE mensaje va por Hard
// Work y el modo se apaga (es para un mensaje).
function enviarDesdeLaCaja(text, { desdeCaja = false } = {}) {
  const hard = desdeCaja && hardMode;
  if (hard) apagarHardWork();
  send(text, { hard });
}
ui.init({ onSend: enviarDesdeLaCaja, onStop: stopCurrent, onModelChange: id => changeModel(id, { elegido: true }), onSettingsChanged: refreshModelOptions, onPickFolder: autorizarCarpeta });
ui.mountDiskChip();   // cuánto ocupan los modelos en este navegador, y cómo vaciarlo
// Botón «liberar el modelo» del panel de consumo: suelta la RAM sin recargar.
ui.setOnFreeModel(async () => {
  const mod = activeMod;
  agent.setProvider(rules); activeModel = 'rules'; activeMod = null;
  marcarModo();
  montarVelocimetro(null);
  ui.setModel('rules'); ui.modelStatus('off');
  try { await mod?.unload?.(); } catch { /* mejor esfuerzo */ }
});
refreshModelOptions();
const avisoAlCargar = avisoPendiente();
restoreHistory().then(restoreQueue).then(() => {
  if (avisoAlCargar?.tipo === 'limpiado') {
    ui.toast(t('chatCleared'), { accion: { label: t('undo'), run: deshacerNuevaConversacion } });
  } else if (avisoAlCargar?.tipo === 'intercambiado') {
    // «Deshacer» con una conversación nueva ya empezada: esa queda guardada.
    ui.toast(t('chatSwapped'), { accion: { label: t('undo'), run: deshacerNuevaConversacion } });
  } else {
    // Sin el aviso, ya no hay nada que deshacer: la copia se va.
    db.del('kv', 'historyBackup').catch(() => {});
    if (avisoAlCargar?.tipo === 'borrado') ui.toast(t('wsWiped'));
  }
});

// Direcciones (#/apps/reloj, #/tareas/t1…, ver rutas.js): las que lleguen con
// «Atrás», un enlace o a mano. Ir a otra sección con la Mente abierta la cierra
// («Atrás» desde #/mente/… se quedaba con la Mente tapando la página). La
// dirección con la que se ABRE la página se sigue al final de este módulo.
ui.setOnMente(detalle => abrirMente(detalle));
rutas.alCambiar(r => {
  if (r.seccion !== 'mente' && mente?.isOpen()) mente.closeMind();
  ui.navegar(r);
});

// ── Cerebro CEO autónomo + Mente de Elffuss ───────────────────────────────
// Cuando NO le pides nada, Elffuss trabaja por su cuenta: revisa tus carpetas
// autorizadas, tareas, apps y memoria, y propone mejoras (sin tocar nada por
// su cuenta — la propuesta se ejecuta con el mismo camino real que el chat).
//
// La Mente (mind.js) arrastra three.js desde un CDN: se carga al ABRIRLA, no con
// cada visita (antes cada carga de página contactaba jsdelivr, y sin red ni
// arrancaba la app). Mientras no está, el historial lo lleva mind-log.js.
let mente = null, menteCargando = null;
function cargarMente() {
  return (menteCargando ||= import('./mind.js').then(m => {
    m.init({
      // sin ciudad de fondo (Claw v1): la Mente funciona igual sin ella. Lo que
      // sí carga son las propuestas ya guardadas, para que sobrevivan a recargar.
      loadThoughts: () => propuestasGuardadas(ceo.getSoulDir()),
      etiquetaAlma: async () => {
        const f = await carpetaDelAlma();
        return f ? t('mindSoulIn', { folder: f }) : t('mindSoulNoFolder');
      },
      // Sin el permiso «Archivos» el cerebro no trabaja (no lo pide: ver
      // ceo-adapter.js), y «Pensar ahora» lo dice en vez de «no puedo».
      motivoNoPensar: async () => (activeModel === 'rules' ? t('mindNeedsModel')
        : !(await carpetaDelAlma()) ? t('mindNeedsFolder')
        : !perms.has('fs') ? t('mindNeedsFsPerm') : null),
    });
    // Claw no tiene editor: «Ver el fichero» cierra la Mente y lo lee en el chat
    // (antes mandaba «Muéstrame el contenido de…» al modelo, que contestaba
    // detrás de la Mente abierta, y en Básico con el texto de ayuda).
    m.setOpenFile(verFicheroDeLaMente, { etiqueta: t('mindViewFile') });
    // «▶ Ejecutar esta propuesta» de la Mente pasa por la MISMA puerta que el
    // botón del chat: en Básico no ejecuta (ver executeProposal) y la Mente sigue
    // abierta, con el aviso encima.
    m.setElegirModelo(() => { m.closeMind(); ui.enfocarSelectorModelo(); });
    m.setExecuteProposal(md => {
      if (!executeProposal(md)) return false;
      m.closeMind();
      return true;
    });
    // Cerrar la Mente devuelve la URL a la pestaña de debajo: antes se quedaba
    // #/mente/<ruta>, y volver a pulsar el mismo enlace no era un cambio de
    // dirección (no abría nada) y cada recarga reabría la Mente.
    m.alCerrar(() => {
      if (rutas.leer()?.seccion !== 'mente') return;
      rutas.reflejar(document.querySelector('#tabs button.active')?.dataset.tab || 'vista');
    });
    return (mente = m);
  }).catch(e => { menteCargando = null; throw e; }));
}
// #/mente, #/mente/<ruta de la propuesta>, el botón 🧠 y las notificaciones.
async function abrirMente(ruta = null) {
  try {
    const m = await cargarMente();
    await m.openMind();
    if (ruta && !m.mostrarPropuesta(ruta)) ui.toast(t('mindNoProposal'));
  } catch (e) { ui.toast(t('mindLoadFail', { err: e?.message || String(e) })); }
}
async function verFicheroDeLaMente(path) {
  mente?.closeMind();
  ui.mostrarChat();
  try {
    const texto = await fs.read({ path });
    ui.addMsg('assistant', `📄 \`${path}\`\n\n${texto}`);
  } catch (e) { ui.toast('⚠️ ' + (e?.message || e)); }
}
const WEAK_RE = /^(no (encontr|hay|se me ocurre)|nada que|sin cambios|todo (está|esta) bien|no aplica)/i;
function isNoteworthy(ev) {
  const solid = (ev.proposals || []).filter(p => p.text && p.text.trim().length >= 60 && !WEAK_RE.test(p.text.trim()));
  return solid.length >= 2; // al menos 2 líneas de pensamiento con algo sustancioso
}
// Ejecutar una propuesta: el botón del aviso en el chat y «▶ Ejecutar» de la
// Mente. En Básico NO: el motor de reglas troceaba el markdown en órdenes sueltas
// y ejecutaba lo que encontrara (creaba una app «reloj» de una propuesta que lo
// mencionaba). Antes solo el botón del chat lo comprobaba. Devuelve el mensaje en
// la cola, o false si no la mandó.
function executeProposal(md) {
  if (activeModel === 'rules') {
    avisoPropuestaSinModelo();
    return false;
  }
  return send('Implementa esta propuesta de mejora usando las herramientas disponibles:\n\n' + md, { propuesta: true });
}
function avisoPropuestaSinModelo() {
  ui.toast(t('proposalNeedsModel'), { accion: { label: t('pickModel'), run: () => { mente?.closeMind(); ui.enfocarSelectorModelo(); } } });
}
// La propuesta que esperaba en la cola y llega en Básico (ver vaciarCola): su
// mensaje queda tachado, el botón que la mandó vuelve, y se dice por qué.
function rechazarPropuesta(item) {
  ui.markCancelled(item.el);
  try { item.alCancelar?.(); } catch { /* — */ }
  avisoPropuestaSinModelo();
}
// SOLO notifica si el permiso YA está concedido — nunca lo pide aquí; pedirlo
// vive en el «Activar» del panel ⚙ de la Mente (antes también en el clic 🧠,
// que lo pedía nada más abrirla).
function notify(title, body, path) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon: 'img/elffuss.svg' });
    // Pulsarla te trae a Claw y a la propuesta (antes no hacía nada).
    n.onclick = () => { try { window.focus(); } catch { /* — */ } n.close(); abrirMente(path || null); };
  } catch { /* */ }
}
// El aviso en el chat se GUARDA en el historial con su propuesta: antes, tras
// recargar, desaparecían el mensaje y su botón «Ejecutar».
function reportImprovements(ev) {
  const props = ev.proposals || [];
  if (!props.length) return;
  const firstLine = x => (x || '').split('\n').find(l => l.trim())?.trim().slice(0, 160) || '';
  const n = props.length;
  const body = `💡 **${t(n === 1 ? 'proposalsFound1' : 'proposalsFoundN', { n })}**\n\n` +
    props.map(p => `**${p.dept}** — ${firstLine(p.text)}`).join('\n\n') +
    (ev.path ? `\n\n_${t('proposalSaved', { path: ev.path })}_ [${t('proposalSeeMind')}](${rutas.href('mente', ev.path)})` : '');
  const entrada = { role: 'assistant', content: body, ts: Date.now(), propuesta: { md: ev.md || body, path: ev.path || null } };
  agent.history.push(entrada);
  if (!limpiando) db.set('kv', 'history', agent.history.slice(-80)).catch(() => {});
  pintarPropuesta(entrada);
  if (isNoteworthy(ev)) notify(t(n === 1 ? 'proposalNotif1' : 'proposalNotifN', { n }), props.map(p => p.dept).join(' · '), ev.path);
}
function pintarPropuesta(m) {
  const div = ui.addMsg('assistant', m.content);
  if (!div || !m.propuesta?.md) return;
  // En Básico no hay con qué ejecutarla: en vez de un botón que solo explica
  // al pulsarlo, se dice ya y se ofrece elegir modelo (marcarModo y el CSS
  // eligen cuál de los dos se ve).
  const pista = document.createElement('div');
  pista.className = 'proposal-needs-model';
  const elegir = document.createElement('button');
  elegir.type = 'button';
  elegir.textContent = t('pickModel');
  elegir.onclick = () => ui.enfocarSelectorModelo();
  pista.append(document.createTextNode(t('proposalNeedsModelShort') + ' '), elegir);
  div.appendChild(pista);
  const btn = document.createElement('button');
  btn.className = 'proposal-exec-btn';
  btn.textContent = t('proposalRun');
  btn.onclick = () => {
    // En Básico executeProposal explica que hace falta un modelo y no manda nada.
    const item = executeProposal(m.propuesta.md);
    if (!item) return;
    btn.disabled = true; btn.textContent = t('proposalQueued');
    // Si ■ la cancela en la cola (o para su turno), el botón vuelve a estar
    // disponible: antes se quedaba «enviada a la cola» y desactivado, aunque el
    // mensaje ya no se iba a procesar.
    item.alCancelar = () => { btn.disabled = false; btn.textContent = t('proposalRun'); };
  };
  div.appendChild(btn);
}
// Lo que el cerebro puede hacer mientras no miras: LEER. Escribir, crear apps,
// programar tareas o visitar webs queda fuera, y lo de carpetas solo si el
// permiso ya está concedido: el cerebro no saca diálogos de permisos.
const CEO_SOLO_LECTURA = new Set(['fs.list', 'fs.read', 'fs.watch_list', 'app.list', 'tasks.list', 'memory.list', 'skill.list', 'skill.get']);
ceo.usarTraductor(t);   // lo que el cerebro cuenta (ceo.js, compartido con Code), en el idioma de la página
// Los perfiles y la misión de serie, también en el idioma de la página: en inglés
// salían «Organización», «Productividad», «Memoria», su foco y la misión en
// español, y con ellos los nombres accesibles de la Mente («Go to Organización»).
// Lo que el usuario haya guardado desde la Mente se queda como lo escribió.
const tSi = (clave, porDefecto) => { const s = t(clave); return s && s !== clave ? s : porDefecto; };
ceo.init({
  namespace: 'elffuss',
  workspace: ceoWorkspace,
  defaultProfiles: CEO_DEFAULT_PROFILES.map(p => ({ ...p, name: tSi('ceoProf_' + p.id, p.name), focus: tSi('ceoProfFocus_' + p.id, p.focus) })),
  defaultMission: tSi('ceoMissionDefault', 'Revisar tu espacio (carpetas, apps, tareas, memoria) y proponer mejoras concretas y accionables.'),
  // En Básico no hay cerebro que poner a pensar: el motor de reglas contestaba
  // con su texto de ayuda, sacaba diálogos de permiso y creaba apps «boceto».
  provider: () => (activeModel === 'rules' ? null : agent.provider),
  allowTool: nombre => CEO_SOLO_LECTURA.has(nombre) && (!nombre.startsWith('fs.') || perms.has('fs')),
  // el usuario tiene PRIORIDAD: si hay algo en cola o procesándose, el cerebro espera
  isBusy: () => pumping || queue.length > 0,
  onEvent: (ch, ev) => {
    if (mente) mente.pushThought(ch, ev); else mindLog.registrar(ch, ev);
    if (ch === 'ceo' && ev.type === 'built') reportImprovements(ev);
  },
});
// cualquier interacción FUERA de la Mente cuenta como actividad → pausa el CEO
const noteAct = e => { if (!e.target.closest?.('#mind-overlay')) ceo.noteActivity(); };
document.addEventListener('pointerdown', noteAct, true);
document.addEventListener('keydown', noteAct, true);
// Abrir la Mente es SOLO abrirla. Antes, el primer clic encendía el cerebro
// autónomo para siempre (y en cada visita siguiente), pedía permiso de
// notificaciones y ponía música de un tercero. Encenderlo es el botón ▶ de
// dentro, que explica qué hace.
{
  const b = document.getElementById('btn-mind');
  b.setAttribute('aria-label', t('mindOpenBtn'));
  b.title = t('mindOpenBtn');
  b.addEventListener('click', () => abrirMente());
}
// restaura tu última elección (play o stop) tal cual la dejaste. EXCEPTO en
// modo copiloto: ahí el modelo es para soplarte argumentos en vivo, no para
// ponerse a inventar mejoras (y de paso robarle el visor al tablero).
const IS_COPILOT = /[?&]copilot=1/.test(location.search);
if (!IS_COPILOT && ceo.wasEnabledLastSession()) ceo.enable();

// Autocarga SOLO LOCAL. Por defecto Gemma-4 E4B (escritorio) o E2B (móvil/GPU
// débil), vía LiteRT-LM; si no cabe, cae a LFM2.5. Respeta lo último elegido.
(async () => {
  try {
    // Caché de modelos (persistente + service worker) ANTES de descargar nada,
    // para que hasta la primera descarga de pesos quede cacheada y no se repita.
    await ensureModelCache();
    await realGPUCheck; // que defaultBrain()/modelOptions() vean el adaptador real, no solo la API
    // El sondeo del motor propio resuelve después de que ui.init() pintara el
    // selector, así que hay que repintarlo: si no, la opción no aparece hasta
    // que algo más fuerce un refresco, y el usuario no la ve nunca.
    // Los dos sondeos se esperan JUNTOS. Repintar solo con el del motor dejaría
    // fuera el 27B cuando su comprobación tarda un poco más, y esa opción no
    // volvería a aparecer hasta que algo forzara otro refresco.
    const [hayMotor, hay27, hayMini, hayLfm3] = await Promise.all([engineCheck, modelo27Check, minicpmCheck, lfm3Check]);
    if (hayMotor || hay27 || hayMini || hayLfm3) refreshModelOptions();
    // Solo lo que eligió el usuario (ver ELEGIDO). 'elffuss.model' sigue diciendo
    // qué se cargó la última vez, pero ya no decide el arranque.
    const saved = localStorage.getItem(ELEGIDO);
    if (saved === 'rules') return; // elección explícita
    // En modo copiloto el translator YA está usando la máquina (Whisper +
    // diarización), así que si NUNCA has elegido cerebro se arranca con el
    // ligero para no competir. Pero tu elección manda: si escogiste Gemma,
    // se respeta — pisarla era un error.
    if (/[?&]copilot=1/.test(location.search) && !saved) {
      ui.toast(t('copilotLightBrain'));
      if (await changeModel('onnx:qwen3.5-0.8b')) return;
    }
    const available = new Set(modelOptions().map(o => o.id));
    // si un Gemma pesado ya falló esta sesión, no reintentar (evita re-crash)
    const skipGemma = sessionStorage.getItem('elffuss.skipGemma') === '1';
    const def = skipGemma ? 'onnx' : await pickLocalBrain();
    const chain = [...new Set([saved, def, realGPU ? 'onnx' : null]
      .filter(id => id && available.has(id)))];
    if (!chain.length) return;
    // MÓVIL: no descargar medio giga sin permiso. Hasta hoy, abrir esto en un
    // teléfono arrancaba SOLO la descarga del cerebro (~600 MB) al cargar la
    // página. Dos motivos para no hacerlo: son los datos de alguien que no ha
    // pedido nada, y encima el navegador de móvil mata la pestaña bastante
    // antes de sostener el modelo, así que muchas veces se gastaban para nada.
    // Se avisa, se deja el botón por si quiere insistir, y se recuerda su
    // elección. El modo básico sigue atendiendo mientras tanto.
    // Un TELÉFONO, no una ventana estrecha: con ratón y 760 px de ancho también
    // salía «En el móvil todavía no funciona… ábrelo en un ordenador».
    //
    // Un cerebro EXTERNO no descarga nada: se carga sin puerta. Antes, con uno
    // guardado, la puerta decía «haría falta bajar ~600 MB» y lo que cargaba al
    // aceptar no bajaba ni un byte. La puerta queda para los locales, con el
    // tamaño del que se va a bajar de verdad (podía ser un Gemma de gigas).
    if (esTelefono() && localStorage.getItem('elffuss.movil.ok') !== '1') {
      for (const id of chain.filter(x => x.startsWith('ext:'))) if (await changeModel(id)) return;
      const locales = chain.filter(x => !x.startsWith('ext:'));
      if (!locales.length) return;
      ui.mobileGate(tamanoDeDescarga(locales[0]), async () => {
        for (const id of locales) if (await changeModel(id)) return true;
        return false;
      });
      return;
    }
    const first = chain[0];
    ui.toast(first.startsWith('litert') ? t('loadingGemma') : t('loadingLocal'));
    for (const id of chain)
      if (await changeModel(id)) return;
  } finally {
    bootReady(); // la cola puede empezar a procesar (con el cerebro que haya)
  }
})();

// Vigilante de RAM: si el heap del navegador va muy lleno (los modelos
// locales viven ahí), primero avisa y, si sigue subiendo, para y LIBERA el
// modelo automáticamente antes de que la pestaña se caiga. El modelo remoto
// no gasta RAM local, así que no se toca.
let ramWarned = false;
setInterval(async () => {
  const m = performance.memory;
  if (!m?.jsHeapSizeLimit) return; // solo Chrome
  const ratio = m.usedJSHeapSize / m.jsHeapSizeLimit;
  if (ratio < 0.7) { ramWarned = false; return; }
  if (ratio > 0.92 && isLocal(activeModel)) {
    const mod = activeMod;
    agent.setProvider(rules);
    activeModel = 'rules';
    marcarModo();
    activeMod = null;
    montarVelocimetro(null);
    ui.setModel('rules');
    ui.modelStatus('off');
    try { await mod?.unload?.(); } catch { /* mejor esfuerzo */ }
    ui.addMsg('assistant', t('ramFreedMsg'));
    ui.toast(t('ramFreedToast'));
  } else if (ratio > 0.82 && !ramWarned) {
    ramWarned = true;
    ui.toast(t('ramWarn', { pct: Math.round(ratio * 100) }));
  }
}, 15000);

// Las tareas vencidas se auto-envían como prompts al agente. El aviso lleva a
// la tarea (#/tareas/<id>) y el panel abierto se repinta (se quedaba en ⏳).
function lanzarTarea(tarea) {
  ui.toast(t('taskFired', { prompt: tarea.prompt }), { accion: { label: t('see'), run: () => rutas.ir('tareas', tarea.id) } });
  ui.tareasCambiaron();
  send('[tarea programada] ' + tarea.prompt);
}
tasks.startScheduler(lanzarTarea);
ui.setOnRunTask(lanzarTarea);      // «Ejecutar ahora» desde el panel

// Automatizaciones de carpetas: dejar un archivo en la de origen → Elffuss lo
// procesa y lo deja en la de destino, avisando por chat con enlaces a la
// carpeta y a la automatización.
watch.startWatcher((msg, w) => {
  ui.toast(msg, w ? { accion: { label: t('seeFolder'), run: () => rutas.ir('permisos', w.to) } } : undefined);
  ui.addMsg('assistant', w ? `${msg}\n\n[${t('watchSee')}](${rutas.href('tareas', 'automatizaciones')})` : msg);
  ui.tareasCambiaron();
});

// ── Espacio de trabajo: qué se puede guardar en tu disco / ver / borrar ──
// El manifiesto es lo ÚNICO que Claw le cuenta al core sobre sus almacenes.
workspace.init({
  app: 'claw', ns: 'elffuss', db, opfsName: t('wsOpfsName'),
  stores: [
    // Las etiquetas son getters: se leen al pintar «Qué hay guardado», en el idioma
    // de la página (antes salían en español también en inglés).
    { id: 'apps', get label() { return t('stApps'); }, icon: '🎨', kind: 'idb-store', store: 'apps',
      files: { ext: '.html', name: a => a.name, body: a => a.html } },
    { id: 'skills', get label() { return t('stSkills'); }, icon: '🧩', kind: 'idb-key', store: 'kv', key: 'skills',
      files: { ext: '.md', name: s => s.name, body: s => `---\nname: ${s.name}\ndescription: ${s.description || ''}\n---\n\n${s.content || ''}` } },
    { id: 'history', get label() { return t('stHistory'); }, icon: '💬', kind: 'idb-key', store: 'kv', key: 'history' },
    { id: 'memory', get label() { return t('stMemory'); }, icon: '🧠', kind: 'idb-store', store: 'memory' },
    { id: 'tasks', get label() { return t('stTasks'); }, icon: '⏰', kind: 'idb-store', store: 'tasks' },
    { id: 'vault', get label() { return t('stVault'); }, icon: '🔐', kind: 'idb-store', store: 'vault', sensitive: true },
    { id: 'prefs', get label() { return t('stPrefs'); }, icon: '⚙️', kind: 'ls',
      keys: ['elffuss.model', 'elffuss.model.elegido', 'elffuss.acer', 'elffuss.resumen', 'elffuss.semantic'] },
  ],
});
workspace.restore().catch(() => {});
if (workspace.autosaveEnabled()) workspace.autosave({ enabled: true });

window.elffuss = { agent, send, workspace }; // consola de depuración

// ── Hard Work (RLM): trabaja la carpeta autorizada entera por partes ──
// Es para el PRÓXIMO mensaje que escribas, y se apaga solo al mandarlo (el
// estado se ve en el botón —aria-pressed— y en la caja). Antes se quedaba
// puesto para todo lo que viniera después, chips y tareas incluidos.
const hwBtn = document.getElementById('btn-hardwork');
function pintarHardWork() {
  if (!hwBtn) return;
  hwBtn.classList.toggle('on', hardMode);
  hwBtn.setAttribute('aria-pressed', hardMode ? 'true' : 'false');
  hwBtn.title = t('hwTitle');
  document.getElementById('prompt').placeholder = hardMode ? t('hwPlaceholder') : t('ph');
}
function apagarHardWork() { hardMode = false; pintarHardWork(); }
hwBtn?.addEventListener('click', () => {
  hardMode = !hardMode;
  pintarHardWork();
  ui.toast(hardMode ? t('hwOn') : t('hwOff'));
});
pintarHardWork();

// ── Skills de audio en vivo + superficies (SSP v0.1) ────────────────────────
// Una skill de audio escucha la conversación que llega del Translator y pinta
// su propia SUPERFICIE: una vista viva, aparte de las notificaciones, que el
// host monta, actualiza y gestiona. La superficie se proyecta también a la app
// que la abrió (pantalla partida real).
//
// Cada skill declara: qué ranuras rellena (objetivos o campos), qué instruye al
// modelo y cómo se parsea su respuesta.
const AUDIO_SKILLS = {
  ventas: {
    id: 'ventas', icon: '🎯', name: 'Copiloto de ventas',
    desc: 'Te sopla el argumento exacto y marca los objetivos de la llamada.',
    kind: 'goals', tag: 'OBJETIVOS',
    slots: [
      { key: 'nombre', label: 'El cliente da su nombre' },
      { key: 'interes', label: 'El cliente muestra interés' },
      { key: 'telefono', label: 'El cliente da su teléfono' },
      { key: 'compra', label: 'El cliente quiere comprar' },
    ],
    rule: 'OBJETIVOS: nombre=si|no; interes=si|no; telefono=si|no; compra=si|no',
    role: 'Eres mi copiloto de ventas EN VIVO. Persigue los objetivos en orden y dime el argumento exacto, la objeción a rebatir o el siguiente paso.',
  },
  ficha: {
    id: 'ficha', icon: '📇', name: 'Ficha de cliente',
    desc: 'Rellena sola la ficha con lo que el cliente va diciendo. Se exporta a Excel.',
    kind: 'fields', tag: 'DATOS', exportable: true,
    slots: [
      { key: 'nombre', label: 'Nombre' }, { key: 'empresa', label: 'Empresa' },
      { key: 'cargo', label: 'Cargo' }, { key: 'telefono', label: 'Teléfono' },
      { key: 'email', label: 'Email' }, { key: 'necesidad', label: 'Necesidad' },
      { key: 'presupuesto', label: 'Presupuesto' }, { key: 'plazo', label: 'Plazo' },
      { key: 'siguiente', label: 'Siguiente paso' },
    ],
    rule: 'DATOS: solo los campos que se hayan dicho, separados por punto y coma. Ejemplo: DATOS: nombre=Ana Ruiz; empresa=Acme; telefono=600123456. Omite los que no se hayan dicho; no escribas puntos suspensivos.',
    role: 'Eres mi asistente de ficha de cliente. Extraes los datos que el cliente dice y me avisas de qué falta por preguntar.',
  },
  facilitador: {
    id: 'facilitador', icon: '🧑‍🏫', name: 'Facilitador de reunión',
    desc: 'Temas, decisiones y tareas de la reunión, en vivo. Se exporta.',
    kind: 'fields', tag: 'DATOS', exportable: true,
    slots: [
      { key: 'tema', label: 'Tema actual' }, { key: 'decisiones', label: 'Decisiones' },
      { key: 'tareas', label: 'Tareas (quién/qué)' }, { key: 'riesgos', label: 'Riesgos' },
      { key: 'siguiente', label: 'Siguientes pasos' },
    ],
    rule: 'DATOS: solo lo que se haya dicho. Ejemplo: DATOS: tema=presupuesto 2027; decisiones=aprobado el piloto; tareas=Ana envía la propuesta. Acumula, no borres lo anterior; no escribas puntos suspensivos.',
    role: 'Eres el facilitador de la reunión. Sigues el hilo, anotas decisiones y tareas, y avisas si se desvía o si algo queda sin dueño.',
  },
  resumen: {
    id: 'resumen', icon: '📝', name: 'Resumen e ideas',
    desc: 'Resumen progresivo y las ideas que van saliendo.',
    kind: 'fields', tag: 'DATOS', exportable: true,
    slots: [
      { key: 'resumen', label: 'Resumen hasta ahora' }, { key: 'ideas', label: 'Ideas' },
      { key: 'dudas', label: 'Dudas abiertas' },
    ],
    rule: 'DATOS: resumen=<reescríbelo entero y breve cada vez>; ideas=<las que hayan salido>; dudas=<las abiertas>. No escribas puntos suspensivos.',
    role: 'Resumes la conversación según avanza y capturas las ideas y dudas que surgen.',
  },
};

function audioSkillMd(sk) {
  return `Esta skill SOLO actúa cuando llegan intervenciones marcadas con "[Hablante N]" (Hablante 1 = el usuario; Hablante 2 = el interlocutor). En una conversación normal de Claw, ignórala salvo que el usuario te pida editarla.

${sk.role}

POR CADA intervención responde EXACTAMENTE en tres líneas, nada más:
${gram.contrato(sk)}
ACCION es UNA de esas palabras, tal cual. En ${sk.tag} solo lo que se haya DICHO: un dato que nadie ha dicho se descarta.
Si no hay nada útil que aportar ahora, usa "CONSEJO: —". Nunca borres un dato ya capturado.

AUTO-EDICIÓN: puedes cambiarte a ti misma. Si el usuario te pide por el chat de Claw algo como "añade un campo email", "quita el presupuesto" o "sé más breve", edita ESTA misma skill con skill.edit y sigue la nueva versión desde ya.`;
}

// Lo que el tablero ENSEÑA, en el idioma de la página: nombre, descripción y
// etiquetas de las ranuras (cpName_<id>, cpDesc_<id>, cpSlot_<id>_<clave>). La
// skill en sí —su id, su nombre como skill instalada, las claves y el contrato
// con el modelo— no cambia de idioma: es un identificador y un formato.
const tOr = (clave, porDefecto, vars) => { const s = t(clave, vars); return s === clave ? porDefecto : s; };
function vistaDe(sk) {
  return {
    ...sk,
    name: tOr('cpName_' + sk.id, sk.name), desc: tOr('cpDesc_' + sk.id, sk.desc),
    slots: sk.slots.map(s => ({ ...s, label: tOr('cpSlot_' + sk.id + '_' + s.key, s.label) })),
  };
}
// ¿El visor enseña el tablero de esta skill? Por su id (marcado en el <body>), no
// por su nombre, que ahora sale en el idioma de la página.
const esTablero = (f, sk) => !!f && !f.hidden && (f.srcdoc || '').includes(`data-skill="${sk.id}"`);

// Superficie genérica: pinta las ranuras de la skill (objetivos o campos),
// el consejo en vivo y, si procede, el botón de exportar a Excel. Los textos del
// tablero van en el idioma de la página (antes, en español siempre).
function surfaceHtml(skill) {
  const sk = vistaDe(skill);
  const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const CSV = JSON.stringify([t('cpCsvField'), t('cpCsvValue')]);
  return `<!doctype html><html lang="${esc(uiLang())}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<style>
:root{--bg:#0b0c14;--card:#12141f;--line:#232838;--brass:#c8a06a;--brass2:#e6c294;--indigo:#6e63c5;--fg:#eae8f2;--dim:#8b91a3;--ok:#54dcc6}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:radial-gradient(130% 90% at 50% -10%,#181630,#0b0c14);color:var(--fg);padding:20px;min-height:100vh;display:flex;flex-direction:column}
h1{font-family:"Iowan Old Style",Georgia,serif;font-size:1.12rem;margin:0 0 3px;background:linear-gradient(96deg,var(--brass2),var(--indigo));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.sub{color:var(--dim);font-size:.6rem;letter-spacing:.15em;text-transform:uppercase;margin-bottom:14px;font-family:ui-monospace,monospace}
.sub b{color:var(--brass2);float:right;font-weight:500}
.bar{height:7px;border-radius:99px;background:var(--line);overflow:hidden;margin-bottom:16px}
.bar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--brass),var(--indigo));transition:width .7s cubic-bezier(.2,.7,.2,1)}
.slot{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:11px;background:var(--card);margin-bottom:8px;transition:border-color .4s,background .4s,transform .3s}
.slot .dot{width:20px;height:20px;border-radius:50%;border:2px solid var(--line);flex:none;display:grid;place-items:center;font-size:.65rem;color:transparent;transition:all .4s;margin-top:1px}
.slot .k{font-size:.62rem;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);font-family:ui-monospace,monospace}
.slot .v{font-size:.9rem;color:var(--fg);line-height:1.35;word-break:break-word}
.slot .lbl{font-size:.88rem;color:var(--dim);transition:color .4s}
.slot.done{border-color:var(--brass);background:linear-gradient(120deg,rgba(200,160,106,.10),rgba(130,114,255,.05))}
.slot.done .dot{background:var(--ok);border-color:var(--ok);color:#06210b}
.slot.done .lbl{color:var(--fg)}
.slot.just{animation:pop .6s cubic-bezier(.2,.8,.2,1)}
@keyframes pop{0%{transform:scale(1)}40%{transform:scale(1.03)}100%{transform:scale(1)}}
.advice{margin-top:auto;padding:13px 15px;border:1px solid var(--line);border-left:3px solid var(--brass);border-radius:10px;background:rgba(200,160,106,.05);font-size:.9rem;line-height:1.4;color:var(--brass2)}
.advice .k{display:block;font-family:ui-monospace,monospace;font-size:.56rem;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin-bottom:5px}
.advice.flash{animation:advin .4s ease}
@keyframes advin{0%{opacity:.4;transform:translateY(-3px)}100%{opacity:1;transform:none}}
button{margin-top:10px;width:100%;background:transparent;color:var(--brass);border:1px solid var(--line);border-radius:8px;padding:9px;font:inherit;font-size:.78rem;cursor:pointer}
button:hover{border-color:var(--brass)}
</style></head><body data-skill="${esc(sk.id)}">
<h1>${sk.icon} ${esc(sk.name)}</h1>
<div class="sub">${esc(t(sk.kind === 'goals' ? 'cpGoals' : 'cpData'))} <b id="count"></b></div>
<div class="bar"><i id="fill"></i></div>
<div id="slots"></div>
<div class="advice" id="advice"><span class="k">${esc(t('cpLive'))}</span><span id="atext">${esc(t('cpWaiting'))}</span></div>
${sk.exportable ? `<button id="exp">${esc(t('cpExport'))}</button>` : ''}
<script>
const KIND=${JSON.stringify(sk.kind)}, SLOTS=${JSON.stringify(sk.slots)}, NAME=${JSON.stringify(sk.name)}, CSV_HEAD=${CSV};
let data={};
function render(justKey){
  const box=document.getElementById('slots'); box.innerHTML=''; let filled=0;
  for(const s of SLOTS){
    const v=data[s.key]; const has=KIND==='goals' ? v===true : !!(v&&String(v).trim());
    if(has) filled++;
    const el=document.createElement('div');
    el.className='slot'+(has?' done':'')+(s.key===justKey?' just':'');
    if(KIND==='goals'){ el.innerHTML='<div class="dot">✓</div><div class="lbl"></div>'; el.querySelector('.lbl').textContent=s.label; }
    else { el.innerHTML='<div class="dot">✓</div><div><div class="k"></div><div class="v"></div></div>';
      el.querySelector('.k').textContent=s.label; el.querySelector('.v').textContent=has?v:'—'; }
    box.appendChild(el);
  }
  document.getElementById('count').textContent=filled+' / '+SLOTS.length;
  document.getElementById('fill').style.width=(SLOTS.length?filled/SLOTS.length*100:0)+'%';
}
render(null);
addEventListener('message',e=>{
  const d=e.data||{}; if(d.type!=='surface-state') return;
  let just=null;
  if(d.data) for(const [k,v] of Object.entries(d.data)){ if(data[k]!==v&&v) just=k; data[k]=v; }
  render(just);
  if(typeof d.advice==='string'&&d.advice){ const a=document.getElementById('advice');
    document.getElementById('atext').textContent=d.advice;
    a.classList.remove('flash'); void a.offsetWidth; a.classList.add('flash'); }
});
const exp=document.getElementById('exp');
if(exp) exp.onclick=()=>{
  const rows=[CSV_HEAD].concat(SLOTS.map(s=>[s.label,(data[s.key]==null?'':String(data[s.key]))]));
  const csv='\\ufeff'+rows.map(r=>r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(';')).join('\\r\\n');
  const a=document.createElement('a');
  a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download=NAME.toLowerCase().replace(/[^a-z0-9]+/g,'-')+'.csv'; a.click();
};
try{parent.postMessage({type:'surface-ready'},'*');}catch(e){}
<\/script></body></html>`;
}

let copilotSkill = AUDIO_SKILLS.ventas;
let copilotData = {};

function copilotInitState() { copilotData = {}; copilotTranscript = []; }
function renderCopilotBoard() {
  try { ui.renderApp(copilotSkill.icon + ' ' + vistaDe(copilotSkill).name, surfaceHtml(copilotSkill)); } catch { /* */ }
}
// Una app que el USUARIO acaba de abrir (Apps › Abrir, o su dirección) manda
// sobre el tablero un rato: antes el vigilante la tapaba con el tablero a los
// pocos segundos, y «Abrir» parecía no hacer nada.
const COPILOTO_RESPETA_MS = 60000;
const vistaLibreParaTablero = () => Date.now() - ui.aperturaManual() > COPILOTO_RESPETA_MS;
const tableroALaVista = () => esTablero(document.getElementById('appframe'), copilotSkill);
function copilotPostState(advice) {
  // El visor de Claw es uno solo: si otra cosa (una app del agente, el cerebro
  // autónomo…) lo ocupa, la superficie desaparecía. Se re-monta sola.
  if (!tableroALaVista() && vistaLibreParaTablero()) renderCopilotBoard();
  const frame = document.getElementById('appframe');
  const msg = { type: 'surface-state', id: copilotSkill.id, data: copilotData, advice: advice || '' };
  // Solo al tablero: si en el visor hay otra app, los datos de la llamada no son suyos.
  if (tableroALaVista()) { try { frame?.contentWindow?.postMessage(msg, '*'); } catch { /* */ } }
  // Proyección a la app que abrió el copiloto: pantalla partida de verdad.
  if (window.__copilotOpener && window.opener) {
    try { window.opener.postMessage({ kind: 'surface-state', ...msg }, window.__copilotOpener); } catch { /* */ }
  }
}

// Parsea la respuesta del modelo contra la GRAMÁTICA del copiloto
// (copilot-grammar.js): consejo libre pero verificado, acción de vocabulario
// cerrado, y datos que solo entran si pasan el validador de su ranura y están
// anclados en lo que se ha dicho. Guardia: tests/copilot_gramatica.mjs.
function copilotParse(text) {
  return gram.parse(text, copilotSkill, { transcript: copilotTranscript.join('\n') });
}
// El consejo se emite DESPUÉS de aplicar los datos (los del modelo y, si toca,
// los deterministas): cuando el modelo no da uno utilizable, el que se compone
// desde la acción + el tablero tiene que mirar el tablero YA corregido.
function copilotEmit(text, { applyRules = false, isGemma = false } = {}) {
  const { advice, action, updates, rejected } = copilotParse(text);
  for (const [k, v] of Object.entries(updates)) copilotData[k] = v;
  if (applyRules) copilotHybrid(isGemma);
  // Qué ha filtrado la gramática, a mano para depurar en una llamada real.
  if (rejected.length) { window.__copilotRejected = rejected; console.debug('[copiloto] gramática rechazó:', rejected.join(', ')); }
  // Sin consejo utilizable el copiloto NO se calla: la acción es de vocabulario
  // cerrado (fiable incluso en cerebro ligero) y con el tablero da uno real.
  // Solo en un turno de copiloto (applyRules): por aquí pasan TAMBIÉN las
  // respuestas normales del chat de Claw, y esas no deben pisar el consejo con
  // un «pregunta ahora por…» que nadie ha pedido.
  const show = advice || (applyRules ? gram.fallbackAdvice(copilotSkill, copilotData, action) : '');
  copilotPostState(show);
  if (show && window.__copilotOpener && window.opener) {
    try { window.opener.postMessage({ kind: 'copilot-advice', text: show }, window.__copilotOpener); } catch { /* */ }
  }
  return show;
}
window.__copilotEmit = copilotEmit;

// ── Extracción DETERMINISTA de datos del cliente ──────────────────────────────
// El cerebro ligero NO rastrea fiable: Qwen marca todos los objetivos «sí» desde
// el turno 1 (falsos positivos) y LFM2.5 no marca nada; además alucinan teléfonos.
// Los datos regex-ables —teléfono (también HABLADO: «seis uno uno…»), email,
// nombre— se sacan de la transcripción con reglas y MANDAN sobre el modelo.
const _NUM = { cero: 0, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9 };
function _spelledDigits(t) {
  const ws = t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/);
  let run = [], best = '';
  for (const w of ws) {
    if (w in _NUM) run.push(_NUM[w]);
    else if (/^\d+$/.test(w)) { for (const d of w) run.push(+d); }
    else { if (run.length > best.length) best = run.join(''); run = []; }
  }
  if (run.length > best.length) best = run.join('');
  return best;
}
function _phone(t) {
  const m = t.replace(/[\s.\-()]/g, '').match(/\+?\d{7,}/);
  if (m) return m[0];
  const sp = _spelledDigits(t);
  return sp.length >= 7 ? sp : null;
}
const _EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i;
// El disparador acepta mayúscula inicial («Me llamo Ana», que es como empieza
// una frase en una transcripción); el nombre sigue teniendo que ir en mayúscula.
const _NAME_RE = /\b(?:[Mm]e llamo|[Mm]i nombre es|[Ss]oy|[Ll]e habla|[Hh]abla)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,2})/;
const _NAME_STOP = /^(de|del|la|el|un|una|responsable|comercial|gerente|director|jefe)\b/i;
const _INTERES_RE = /\b(me interesa|nos interesa|interesad|me viene bien|suena bien|me gustar[ií]a)\b/i;
const _COMPRA_RE = /\b(quiero contratar|queremos contratar|quiero comprar|lo contrato|me lo quedo|adelante|cerramos|firmamos|hacemos el pedido)\b/i;
// Solo lo que dice el CLIENTE (Hablante 2); el vendedor (Hablante 1) no es el fichado.
function _clientText(lines) {
  return lines.filter(l => /^\[Hablante 2|^\[interlocutor/i.test(l))
    .map(l => l.replace(/^\[[^\]]*\]\s*/, '')).join('\n');
}
function deterministicFields(lines) {
  const t = _clientText(lines), out = {};
  const ph = _phone(t); if (ph) out.telefono = ph;
  const em = (t.match(_EMAIL_RE) || [])[0]; if (em) out.email = em;
  const nm = (t.match(_NAME_RE) || [])[1]; if (nm && !_NAME_STOP.test(nm)) out.nombre = nm.trim();
  return out;
}
function deterministicGoals(lines) {
  const t = _clientText(lines), out = {};
  const f = deterministicFields(lines);
  if (f.telefono) out.telefono = true;
  if (f.nombre) out.nombre = true;
  if (_INTERES_RE.test(t)) out.interes = true;
  if (_COMPRA_RE.test(t)) out.compra = true;
  return out;
}
let copilotTranscript = [];
// Corrige copilotData con las reglas tras la respuesta del modelo:
//  · ficha  → teléfono/email/nombre MANDAN (más fiables que el modelo pequeño).
//  · ventas en cerebro LIGERO → objetivos SOLO por reglas (mata el «todo sí»).
//    en Gemma → se suma como respaldo (Gemma ya rastrea bien).
function copilotHybrid(isGemma) {
  const sk = copilotSkill;
  if (sk.id === 'ficha') {
    Object.assign(copilotData, deterministicFields(copilotTranscript));
  } else if (sk.id === 'ventas') {
    const dg = deterministicGoals(copilotTranscript);
    if (isGemma) { for (const k in dg) copilotData[k] = true; }
    else { for (const s of sk.slots) copilotData[s.key] = !!dg[s.key]; }
  }
}

// Turno de copiloto por la VÍA RÁPIDA: no pasa por el bucle agéntico (que
// mete todas las herramientas, las skills y el estado del sistema en el
// prompt). Un modelo pequeño se pierde en ese muro y se pone a conversar en
// vez de aconsejar — además de tardar mucho más. Aquí: prompt mínimo,
// historial corto y el formato recordado en cada turno.
let copilotHist = [];
let copilotBusy = false;
async function copilotTurn(line) {
  if (copilotBusy) return;                 // un turno a la vez: el modelo es uno
  copilotBusy = true;
  const sk = copilotSkill;
  // El contrato lo escribe la gramática (copilot-grammar.js), no este prompt: si
  // el formato cambia aquí y allí no, el validador tira todo lo que llegue.
  const sys = `Eres el copiloto de ${sk.name}. Escuchas una conversación ajena y AYUDAS a quien la mantiene. NUNCA respondas como si fueras un interlocutor ni continúes el diálogo.
Responde SIEMPRE exactamente en tres líneas, sin comillas y sin nada más:
${gram.contrato(sk)}
ACCION es UNA de esas palabras, tal cual. En ${sk.tag} solo lo que se haya DICHO: nada inventado.
Si no hay nada útil que decir: CONSEJO: —`;
  copilotHist.push({ role: 'user', content: line });
  if (copilotHist.length > 8) copilotHist = copilotHist.slice(-8);
  const recordatorio = `\n\n(Responde SOLO con las tres líneas: CONSEJO: … / ACCION: … / ${sk.tag}: …)`;
  const msgs = copilotHist.slice(0, -1).concat([{ role: 'user', content: line + recordatorio }]);
  try {
    const out = await agent.provider.chat(msgs, sys, () => {});
    copilotHist.push({ role: 'assistant', content: String(out).slice(0, 400) });
    // En el chat va SOLO el consejo, no las tres líneas crudas del contrato
    // (CONSEJO/ACCION/DATOS; en Básico, el texto de ayuda): se lee sin descifrar.
    console.debug('[copiloto] salida del modelo:', String(out).slice(0, 300));
    // La transcripción se apunta ANTES de emitir: la gramática la usa para anclar
    // los datos (lo que nadie dijo no entra) y para cazar el consejo que solo es
    // eco del interlocutor.
    copilotTranscript.push(line);
    // applyRules → corrección determinista dentro del emit: los datos
    // regex-ables mandan sobre el modelo y, en cerebro ligero, los objetivos
    // salen SOLO de reglas. El consejo se compone ya con el tablero corregido.
    const consejo = copilotEmit(out, { applyRules: true, isGemma: activeModel.startsWith('litert') });
    if (consejo && consejo !== '—') ui.addMsg('assistant', '💡 ' + consejo);
  } catch (e) {
    ui.addMsg('assistant err', 'copiloto: ' + (e?.message || e));
  } finally { copilotBusy = false; }
}


// ── Pipe cross-origin: skills de audio en vivo desde el Translator ──
(function copilotPipe() {
  try { if (!/[?&]copilot=1/.test(location.search)) return; } catch { return; }
  // El Translator vive en translator.elffuss.com. El host anterior se sigue
  // aceptando mientras dure el cambio de dominio; translator.utopiaia.com no
  // hace falta porque solo redirige y nunca llega a abrir esta ventana.
  const ALLOWED = ['https://translator.elffuss.com', 'https://translator.elffuss.utopiaia.com'];
  // qué skill de audio se ha pedido (?skill=ficha, etc.)
  const want = (location.search.match(/[?&]skill=([\w-]+)/) || [])[1];
  if (want && AUDIO_SKILLS[want]) copilotSkill = AUDIO_SKILLS[want];
  let started = false;
  window.addEventListener('message', e => { if (e.data && e.data.type === 'surface-ready') copilotPostState(''); });
  window.addEventListener('message', async e => {
    if (!ALLOWED.includes(e.origin)) return;
    // Se contesta al origen que habló, no a uno fijo: con dos hosts válidos,
    // responder siempre al mismo dejaría mudo al otro.
    window.__copilotOpener = e.origin;
    const m = e.data || {};
    if (m.kind === 'copilot-init' && !started) {
      started = true;
      if (m.skill && AUDIO_SKILLS[m.skill]) copilotSkill = AUDIO_SKILLS[m.skill];
      const sk = copilotSkill;
      const sellerLang = m.sellerLangName || 'el idioma del usuario';
      try {
        if (!skills.installed().some(s => s.name === sk.name)) {
          await skills.createSkill({ name: sk.name, description: sk.desc, instructions: audioSkillMd(sk) });
          // Se dice: es una skill nueva en TUS skills, y se puede quitar.
          ui.toast(t('copilotSkillInstalled', { name: sk.name }), { accion: { label: t('see'), run: () => rutas.ir('skills', sk.name) } });
        }
      } catch { /* */ }
      copilotInitState();
      renderCopilotBoard();
      // Proyectar la superficie a la app que nos abrió → pantalla partida real.
      try { window.opener?.postMessage({ kind: 'surface', v: 1, id: sk.id, title: sk.icon + ' ' + vistaDe(sk).name, html: surfaceHtml(sk) }, e.origin); } catch { /* */ }
      clearInterval(window.__copilotBoardWatch);
      window.__copilotBoardWatch = setInterval(() => {
        const f = document.getElementById('appframe');
        if (document.hidden) return;
        if (!esTablero(f, sk) && vistaLibreParaTablero()) { renderCopilotBoard(); copilotPostState(''); }
      }, 5000);
      setTimeout(() => { if (activeModel === 'rules') copilotPostState(t('copilotLoading')); }, 800);
      copilotHist = [];
    } else if (m.kind === 'transcript' && m.text) {
      const line = '[' + (m.speaker || 'interlocutor') + '] ' + String(m.text).slice(0, 400);
      // Lo que se dice en la llamada no es lo que escribe el usuario: va con su
      // propio estilo y quién habla, no como una burbuja suya.
      ui.addTranscripcion(m.speaker || 'interlocutor', String(m.text).slice(0, 400));
      copilotTurn(line);
    }
  });
  // Aquí aún no se sabe cuál de los dos abrió la ventana (es otro origen y no se
  // puede leer), así que se avisa a ambos: postMessage solo entrega el mensaje
  // al que coincide con el destino y descarta el otro.
  if (window.opener) for (const o of ALLOWED) { try { window.opener.postMessage({ kind: 'copilot-ready' }, o); } catch { /* */ } }
})();

// La dirección con la que se abrió la página (#/apps/reloj, #/mente/<ruta>…).
// Va AQUÍ, al final del módulo, y no junto a rutas.alCambiar: seguirla allí
// abría la Mente antes de que existiera su estado (`menteCargando` se declara
// después), y cargar #/mente/… enseñaba «Cannot access 'menteCargando' before
// initialization» en vez de la Mente. Al final, todo lo del módulo ya existe.
{
  const r = rutas.leer();
  if (r) ui.navegar(r);
}
