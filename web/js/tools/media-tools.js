// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
// The media tools of the Elffuss assistants: pictures, music, sound effects, speech and video made in this browser by
// the elffuss-ai SDK (copied by pin into <docroot>/vendor/elffuss-ai/ with ai-sync.mjs). The same file is in the chat
// (elffuss-home site-chat/chat/), Claw and Code (web/js/tools/); each product paints its own cards and asks its own
// questions through the hooks it passes to createMediaTools().
//
//   image.generate(prompt, aspect?)        TextToImage    → a PNG            id img-…
//   audio.music(prompt, seconds?)          Music          → a WAV            id aud-…
//   audio.sfx(prompt, seconds?)            Sfx            → a WAV            id aud-…
//   audio.speak(text, lang?)               Speech         → a WAV            id aud-…
//   video.animate(image, preset?, …)       Video          → an MP4 or WebM   id vid-…   (image: an img-… of the chat)
//   video.generate(prompt, seconds?)       TextToVideo    → an MP4 or WebM   id vid-…
//
// A run: estimate() first (nothing downloaded; a device that cannot run it gets the reason, never a crash), the
// product's consent for what is still to download, the chat model unloaded (the graphics memory is the task's while
// it runs; a phone tab has about 2 GB), the task, dispose(), and the chat model loaded again. The result is kept in
// this browser (IndexedDB «elffuss-media», shared by the products of one origin) under an id the model can pass back
// later. Stopping aborts through the turn's signal: the SDK ends its Worker and every GPU buffer goes with it.

const DB = 'elffuss-media';
const STORE = 'media';

// ---------- The tools, as the model reads them ----------
// Image and audio models follow English best: the description is written in English whatever the user's language,
// except speech, which reads the user's own words.
export const MEDIA_TOOL_NAMES = ['image.generate', 'audio.music', 'audio.sfx', 'audio.speak', 'video.animate', 'video.generate'];

const CATALOG = {
  en: [
    '- image.generate(prompt, aspect?): make a picture. Write `prompt` in ENGLISH (translate the user\'s request): subject, style, light, colours. aspect: "1:1", "16:9" or "9:16"',
    '- audio.music(prompt, seconds?): make music. `prompt` in ENGLISH: genre, instruments, mood, tempo. seconds 5 to 60',
    '- audio.sfx(prompt, seconds?): make a sound effect. `prompt` in ENGLISH. seconds 1 to 20',
    '- audio.speak(text, lang?): read a text aloud. `text` in the user\'s language, as it should be heard; lang "es" or "en"',
    '- video.animate(image, preset?, seconds?): turn a picture of this chat into a short video with a camera move. image: its id (img-…); preset: "dolly-in", "orbit", "swing", "zoom-pan" or "vertigo"',
    '- video.generate(prompt, seconds?): make a short video from a description. `prompt` in ENGLISH. seconds 1 to 5',
  ],
  es: [
    '- image.generate(prompt, aspect?): hacer una imagen. Escribe `prompt` en INGLÉS (traduce lo que pide el usuario): tema, estilo, luz, colores. aspect: "1:1", "16:9" o "9:16"',
    '- audio.music(prompt, seconds?): hacer música. `prompt` en INGLÉS: género, instrumentos, ánimo, tempo. seconds de 5 a 60',
    '- audio.sfx(prompt, seconds?): hacer un efecto de sonido. `prompt` en INGLÉS. seconds de 1 a 20',
    '- audio.speak(text, lang?): leer un texto en voz alta. `text` en el idioma del usuario, tal como debe sonar; lang "es" o "en"',
    '- video.animate(image, preset?, seconds?): convertir una imagen de esta conversación en un vídeo corto con movimiento de cámara. image: su id (img-…); preset: "dolly-in", "orbit", "swing", "zoom-pan" o "vertigo"',
    '- video.generate(prompt, seconds?): hacer un vídeo corto a partir de una descripción. `prompt` en INGLÉS. seconds de 1 a 5',
  ],
};

/** The tool lines for the system prompt. */
export function mediaToolLines(lang) { return CATALOG[lang === 'es' ? 'es' : 'en']; }

/** The rule that goes with them: what the ids are for. */
export function mediaRule(lang) {
  return lang === 'es'
    ? 'Las imágenes, audios y vídeos de la conversación (los que haces y los que adjunta el usuario) tienen un id como img-k3x9, aud-… o vid-…: para usar uno, pasa su id. Tras hacer uno, no lo describas entero: ya se ve en la tarjeta.'
    : 'Pictures, audio and videos in the conversation (the ones you make and the ones the user attaches) have an id like img-k3x9, aud-… or vid-…: to use one, pass its id. After making one, do not describe it at length: the card shows it.';
}

/** Other names a model may use for the same tools. */
export const MEDIA_ALIASES = {
  generate_image: 'image.generate', image_generate: 'image.generate', make_image: 'image.generate', create_image: 'image.generate',
  text_to_image: 'image.generate', 'image.create': 'image.generate', 'image.make': 'image.generate', draw: 'image.generate',
  music: 'audio.music', make_music: 'audio.music', generate_music: 'audio.music', 'audio.generate_music': 'audio.music',
  sfx: 'audio.sfx', sound_effect: 'audio.sfx', make_sound: 'audio.sfx', 'audio.sound': 'audio.sfx',
  speak: 'audio.speak', tts: 'audio.speak', text_to_speech: 'audio.speak', say: 'audio.speak', 'audio.tts': 'audio.speak',
  animate: 'video.animate', animate_image: 'video.animate', image_to_video: 'video.animate', 'image.animate': 'video.animate',
  generate_video: 'video.generate', make_video: 'video.generate', text_to_video: 'video.generate', 'video.create': 'video.generate',
};

/** The argument keys of the media tools, for parsers that read loose JSON by key. */
export const MEDIA_KEYS = ['prompt', 'text', 'image', 'aspect', 'preset', 'lang', 'size', 'voice', 'path'];

export const isMediaTool = (name) => MEDIA_TOOL_NAMES.includes(name);

// ---------- What each tool runs ----------
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? undefined : Number(v));
const clamp = (v, lo, hi) => (v == null ? undefined : Math.min(hi, Math.max(lo, v)));
const str = (v) => (v == null ? '' : String(v)).trim();
const ASPECT_OK = ['1:1', '4:3', '3:2', '16:9', '3:4', '2:3', '9:16'];
const PRESET_OK = ['dolly-in', 'orbit', 'swing', 'zoom-pan', 'vertigo'];
const VIDEO_ASPECT = { '16:9': '16:9', '9:16': '9:16', '1:1': '1:1' };
const GEN_SIZE = { '16:9': '832x480', '9:16': '480x832' };

const SPEC = {
  'image.generate': {
    module: 'text-to-image', cls: 'TextToImage', kind: 'image', prefix: 'img',
    args: (a) => ({ prompt: str(a.prompt ?? a.text ?? a.description), aspect: ASPECT_OK.includes(str(a.aspect)) ? str(a.aspect) : undefined, seed: num(a.seed) }),
    need: (o) => (o.prompt ? null : 'prompt'),
    estimate: (mod, o, env) => mod.TextToImage.estimate(env),
    exec: (task, o, _img, signal) => task.generate({ prompt: o.prompt, ...(o.aspect ? { aspect: o.aspect } : {}), ...(o.seed != null ? { seed: o.seed } : {}) }, { signal }),
  },
  'audio.music': {
    module: 'audio', cls: 'Music', kind: 'audio', prefix: 'aud',
    args: (a) => ({ prompt: str(a.prompt ?? a.text ?? a.description), seconds: clamp(num(a.seconds ?? a.duration), 5, 60) ?? 20, seed: num(a.seed) }),
    need: (o) => (o.prompt ? null : 'prompt'),
    estimate: (mod, o, env) => mod.Music.estimate(env),
    exec: (task, o, _img, signal) => task.run({ prompt: o.prompt, seconds: o.seconds, ...(o.seed != null ? { seed: o.seed } : {}) }, { signal }),
  },
  'audio.sfx': {
    module: 'audio', cls: 'Sfx', kind: 'audio', prefix: 'aud',
    args: (a) => ({ prompt: str(a.prompt ?? a.text ?? a.description), seconds: clamp(num(a.seconds ?? a.duration), 1, 20) ?? 5, seed: num(a.seed) }),
    need: (o) => (o.prompt ? null : 'prompt'),
    estimate: (mod, o, env) => mod.Sfx.estimate(env),
    exec: (task, o, _img, signal) => task.run({ prompt: o.prompt, seconds: o.seconds, ...(o.seed != null ? { seed: o.seed } : {}) }, { signal }),
  },
  'audio.speak': {
    module: 'audio', cls: 'Speech', kind: 'audio', prefix: 'aud',
    // The language of the chat when the model leaves it out: in Spanish the SDK reads with a voice from Spain.
    args: (a, lang) => ({ text: str(a.text ?? a.prompt), lang: ['es', 'en'].includes(str(a.lang)) ? str(a.lang) : lang }),
    need: (o) => (o.text ? null : 'text'),
    estimate: (mod, o, env) => mod.Speech.estimate(env),
    exec: (task, o, _img, signal) => task.run({ text: o.text, lang: o.lang }, { signal }),
  },
  'video.animate': {
    module: 'video', cls: 'Video', kind: 'video', prefix: 'vid', image: true,
    args: (a) => ({ image: str(a.image ?? a.id ?? a.media), preset: PRESET_OK.includes(str(a.preset)) ? str(a.preset) : undefined,
      seconds: clamp(num(a.seconds ?? a.duration), 2, 15), aspect: VIDEO_ASPECT[str(a.aspect)] }),
    need: () => null,
    estimate: (mod, o, env) => mod.Video.estimate({ ...env, ...(o.seconds ? { seconds: o.seconds } : {}), ...(o.aspect ? { aspect: o.aspect } : {}) }),
    exec: (task, o, img, signal) => task.run(img, { ...(o.preset ? { preset: o.preset } : {}), ...(o.seconds ? { seconds: o.seconds } : {}), ...(o.aspect ? { aspect: o.aspect } : {}), signal }),
  },
  'video.generate': {
    module: 'video-gen', cls: 'TextToVideo', kind: 'video', prefix: 'vid',
    args: (a) => ({ prompt: str(a.prompt ?? a.text ?? a.description), seconds: clamp(num(a.seconds ?? a.duration), 1, 5), size: GEN_SIZE[str(a.aspect)] || (/^\d+x\d+$/.test(str(a.size)) ? str(a.size) : undefined), seed: num(a.seed) }),
    need: (o) => (o.prompt ? null : 'prompt'),
    // video-gen's estimate is a function of the module: estimate(opts, env).
    estimate: (mod, o, env) => mod.estimate({ ...(o.seconds ? { seconds: o.seconds } : {}), ...(o.size ? { size: o.size } : {}) }, env),
    exec: (task, o, _img, signal) => task.run(null, { prompt: o.prompt, ...(o.seconds ? { seconds: o.seconds } : {}), ...(o.size ? { size: o.size } : {}), ...(o.seed != null ? { seed: o.seed } : {}), signal }),
  },
};

/** The kind of media a tool makes ('image', 'audio', 'video'). */
export const mediaKindOf = (tool) => SPEC[tool]?.kind || null;

// ---------- Words ----------
const W = {
  en: {
    needs: (k) => `Missing ${k}`,
    noImage: 'No picture to animate: make one with image.generate or ask the user to attach one, then pass its id.',
    notImage: (id) => `${id} is not a picture of this chat.`,
    stopped: 'Stopped',
    denied: 'The user did not allow the download, so nothing was made. Say so and do not try again.',
    made: { image: 'Picture', audio: 'Audio', video: 'Video' },
    done: (kind, id, extra) => `${W.en.made[kind]} ${id} made${extra ? ` (${extra})` : ''} and shown to the user, with a download button. To use it later, pass "${id}".`,
    failed: (m) => `It could not be made: ${m}`,
    reasons: {
      'webgpu-unavailable': 'this browser has no usable WebGPU', 'no-webgpu': 'this browser has no usable WebGPU', 'no-adapter': 'this browser offers no graphics adapter',
      'software-adapter': 'WebGPU only has a software adapter here', 'shader-f16': 'the graphics card lacks 16-bit shaders (shader-f16)',
      'no-shader-f16': 'the graphics card lacks 16-bit shaders (shader-f16)', memory: 'this device does not have enough memory for this model',
      'not-enough-memory': 'the graphics card does not have enough memory for this model', 'gpu-limits': 'the graphics card does not allow buffers this large',
      'buffers-too-small': 'the graphics card does not allow buffers this large', 'store-unavailable': 'the Elffuss model store does not answer right now',
      'webcodecs-unavailable': 'this browser cannot encode video (no WebCodecs)', 'offscreencanvas-unavailable': 'this browser cannot draw off screen',
      'webgl2-unavailable': 'this browser has no WebGL 2', 'device-unsupported': 'this device cannot run this model', 'no-webgpu-variant': 'this model has no WebGPU version',
      'not-in-registry': 'this model is not available yet', 'sdk-unavailable': 'the media tools did not load on this page',
    },
    cannot: (r) => `It cannot be made on this device: ${r}.`,
    stage: {
      checking: 'Checking the model…', loading: 'Loading the model…', ready: 'Model ready', done: 'Done',
      downloading: (a, b, p) => `Downloading the model · ${a} of ${b} · ${p} %`,
      encode: 'Reading the description…', step: (i, n) => `Step ${i} of ${n}`, decode: 'Decoding…', 'encode-png': 'Saving the picture…',
      depth: 'Measuring the depth…', inpaint: 'Painting behind what is near…', render: (i, n) => `Frame ${i} of ${n}`, mux: 'Writing the video file…',
      phonemes: 'Reading the text…', chunk: (i, n) => `Sentence ${i} of ${n}`, load: 'Loading the model…', download: 'Downloading the model…',
      unload: 'Freeing the graphics card…', working: 'Working…',
    },
  },
  es: {
    needs: (k) => `Falta ${k}`,
    noImage: 'No hay imagen que animar: haz una con image.generate o pide al usuario que adjunte una, y pasa su id.',
    notImage: (id) => `${id} no es una imagen de esta conversación.`,
    stopped: 'Parado',
    denied: 'El usuario no ha permitido la descarga, así que no se ha hecho nada. Dilo y no vuelvas a intentarlo.',
    made: { image: 'Imagen', audio: 'Audio', video: 'Vídeo' },
    done: (kind, id, extra) => `${W.es.made[kind]} ${id} hecho${extra ? ` (${extra})` : ''} y mostrado al usuario, con un botón para descargarlo. Para usarlo después, pasa "${id}".`,
    failed: (m) => `No se ha podido hacer: ${m}`,
    reasons: {
      'webgpu-unavailable': 'este navegador no tiene WebGPU utilizable', 'no-webgpu': 'este navegador no tiene WebGPU utilizable', 'no-adapter': 'este navegador no ofrece ningún adaptador gráfico',
      'software-adapter': 'aquí WebGPU solo tiene un adaptador por software', 'shader-f16': 'la tarjeta gráfica no admite shaders de 16 bits (shader-f16)',
      'no-shader-f16': 'la tarjeta gráfica no admite shaders de 16 bits (shader-f16)', memory: 'este dispositivo no tiene memoria suficiente para este modelo',
      'not-enough-memory': 'la tarjeta gráfica no tiene memoria suficiente para este modelo', 'gpu-limits': 'la tarjeta gráfica no permite búferes tan grandes',
      'buffers-too-small': 'la tarjeta gráfica no permite búferes tan grandes', 'store-unavailable': 'el almacén de modelos de Elffuss no responde ahora',
      'webcodecs-unavailable': 'este navegador no puede codificar vídeo (no tiene WebCodecs)', 'offscreencanvas-unavailable': 'este navegador no puede dibujar fuera de pantalla',
      'webgl2-unavailable': 'este navegador no tiene WebGL 2', 'device-unsupported': 'este dispositivo no puede ejecutar este modelo', 'no-webgpu-variant': 'este modelo no tiene versión para WebGPU',
      'not-in-registry': 'este modelo aún no está disponible', 'sdk-unavailable': 'las herramientas de imagen, audio y vídeo no han cargado en esta página',
    },
    cannot: (r) => `No se puede hacer en este dispositivo: ${r}.`,
    stage: {
      checking: 'Comprobando el modelo…', loading: 'Cargando el modelo…', ready: 'Modelo listo', done: 'Hecho',
      downloading: (a, b, p) => `Descargando el modelo · ${a} de ${b} · ${p} %`,
      encode: 'Leyendo la descripción…', step: (i, n) => `Paso ${i} de ${n}`, decode: 'Decodificando…', 'encode-png': 'Guardando la imagen…',
      depth: 'Midiendo la profundidad…', inpaint: 'Pintando lo que queda detrás…', render: (i, n) => `Fotograma ${i} de ${n}`, mux: 'Escribiendo el vídeo…',
      phonemes: 'Leyendo el texto…', chunk: (i, n) => `Frase ${i} de ${n}`, load: 'Cargando el modelo…', download: 'Descargando el modelo…',
      unload: 'Liberando la tarjeta gráfica…', working: 'Trabajando…',
    },
  },
};
const words = (lang) => W[lang === 'es' ? 'es' : 'en'];

const fmtBytes = (n, lang) => {
  const loc = lang === 'es' ? 'es-ES' : 'en-US';
  return n >= 1e9 ? new Intl.NumberFormat(loc, { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(n / 1e9) + ' GB'
    : new Intl.NumberFormat(loc, { maximumFractionDigits: 0 }).format(Math.max(1, n / 1e6)) + ' MB';
};
export { fmtBytes as formatBytes };

/**
 * One progress event of a task, in the user's words: { text, pct } (pct null when there is no measure).
 * Events: { status: checking|downloading|loading|ready|running|done, loaded, total, stage, step, steps, frame, frames, index, count, chunk, chunks }.
 */
export function progressWords(p, lang) {
  const s = words(lang).stage;
  if (!p || typeof p !== 'object') return { text: s.working, pct: null };
  if (p.phase === 'unload') return { text: s.unload, pct: null };
  if (p.status === 'downloading' && p.total) {
    const pct = Math.min(100, Math.floor((p.loaded / p.total) * 100));
    return { text: s.downloading(fmtBytes(p.loaded || 0, lang), fmtBytes(p.total, lang), pct), pct };
  }
  const st = p.stage;
  const of = (i, n) => (Number.isFinite(i) && Number.isFinite(n) && n > 0 ? [i, n] : null);
  const pair = of(p.step, p.steps) || of(p.frame, p.frames) || of(p.chunk, p.chunks) || (Number.isFinite(p.index) && p.count > 1 ? [p.index + 1, p.count] : null);
  if (p.status === 'running' && st && s[st]) {
    const v = s[st];
    if (typeof v === 'function') return pair ? { text: v(...pair), pct: Math.round((pair[0] / pair[1]) * 100) } : { text: s.working, pct: null };
    return { text: v, pct: null };
  }
  if (st && typeof s[st] === 'string') return { text: s[st], pct: null };
  if (typeof s[p.status] === 'string') return { text: s[p.status], pct: p.status === 'done' ? 100 : null };
  return { text: s.working, pct: null };
}

// ---------- The media store (IndexedDB) ----------
// The connection is forgotten when the browser closes it (Safari does it on its own: a tab asleep in the background,
// memory pressure, storage evicted; every later transaction() threw «The database connection is closing») or when
// another tab asks for a new version, and a transaction that could not start or that the browser aborted runs ONCE
// more on a new connection. An aborted transaction wrote nothing, so nothing is written twice.
let dbp = null;
const mem = new Map();          // when the browser refuses IndexedDB: this visit only
function openDb() {
  if (dbp) return dbp;
  const p = dbp = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB, 1); } catch { resolve(null); return; }
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE, { keyPath: 'id' });
      s.createIndex('chat', 'chat', { unique: false });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => { if (dbp === p) dbp = null; };
      db.onversionchange = () => { db.close(); if (dbp === p) dbp = null; };
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return p;
}
const CONNECTION_LOST = new Set(['InvalidStateError', 'AbortError', 'UnknownError']);
async function tx(mode, fn) {
  for (let retried = false; ; retried = true) {
    const p = openDb();
    const db = await p;
    if (!db) { const out = fn(null); return out && 'result' in out ? out.result : out; }
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const out = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
        t.onabort = () => reject(t.error || new Error('transaction aborted'));
      });
    } catch (e) {
      if (retried || !CONNECTION_LOST.has(e?.name)) throw e;
      if (dbp === p) dbp = null;
      try { db.close(); } catch { /* already closing */ }
    }
  }
}
const ID_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';
function newMediaId(prefix) {
  const r = crypto.getRandomValues(new Uint8Array(4));
  return prefix + '-' + [...r].map((b) => ID_CHARS[b % ID_CHARS.length]).join('');
}
export const PREFIX = { image: 'img', audio: 'aud', video: 'vid', doc: 'doc' };

/**
 * Keep a media item: { kind: image|audio|video|doc, mime, blob, name?, chat?, source: 'made'|'attached'|'voice', meta? }.
 * Returns the stored record without its blob ({ id, kind, mime, name, size, created, … }).
 */
export async function putMedia(item) {
  let id;
  for (let k = 0; k < 5; k++) { id = newMediaId(PREFIX[item.kind] || 'med'); if (!(await getMedia(id))) break; }
  const rec = { id, kind: item.kind, mime: item.mime || item.blob?.type || '', name: item.name || id, size: item.blob?.size || 0,
    created: Date.now(), chat: item.chat || null, source: item.source || 'made', meta: item.meta || {}, blob: item.blob, text: item.text };
  await tx('readwrite', (s) => (s ? s.put(rec) : (mem.set(id, rec), null)));
  const { blob, text, ...head } = rec;
  return head;
}

/** A stored media item with its blob, or null. */
export async function getMedia(id) {
  if (!id) return null;
  const r = await tx('readonly', (s) => (s ? s.get(String(id)) : { result: mem.get(String(id)) })).catch(() => null);
  return r || null;
}

/** The newest item of a kind in a chat (what a model that leaves the id out means), or null. */
export async function latestMedia(kind, chat) {
  const all = await tx('readonly', (s) => (s ? (chat ? s.index('chat').getAll(chat) : s.getAll()) : { result: [...mem.values()].filter((r) => !chat || r.chat === chat) })).catch(() => []);
  return (all || []).filter((r) => r.kind === kind).sort((a, b) => b.created - a.created)[0] || null;
}

/** Give items attached before their chat existed to that chat. */
export async function setMediaChat(ids, chat) {
  for (const id of ids || []) {
    const r = await getMedia(id);
    if (r && r.chat !== chat) { r.chat = chat; await tx('readwrite', (s) => (s ? s.put(r) : (mem.set(id, r), null))).catch(() => {}); }
  }
}

/** Remove the items of a chat (when the chat is deleted). */
export async function removeChatMedia(chat) {
  if (!chat) return;
  const all = await tx('readonly', (s) => (s ? s.index('chat').getAllKeys(chat) : { result: [...mem.values()].filter((r) => r.chat === chat).map((r) => r.id) })).catch(() => []);
  for (const id of all || []) await tx('readwrite', (s) => (s ? s.delete(id) : (mem.delete(id), null))).catch(() => {});
}

const urls = new Map();
/** An object URL of a stored item (made once per visit), or null. */
export async function mediaUrl(id) {
  if (urls.has(id)) return urls.get(id);
  const r = await getMedia(id);
  if (!r?.blob) return null;
  const u = URL.createObjectURL(r.blob);
  urls.set(id, u);
  return u;
}

/** A file name to download a stored item with. */
export function downloadName(rec) {
  const ext = /png/.test(rec.mime) ? 'png' : /jpe?g/.test(rec.mime) ? 'jpg' : /webp/.test(rec.mime) ? 'webp' : /wav/.test(rec.mime) ? 'wav'
    : /mp4/.test(rec.mime) ? 'mp4' : /webm/.test(rec.mime) ? 'webm' : /ogg/.test(rec.mime) ? 'ogg' : /mpeg/.test(rec.mime) ? 'mp3' : 'bin';
  const base = String(rec.name || rec.id).replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60) || rec.id;
  return `${base}.${ext}`;
}

// ---------- Running a tool ----------
/**
 * @param {{ base: string|URL, lang: () => 'es'|'en',
 *   unloadLlm: () => Promise<void>, reloadLlm: () => Promise<void>|void,
 *   consent: (q: { tool: string, kind: string, bytes: number, total: number }) => Promise<boolean>,
 *   load?: (module: string) => Promise<any> }} hooks
 *   `base`: the URL of vendor/elffuss-ai/ (ends with /). `load` replaces the SDK import (tests).
 */
export function createMediaTools(hooks) {
  const base = new URL(String(hooks.base), globalThis.location?.href).href;
  const mods = new Map();
  const load = hooks.load || ((m) => import(new URL(`sdk/${m}/index.js`, base).href));
  const module = (m) => { if (!mods.has(m)) { const p = load(m); p.catch(() => mods.delete(m)); mods.set(m, p); } return mods.get(m); };
  let store = null, runtime = null;
  const env = async () => {
    if (!store) store = (await import(new URL('sdk/core/store-client.js', base).href)).createStoreClient();
    if (!runtime) runtime = (await import(new URL('sdk/core/runtimes.js', base).href)).runtimeUrls({ variant: 'webgpu', base: new URL('runtimes/', base).href });
    return { store, runtime };
  };
  let busy = null;   // one media task at a time: they all want the whole graphics card

  /**
   * Run one call. Returns what the product's dispatcher returns: { text (what the model reads), result (what the card
   * shows and the chat stores), end (the turn is over), say? (what the user reads if the turn closes on it) }.
   * `onProgress({ text, pct })` paints the card while it runs. Throws an AbortError when `signal` stops it.
   */
  async function run(call, { signal, onProgress = () => {}, chat = null, lang = hooks.lang() } = {}) {
    const w = words(lang);
    const spec = SPEC[call.tool];
    if (!spec) return { text: 'ERROR: unknown tool ' + call.tool, result: { error: call.tool } };
    const o = spec.args(call.args || {}, lang);
    const summary = { tool: call.tool, ...(o.prompt ? { prompt: o.prompt.slice(0, 300) } : {}), ...(o.text ? { text: o.text.slice(0, 300) } : {}), ...(o.image ? { image: o.image } : {}) };
    const missing = spec.need(o);
    if (missing) return { text: 'ERROR: ' + w.needs(missing), result: { ...summary, error: w.needs(missing) } };
    let img = null;
    if (spec.image) {
      const rec = o.image ? await getMedia(o.image) : await latestMedia('image', chat);
      if (!rec) return { text: 'ERROR: ' + (o.image ? w.notImage(o.image) : w.noImage), result: { ...summary, error: o.image ? w.notImage(o.image) : w.noImage } };
      if (rec.kind !== 'image') return { text: 'ERROR: ' + w.notImage(rec.id), result: { ...summary, error: w.notImage(rec.id) } };
      img = rec.blob; summary.image = rec.id;
    }
    const stop = () => Object.assign(new Error('stopped'), { name: 'AbortError' });
    if (signal?.aborted) throw stop();
    while (busy) { try { await busy; } catch { /* the previous one reported its own end */ } }
    let release;
    busy = new Promise((r) => { release = r; });
    let unloaded = false, task = null;
    try {
      onProgress({ text: w.stage.checking, pct: null });
      let mod, e;
      try { mod = await module(spec.module); e = await env(); } catch (err) { console.warn('[media] the SDK did not load', err); }
      // 1. Can it run here, and what is still to download? Nothing is downloaded to know.
      let est;
      if (!mod || !e) est = { fits: false, reason: 'sdk-unavailable' };
      else try { est = await spec.estimate(mod, o, { store: e.store }); } catch (err) { est = { fits: false, reason: err?.code || 'device-unsupported' }; }
      if (!est.fits) {
        const why = w.reasons[est.reason] || est.reason || w.reasons['device-unsupported'];
        const say = w.cannot(why);
        return { text: say, say, result: { ...summary, cannot: true, reason: est.reason, error: say }, end: true };
      }
      // 2. The first time, the user agrees to what is missing.
      const toGet = est.missingBytes == null ? est.downloadBytes : est.missingBytes;
      if (toGet > 0) {
        const ok = await hooks.consent({ tool: call.tool, kind: spec.kind, bytes: toGet, total: est.downloadBytes || toGet });
        if (signal?.aborted) throw stop();
        if (!ok) return { text: w.denied, say: '', result: { ...summary, denied: true }, end: true };
      }
      // 3. The chat model leaves the graphics card to the task.
      onProgress({ text: w.stage.unload, pct: null });
      await hooks.unloadLlm();
      unloaded = true;
      if (signal?.aborted) throw stop();
      const Cls = mod[spec.cls];
      task = new Cls({ store: e.store, runtime: e.runtime, onProgress: (p) => { try { onProgress(progressWords(p, lang)); } catch { /* painting */ } } });
      let out;
      try {
        out = await spec.exec(task, o, img, signal);
      } catch (err) {
        if (signal?.aborted || err?.code === 'aborted' || err?.name === 'AbortError') throw stop();
        const m = err?.message || String(err);
        return { text: 'ERROR: ' + w.failed(m), say: w.failed(m), result: { ...summary, error: w.failed(m) }, end: true };
      }
      // 4. Kept in this browser, under an id the model can pass back.
      const mime = out.mime || out.blob?.type || (spec.kind === 'image' ? 'image/png' : spec.kind === 'audio' ? 'audio/wav' : 'video/mp4');
      const meta = { width: out.width, height: out.height, seconds: out.seconds, seed: out.seed, model: out.model, prompt: o.prompt || o.text };
      const rec = await putMedia({ kind: spec.kind, mime, blob: out.blob, chat, source: 'made', name: (o.prompt || o.text || '').slice(0, 60), meta });
      const extra = out.width && out.height ? `${out.width}×${out.height}${out.seconds ? `, ${Math.round(out.seconds * 10) / 10} s` : ''}` : out.seconds ? `${Math.round(out.seconds * 10) / 10} s` : '';
      onProgress({ text: w.stage.done, pct: 100 });
      return { text: w.done(spec.kind, rec.id, extra), result: { ...summary, media: { id: rec.id, kind: rec.kind, mime: rec.mime, name: rec.name, width: out.width, height: out.height, seconds: out.seconds } }, end: true };
    } finally {
      // 5. Everything the task held goes, and the chat model comes back.
      try { await task?.dispose(); } catch { /* releasing */ }
      release(); busy = null;
      // Not awaited: the card is the answer and shows at once; the model loads again meanwhile (from this browser).
      if (unloaded) Promise.resolve().then(() => hooks.reloadLlm()).catch(() => { /* the next message loads it */ });
    }
  }

  /**
   * Write down a voice note in this browser (Whisper, vendor/elffuss-asr/ next to the SDK copy). `samples`: mono at
   * 16 kHz. The language is always given (Whisper without one writes English). The first time, the product's consent
   * for the download (kind 'voice'). On a phone the chat model steps aside while it runs, as for the media tasks.
   * Returns { text } or { error, reason }; throws an AbortError when `signal` stops it.
   */
  async function transcribe(samples, { signal, onProgress = () => {}, lang = hooks.lang(), language = lang } = {}) {
    const w = words(lang);
    const stop = () => Object.assign(new Error('stopped'), { name: 'AbortError' });
    while (busy) { try { await busy; } catch { /* the previous one reported its own end */ } }
    let release;
    busy = new Promise((r) => { release = r; });
    let unloaded = false, task = null;
    try {
      let mod, e;
      try { mod = await (hooks.loadAsr || ((u) => import(u)))(new URL('../elffuss-asr/index.js', base).href); e = await env(); } catch (err) { console.warn('[media] speech-to-text did not load', err); }
      if (!mod || !e) return { error: w.cannot(w.reasons['sdk-unavailable']), reason: 'sdk-unavailable' };
      const est = await mod.SpeechToText.estimate({ store: e.store }).catch(() => ({ fits: false, reason: 'device-unsupported' }));
      if (!est.fits) return { error: w.cannot(w.reasons[est.reason] || est.reason), reason: est.reason };
      const toGet = est.missingBytes == null ? est.downloadBytes : est.missingBytes;
      if (toGet > 0) {
        const ok = await hooks.consent({ tool: 'voice', kind: 'voice', bytes: toGet, total: est.downloadBytes || toGet });
        if (signal?.aborted) throw stop();
        if (!ok) return { error: '', reason: 'denied' };
      }
      if (globalThis.matchMedia?.('(pointer: coarse)').matches) { await hooks.unloadLlm(); unloaded = true; }
      task = new mod.SpeechToText({ store: e.store, runtime: e.runtime, registry: await mod.registry(), onProgress: (p) => { try { onProgress(progressWords(p, lang)); } catch { /* painting */ } } });
      try {
        const out = await task.run(samples, { language, signal });
        return { text: String(out?.text || '').trim() };
      } catch (err) {
        if (signal?.aborted || err?.code === 'aborted') throw stop();
        return { error: w.failed(err?.message || String(err)), reason: 'run-failed' };
      }
    } finally {
      try { await task?.dispose(); } catch { /* releasing */ }
      release(); busy = null;
      if (unloaded) Promise.resolve().then(() => hooks.reloadLlm()).catch(() => {});
    }
  }

  return { run, transcribe, base, isMediaTool, lines: mediaToolLines, rule: mediaRule };
}
