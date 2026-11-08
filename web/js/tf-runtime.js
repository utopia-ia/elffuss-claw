// Transformers.js for the ONNX chat models (providers/onnx.js) and the embeddings (embed.js), served from this origin
// and pinned (web/vendor/third-party/PIN.json, third-party.mjs). Before, both imported
// cdn.jsdelivr.net/npm/@huggingface/transformers@4, whatever 4.x was latest, and ONNX Runtime then fetched its
// WebAssembly from the same CDN. The copy here is the exact file that URL served (4.3.2, dist/transformers.min.js,
// with ONNX Runtime's JavaScript bundled in) and the WebAssembly of the exact ONNX Runtime build it names
// (1.31.0-dev.20260914-8d85527a0). Nothing third-party is loaded from another origin (Elffuss Link spec §4.4).
//
// Not the media SDK's copy (web/vendor/elffuss-ai/runtimes/): that one pins ONNX Runtime 1.30.0, whose WebAssembly
// backend has no kernel for an operator the ONNX chat model uses (GatherBlockQuantized), and the SDK sets its own
// Transformers.js up for its media models. Each keeps its own.
const TF = new URL('../vendor/third-party/@huggingface/transformers@4.3.2/dist/transformers.min.js', import.meta.url).href;
const ORT = new URL('../vendor/third-party/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/', import.meta.url).href;
let cargando = null;

export function loadTransformers() {
  cargando ||= (async () => {
    const tf = await import(TF);
    const wasm = tf.env?.backends?.onnx?.wasm;
    if (wasm) wasm.wasmPaths = ORT;
    return tf;
  })();
  cargando.catch(() => { cargando = null; });
  return cargando;
}
