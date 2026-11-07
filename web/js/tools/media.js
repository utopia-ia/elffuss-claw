// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
// Las herramientas de imagen, audio y vídeo en Claw: el módulo común (media-tools.js, el mismo fichero que el chat de
// elffuss.com y Code) con lo que pone Claw alrededor. El SDK de elffuss-ai está copiado por pin en
// web/vendor/elffuss-ai/ (ai-sync.mjs); va bajo /vendor/ porque el SDK solo arranca Workers desde ahí.
//
// Lo que pone el kernel (configureMedia): soltar el cerebro de la gráfica mientras corre la tarea y volver a cargarlo
// después, la pregunta de la descarga (el diálogo de permisos de Claw) y la tarjeta del chat (ui.addMediaCard), con su
// progreso por etapas y su botón Parar, que aborta el turno.
import { createMediaTools, isMediaTool, MEDIA_TOOL_NAMES, MEDIA_ALIASES, mediaToolLines } from './media-tools.js';

export { isMediaTool, MEDIA_TOOL_NAMES, MEDIA_ALIASES };

let hooks = {
  lang: () => ((typeof navigator !== 'undefined' && navigator.language) || 'es').slice(0, 2) === 'es' ? 'es' : 'en',
  unloadLlm: async () => {},
  reloadLlm: async () => {},
  consent: async () => false,
  card: () => ({ progress() {}, done() {} }),
};
export function configureMedia(h) { hooks = { ...hooks, ...h }; }

/** La URL de vendor/elffuss-ai/ de esta web. */
export const AI_BASE = new URL('../../vendor/elffuss-ai/', import.meta.url);

const media = createMediaTools({
  base: AI_BASE,
  lang: () => hooks.lang(),
  unloadLlm: () => hooks.unloadLlm(),
  reloadLlm: () => hooks.reloadLlm(),
  consent: (q) => hooks.consent(q),
});
export const transcribe = (samples, opts) => media.transcribe(samples, opts);

// El catálogo de Claw en su forma (TOOLS: desc + params), sacado de las mismas líneas que lee el chat.
export function mediaToolEntries(lang = 'es') {
  const out = {};
  for (const line of mediaToolLines(lang)) {
    const m = /^- ([\w.]+)\(([^)]*)\): (.*)$/.exec(line);
    if (!m) continue;
    const params = Object.fromEntries(m[2].split(',').map((p) => p.trim().replace(/\?$/, '')).filter(Boolean).map((p) => [p, '']));
    out[m[1]] = { desc: m[3], params, run: (a, ctx) => runMedia(m[1], a, ctx) };
  }
  return out;
}

/**
 * Una llamada: la tarjeta en el chat, el progreso por etapas, y lo que lee el modelo (texto; «ERROR: …» si falta algo
 * que el modelo puede arreglar). Parar el turno (ctx.signal) aborta la tarea.
 */
export async function runMedia(tool, args = {}, ctx = {}) {
  const card = hooks.card({ tool, args });
  try {
    const r = await media.run({ tool, args }, { signal: ctx.signal, chat: 'claw', lang: hooks.lang(), onProgress: (p) => card.progress(p) });
    card.done(r.result);
    if (r.result?.error && !r.end) return 'ERROR: ' + r.result.error;
    return r.text;
  } catch (e) {
    card.done({ ...(args || {}), tool, error: e?.name === 'AbortError' ? 'stopped' : (e?.message || String(e)), stopped: e?.name === 'AbortError' });
    throw e;
  }
}

/** El id de medio que nombra un resultado («Imagen img-k3x9 hecha…»), para repintar su tarjeta al restaurar. */
export const mediaIdIn = (text) => /\b(?:img|aud|vid)-[a-z2-9]{4}\b/.exec(String(text || ''))?.[0] || null;
