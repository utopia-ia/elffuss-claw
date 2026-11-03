// Modelo vía WebLLM (MLC): WebGPU con kernels compilados por MLC, sin ONNX
// Runtime en medio.
//
// Por qué existe este proveedor: el mismo MiniCPM5-2B en ONNX q4f16 ABORTA en
// onnxruntime-web —número pelado, sin mensaje— tanto en webgpu como en wasm,
// con los ficheros servidos en local y 4 GB de maxBufferSize libres. Por MLC
// carga y responde coherente. Es una puerta distinta, no una variante.
import { packHistoryAsync } from '../context.js';

export const WEBLLM_MODELS = {
  'minicpm5-2b': {
    key: 'minicpm5-2b',
    label: 'MiniCPM5-2B · WebLLM',
    tag: '~1,3 GB · texto, 2B',
    base: 'https://huggingface.co/fatih-can/MiniCPM5-2B-MLC/resolve/main/q4f16_1/',
    lib: 'libs/MiniCPM5-2B-q4f16_1-MLC-webgpu.wasm',
    ctx: 4096,            // el WASM viene compilado a 32k; se acota sin descargar nada
  },
};

let motor = null, cargadoKey = null, actual = WEBLLM_MODELS['minicpm5-2b'];
export let name = actual.label;

export function configure(key) {
  const antes = actual.key;
  if (WEBLLM_MODELS[key]) actual = WEBLLM_MODELS[key];
  name = actual.label;
  if (actual.key !== cargadoKey && motor) { try { motor.unload?.(); } catch {} motor = null; }
  return actual.key !== antes;
}
export function models() { return Object.values(WEBLLM_MODELS); }
export let ctxTokens = 4096;

export async function load(onProgress = () => {}) {
  if (motor && cargadoKey === actual.key) return;
  const webllm = await import('https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm');
  // La base puede apuntar a otro sitio para pruebas locales; por defecto, HF.
  const base = (window.__WEBLLM_BASE || actual.base);
  onProgress('Preparando el modelo…');
  motor = await webllm.CreateMLCEngine(actual.key, {
    appConfig: { model_list: [{
      model: base, model_id: actual.key, model_lib: base + actual.lib,
      overrides: { context_window_size: actual.ctx },
    }] },
    initProgressCallback: (p) => onProgress(p.text || ''),
  });
  cargadoKey = actual.key;
  ctxTokens = actual.ctx;
}

export async function unload() {
  try { await motor?.unload?.(); } catch {}
  motor = null; cargadoKey = null;
}

// Solo para tests/stop.mjs: probar chat() con un motor de mentira que imita el
// cerrojo y la interrupción de MLC, sin GPU. Inerte si la prueba no lo pide a
// propósito (globalThis.__ELFFUSS_PRUEBAS__), como los de onnx.js y litert.js:
// en la app de verdad no cambia el motor cargado por nada.
export function __usarMotor(m) {
  if (!globalThis.__ELFFUSS_PRUEBAS__) throw new Error('__usarMotor es solo para pruebas');
  motor = m; cargadoKey = actual.key;
}

// El 4º argumento de chat() puede ser la señal misma o un objeto que la lleva
// dentro, { signal, onPrefill }, que es lo que pasa el agente (rlm.js pasa la
// señal sola). Se aceptan las dos formas, como en el motor propio: se reconoce
// por la forma y no por la clase, igual que allí.
const senalDe = x => (x && typeof x.aborted === 'boolean') ? x
  : (x && x.signal && typeof x.signal.aborted === 'boolean') ? x.signal : null;

// `signal` (opcional): parar el turno con `interruptGenerate()` del motor de
// MLC (comprobado en la versión fijada arriba, 0.2.85: existe y marca una
// bandera que el bucle de decodificación mira en cada paso).
//
// Dos detalles de esa versión que obligan a hacerlo así:
//   · el cerrojo del modelo se coge al CREAR la petición y se suelta al acabar
//     el generador (no en un finally): salir del bucle con break, o no leerlo,
//     lo dejaba cogido y la petición siguiente esperaba para siempre. Así que
//     el flujo se lee hasta el final; tras interrumpir quedan muy pocos trozos
//     y no se emiten;
//   · el generador pone la bandera a false al ARRANCAR, así que una parada
//     anterior a su primer trozo se perdería: se vuelve a pedir en cada trozo.
// Lo que ocupa el bloque de memoria del turno (agent.js `reserveTokens`): se
// descuenta del presupuesto de la historia antes de empaquetarla.
const reservaDe = x => (x && typeof x === 'object' && Number.isFinite(x.reserveTokens) && x.reserveTokens > 0 ? Math.floor(x.reserveTokens) : 0);
export async function chat(history, system, onToken = () => {}, signal = null) {
  const reserva = reservaDe(signal);
  signal = senalDe(signal);
  if (!motor) throw new Error('Modelo no cargado');
  if (signal?.aborted) return '';
  const messages = [{ role: 'system', content: system }, ...(await packHistoryAsync(history, Math.max(500, 2500 - reserva)))];
  if (signal?.aborted) return '';
  // Sin el bloque de razonamiento: es un modelo híbrido y el <think> se come el
  // presupuesto de tokens sin aportar nada a lo que el usuario lee.
  const flujo = await motor.chat.completions.create({
    messages, stream: true, temperature: 0, max_tokens: 1024,
    extra_body: { enable_thinking: false },
  });
  const m = motor;
  const alAbortar = () => { try { m.interruptGenerate?.(); } catch { /* ya no genera */ } };
  signal?.addEventListener?.('abort', alAbortar, { once: true });
  let txt = '';
  try {
    for await (const trozo of flujo) {
      if (signal?.aborted) { alAbortar(); continue; }
      const t = trozo.choices?.[0]?.delta?.content || '';
      if (t) { txt += t; onToken(t); }
    }
  } finally { signal?.removeEventListener?.('abort', alAbortar); }
  // Por si aun así abre <think> (el tope de tokens puede dejarlo sin cerrar).
  if (txt.includes('<think>')) {
    txt = txt.replace(/<think>[\s\S]*?<\/think>/g, '');
    const i = txt.lastIndexOf('<think>');
    if (i !== -1) txt = txt.slice(i + 7);
  }
  return txt.trim();
}
