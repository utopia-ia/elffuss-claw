// Modelo vía ONNX Runtime Web (transformers.js, WebGPU con fallback a wasm).
// Patrón copiado de la demo verificada en agentic-install
// (lab/bitacora/posts/08-jspace-live.html): dtype 'q4' obligatorio — q4f16
// genera basura vía WebGPU incluso con shader-f16.
import { MODEL, ONNX_MODELS, setOnnxModel } from '../model-config.js';
import { packHistoryAsync } from '../context.js';

export let name = MODEL.label;

// Elegir qué ONNX cargar. Si cambia respecto al ya cargado, se descarta la
// sesión para que load() cree la nueva (un modelo distinto = otra sesión).
let generator = null, TextStreamer = null, Interruptor = null, cargadoKey = null;
export function configure(key) {
  const antes = MODEL.key;
  setOnnxModel(key);
  name = MODEL.label;
  if (MODEL.key !== cargadoKey && generator) { try { generator?.dispose?.(); } catch {} generator = null; }
  return MODEL.key !== antes;
}
export function models() { return Object.values(ONNX_MODELS); }

export async function load(onProgress = () => {}) {
  if (generator) return; // un solo modelo: nunca recargar/duplicar la sesión
  const tf = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4');
  TextStreamer = tf.TextStreamer;
  // Para PARAR la generación de verdad (ver chat). Se comprueba que exista en
  // vez de darlo por hecho: la URL sigue la última v4 publicada y, si una
  // versión lo quitara, parar debe degradar a «dejar de pintar», no romper.
  Interruptor = typeof tf.InterruptableStoppingCriteria === 'function' ? tf.InterruptableStoppingCriteria : null;
  if (MODEL.selfHosted) {
    tf.env.allowRemoteModels = false;
    tf.env.localModelPath = MODEL.basePath;
  }
  // navigator.gpu puede EXISTIR como API sin que haya un adaptador real
  // (ciertos Linux/drivers, entornos sandboxed, navegadores headless…) — usar
  // solo la presencia del objeto como señal hace que pipeline() intente
  // WebGPU, falle con "Failed to get GPU adapter" DESPUÉS de descargar el
  // modelo entero, y en preloadModel() eso encadena a probar Gemma (varios
  // GB) para nada. Comprobar el adaptador de verdad antes de elegir.
  let device = 'wasm';
  if (navigator.gpu) {
    try { device = (await navigator.gpu.requestAdapter()) ? 'webgpu' : 'wasm'; }
    catch { device = 'wasm'; }
  }
  generator = await tf.pipeline('text-generation', MODEL.id, {
    device,
    dtype: MODEL.dtype,
    progress_callback: onProgress,
  });
  cargadoKey = MODEL.key;
}

// Liberar el modelo (vigilante de RAM): suelta los buffers wasm/WebGPU.
export async function unload() {
  try { await generator?.dispose?.(); } catch { /* mejor esfuerzo */ }
  generator = null; cargadoKey = null;
}

// Parado: AbortError con lo generado hasta ese punto en `partial`.
function abortado(partial) {
  const e = new DOMException('Parado', 'AbortError');
  try { e.partial = partial; } catch { /* sin expandos: da igual */ }
  return e;
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

// El 4º argumento es la señal sola o `{ signal, onPrefill }` (ver senalDe). Sin
// normalizarlo, con el objeto de opciones `signal.addEventListener` no existía y
// chat() reventaba con un TypeError antes de generar nada.
// Lo que ocupa el bloque de memoria del turno (agent.js `reserveTokens`): se
// descuenta del presupuesto de la historia antes de empaquetarla.
const reservaDe = x => (x && typeof x === 'object' && Number.isFinite(x.reserveTokens) && x.reserveTokens > 0 ? Math.floor(x.reserveTokens) : 0);
export async function chat(history, system, onToken = () => {}, opciones = null) {
  if (!generator) throw new Error('Modelo no cargado');
  const signal = senalDe(opciones);
  if (signal?.aborted) throw abortado('');
  // ACE-lite: eviction por relevancia. Presupuesto amplio (LFM2.5 aguanta
  // contexto largo); el tope POR MENSAJE (context.js) evita que un README
  // gigante dispare «Too many tokens requested».
  const messages = [{ role: 'system', content: system }, ...(await packHistoryAsync(history, Math.max(500, 5000 - reservaDe(opciones))))];
  if (signal?.aborted) throw abortado('');
  let streamed = '';
  const streamer = new TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: t => { if (signal?.aborted) return; streamed += t; onToken(t); },
  });
  // PARAR de verdad. Antes la señal solo silenciaba el streamer: el modelo
  // seguía generando hasta acabar la respuesta (hasta max_new_tokens) con la
  // CPU/GPU ocupada, y el turno siguiente esperaba a una respuesta que ya nadie
  // iba a leer.
  // InterruptableStoppingCriteria es el corte que trae transformers.js: al
  // abortar se llama a interrupt() y la generación termina en el paso siguiente.
  const corte = signal && Interruptor ? new Interruptor() : null;
  const alAbortar = () => { try { corte?.interrupt(); } catch { /* ya terminó */ } };
  signal?.addEventListener('abort', alAbortar, { once: true });
  let out;
  try {
    out = await generator(messages, {
      max_new_tokens: 1024,
      do_sample: false,          // determinista: los tool calls JSON lo agradecen
      repetition_penalty: 1.1,
      return_full_text: false,
      streamer,
      ...(corte ? { stopping_criteria: corte } : {}),
    });
  } catch (e) {
    if (signal?.aborted) throw abortado(sinThink(streamed));
    throw e;
  } finally {
    signal?.removeEventListener('abort', alAbortar);
  }
  const gen = out?.[0]?.generated_text;
  const txt = sinThink(gen == null ? streamed : (typeof gen === 'string' ? gen : gen.at(-1).content));
  if (signal?.aborted) throw abortado(txt);
  return txt;
}

// Modelos de razonamiento (Qwen3): fuera el <think>. Si quedó abierto por el
// tope de tokens, nos quedamos con lo de después de la última apertura.
function sinThink(txt) {
  txt = String(txt || '');
  if (txt.includes('<think>')) {
    txt = txt.replace(/<think>[\s\S]*?<\/think>/g, '');
    const i = txt.lastIndexOf('<think>');
    if (i !== -1) txt = txt.slice(i + 7);
    txt = txt.replace(/<\/?think>/g, '');
  }
  return txt.trim();
}

// Solo para pruebas (tests/onnx-stop.mjs, tests/chat-opts.mjs): probar chat()
// con un generador de mentira sin descargar ningún modelo. `Corte` null simula
// un transformers.js sin InterruptableStoppingCriteria. Inerte si la prueba no
// lo pide a propósito (globalThis.__ELFFUSS_PRUEBAS__): en la app de verdad no
// cambia el modelo cargado por nada.
export function __usarGenerador(gen, Streamer, Corte = null) {
  if (!globalThis.__ELFFUSS_PRUEBAS__) throw new Error('__usarGenerador es solo para pruebas');
  generator = gen; TextStreamer = Streamer; Interruptor = Corte; cargadoKey = MODEL.key;
}
