// Lado SEMÁNTICO del motor de contexto (el compañero de acer-core.js).
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUÉ EXISTE
//
// acer-core.js ya trae la vía híbrida completa (`packHistoryACERHybrid`): BM25 y
// embeddings fusionados por rangos. Lo que le faltaba era una función `embed`,
// así que degradaba a la vía léxica y en producción sólo corría BM25.
//
// Medido en LoCoMo (200 preguntas, F1 del propio repo, modelo real respondiendo,
// mismo presupuesto de tokens):
//
//     contexto COMPLETO sin comprimir ..... 22,56
//     BM25 (lo que corría hasta ahora) .... 23,59
//     embeddings solos .................... 23,95
//     fusión de RANGOS (esto) ............. 28,09   ← +4,50 sobre BM25
//
// El motivo de que sume no es que lo semántico sea «mejor»: en global EMPATAN
// (23,59 vs 23,95). Hacen trabajos DISTINTOS. Partiendo las mismas preguntas por
// solape de vocabulario entre la pregunta y la respuesta:
//
//                            sin solape (n=107)   con solape (n=93)
//     BM25 ...................... 18,60               29,33
//     embeddings ................ 24,28               23,58
//     fusión de rangos .......... 24,05               32,73
//
// Cuando la pregunta NO nombra literalmente lo que busca, BM25 se hunde (18,60)
// y lo semántico aguanta (24,28). Cuando sí lo nombra, manda BM25 (29,33). La
// fusión se queda con los dos. Lo semántico no sustituye al léxico: le cubre el
// punto ciego. Eso —y no una ganancia global— es lo que se está cableando aquí.
//
// ─────────────────────────────────────────────────────────────────────────────
// MODELO ELEGIDO — Xenova/multilingual-e5-small, dtype q8 (118 MB)
//
// Requisitos duros y cómo los cumple:
//   · transformers.js: es la conversión ONNX oficial del mantenedor de la
//     librería → carga con el MISMO `pipeline()` que ya usa providers/onnx.js.
//   · pequeño: 118 MB en q8. Es la variante más liviana del repo (el q4 pesa
//     MÁS —398 MB— porque la matriz de embeddings de un vocabulario de 250k no
//     se cuantiza igual de bien; aquí «menos bits» no significa menos disco).
//   · multilingüe: tokenizador XLM-R, 100 idiomas. Los prompts van en castellano
//     y el código en inglés, y ese cruce es exactamente el punto ciego léxico.
//   · licencia: MIT (intfloat/multilingual-e5-small aguas arriba).
//   · ventana de 512 tokens, que es la que necesitan los bloques que arma
//     acer-core; no es un modelo de frases sueltas.
//
// Descartados, y por qué:
//   · Xenova/all-MiniLM-L6-v2 (23 MB, Apache-2.0) — 5× más barato, pero SÓLO
//     inglés. Justo el caso que venimos a cubrir es el castellano.
//   · Xenova/paraphrase-multilingual-MiniLM-L12-v2 (118 MB, Apache-2.0) — mismo
//     peso, pero está afinado para paráfrasis de FRASES con ventana de 128
//     tokens: trocearía los bloques por la mitad.
//   · onnx-community/embeddinggemma-300m-ONNX (175 MB en q4f16 + pesos externos)
//     — mejor calidad, pero 1,5× de descarga y licencia Gemma (uso comercial
//     permitido pero con política de uso y obligaciones de redistribución), no
//     una licencia comercial limpia.
//   · ibm-granite/granite-embedding-107m-multilingual (Apache-2.0) — sólo
//     publica ONNX en fp32: 428 MB, 3,6× la descarga.
//   · minishlab/potion-multilingual-128M (MIT) — estático y rapidísimo, pero su
//     único ONNX pesa 512 MB y transformers.js no lo soporta de serie.
//
// DTYPE SEGÚN EL DISPOSITIVO — medido, no supuesto. Mismo modelo, mismo lote de
// bloques, sólo cambiando dtype y dispositivo (coste relativo, 1,0 = el mejor):
//
//     fp16 / WebGPU ....  1,0×   (235 MB)   ← el elegido cuando hay adaptador
//     q4f16/ WebGPU ....  0,6×   (205 MB)   con bloques medianos; ver punto 2
//     q8   / wasm ......  8,9×   (118 MB)   ← la red de seguridad
//     fp32 / wasm ...... 11,0×   (470 MB)
//     q8   / WebGPU .... 14,1×   (118 MB)   ← PEOR que en CPU
//
// Dos cosas que contradicen la intuición y por eso van escritas:
//   1. Los enteros de 8 bits NO se aceleran en WebGPU: ORT-web no tiene kernels
//      para esos operadores y acaba yendo y viniendo de la CPU. El fichero más
//      pequeño resulta ser el MÁS LENTO en la GPU. Elegir dtype por tamaño de
//      descarga, sin medir, habría dado la peor combinación posible.
//   2. Con textos CORTOS —que es nuestro caso, ver SEM_BUDGET en context.js— el
//      4-bit se da la vuelta y pierde contra fp16 (2,6× más lento en líneas
//      sueltas): a esas longitudes se paga más por deshacer la cuantización que
//      lo que se ahorra en ancho de banda. Por eso fp16 y no q4f16, aunque en
//      bloques grandes q4f16 gane.
//
// De ahí la regla: fp16 si hay adaptador WebGPU de verdad, y q8/wasm como red de
// seguridad. La red de seguridad FUNCIONA pero es ~9× más lenta, hasta el punto
// de notarse en cada turno, y ése es uno de los motivos de que el lado semántico
// vaya apagado por defecto (ver context.js).
// ─────────────────────────────────────────────────────────────────────────────

import { createEmbedCache } from './acer-core.js';

export const EMBED_MODEL = {
  id: 'Xenova/multilingual-e5-small',
  dims: 384,
  label: 'multilingual-e5-small',
  // dtype → fichero → descarga
  webgpu: { dtype: 'fp16', sizeMB: 235 },
  wasm: { dtype: 'q8', sizeMB: 118 },
};

// La ventana del modelo son 512 tokens; recortar antes de tokenizar evita pagar
// el troceado de texto que el propio modelo va a descartar.
const MAX_CHARS = 2000;

// Lotes pequeños: transformers.js rellena cada lote hasta el más largo, así que
// un lote gigante hace pagar la longitud del peor elemento por todos.
const BATCH = 16;

// e5 se entrenó SIEMPRE con prefijo ('query: ' / 'passage: '), nunca con texto
// pelado. acer-core llama a la misma `embed` para la pregunta y para los
// bloques, y no hay forma de distinguirlos sin tocar el núcleo; los autores del
// modelo documentan usar 'query: ' en AMBOS lados para uso simétrico. Quitarlo
// del todo sería peor: el modelo nunca vio esa distribución.
const PREFIX = 'query: ';

let pipePromise = null;
export let backend = null;   // {device, dtype, sizeMB} una vez resuelto

/**
 * Carga PEREZOSA: nada de esto se toca en el arranque. El módulo entero se
 * importa dinámicamente desde context.js sólo cuando la bandera está encendida,
 * y el modelo no se descarga hasta la primera petición que de verdad lo use.
 */
function getPipe(onProgress) {
  if (!pipePromise) {
    pipePromise = (async () => {
      const tf = await (await import('./tf-runtime.js')).loadTransformers();
      // navigator.gpu puede EXISTIR sin adaptador real (mismo cuidado que en
      // providers/onnx.js): comprobar el adaptador, no el objeto. Elegir mal
      // aquí significa descargar 235 MB para acabar corriendo en CPU.
      let device = 'wasm';
      if (navigator.gpu) {
        try { device = (await navigator.gpu.requestAdapter()) ? 'webgpu' : 'wasm'; }
        catch { device = 'wasm'; }
      }
      const cfg = { device, ...EMBED_MODEL[device] };
      const pipe = await tf.pipeline('feature-extraction', EMBED_MODEL.id, {
        device,
        dtype: cfg.dtype,
        progress_callback: onProgress,
      });
      backend = cfg;   // sólo cuando de verdad está listo: isReady() no miente
      return pipe;
    })().catch(e => {
      pipePromise = null;   // que un fallo de red no deje el módulo muerto
      backend = null;
      throw e;
    });
  }
  return pipePromise;
}

/** Precarga opcional (p.ej. desde Ajustes) sin bloquear ningún turno. */
export function warmup(onProgress) { return getPipe(onProgress); }

/** ¿Está ya cargado? Sirve para decidir si un turno va a pagar la descarga. */
export function isReady() { return backend !== null; }

/**
 * embed(textos) → vectores normalizados de 384 dimensiones.
 * Contrato exacto que espera `packHistoryACERHybrid`: si esto lanza, acer-core
 * se va por la vía léxica sin romperse ni avisar.
 */
export async function embed(texts) {
  if (!texts || !texts.length) return [];
  const pipe = await getPipe();
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH)
      .map(t => PREFIX + String(t == null ? '' : t).slice(0, MAX_CHARS));
    const t = await pipe(batch, { pooling: 'mean', normalize: true });
    for (const v of t.tolist()) out.push(Float32Array.from(v));
  }
  return out;
}

// Caché de sesión POR CONTENIDO. No es una optimización: es lo que hace viable
// la idea. acer-core rearma los bloques desde el principio del historial en cada
// turno, así que sin caché un texto que ya se codificó en el turno 3 se volvería
// a codificar en el 4, el 5 y el 20 — el coste crecería con el CUADRADO de los
// turnos. Con caché, cada bloque se codifica una vez por sesión y un turno sólo
// paga los bloques nuevos.
// El tope es holgado a propósito: acer-core trocea el historial ENTERO en cada
// turno, así que si la caché desaloja entradas que el turno siguiente vuelve a
// pedir, se recodifica gratis. Son vectores de 384 flotantes: ~12 MB llenos.
let cache = null;
export function embedCache() {
  if (!cache) cache = createEmbedCache(embed, { max: 8000 });
  return cache;
}

/** Para diagnóstico/ajustes: cuántos textos lleva cacheados la sesión. */
export function embedCacheSize() { return cache ? cache.size() : 0; }
