// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
// What the user attaches to a message, read in this browser and never sent anywhere: documents (PDF, Word, text and
// code files) become text the model reads with the message; photos and videos are kept as media (media-tools.js) with
// an id the media tools take (video.animate {image: "img-…"}); a voice note is recorded here and written down by
// Whisper running in this browser (asr.js). The same file is in the chat, Claw and Code.
//
// PDF text comes from PDF.js and Word text from the document's own XML, both pinned with the SDK copy
// (vendor/elffuss-ai/, ai-sync.mjs). Nothing here uploads, and a file the browser cannot read says so.

import { putMedia, describedLine } from './media-tools.js';

/** How much of a document the model reads with the message (characters); the rest is cut and the card says so. */
export const DOC_BUDGET = 8000;
/** Largest file read at all. */
export const MAX_FILE = 50 * 1024 * 1024;

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|php|sh|zsh|bash|sql|ya?ml|toml|ini|cfg|conf|log|srt|vtt|tex|rst|org|env|gitignore|dockerfile)$/i;
const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|x-sh|sql|csv))/i;
export const DOC_ACCEPT = '.pdf,.docx,.txt,.md,.markdown,.csv,.tsv,.json,.xml,.html,.htm,.yaml,.yml,.log,.srt,.vtt,.js,.ts,.py,.css,.sql,.sh,application/pdf,text/*';
export const MEDIA_ACCEPT = 'image/*,video/*';

export function kindOf(file) {
  const n = String(file?.name || '').toLowerCase(), t = String(file?.type || '').toLowerCase();
  if (t.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif|heic)$/.test(n)) return 'image';
  if (t.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/.test(n)) return 'video';
  if (t.startsWith('audio/') || /\.(wav|mp3|ogg|m4a|opus|flac)$/.test(n)) return 'audio';
  if (t === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (n.endsWith('.docx') || t === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (TEXT_EXT.test(n) || TEXT_MIME.test(t)) return 'text';
  return null;
}

const errorOf = (code, message) => Object.assign(new Error(message), { code });

// ---------- Documents ----------
let pdfjs = null;
async function loadPdfjs(base) {
  if (pdfjs) return pdfjs;
  const root = new URL('runtimes/pdfjs-dist@6.4.299/', base).href;
  pdfjs = (async () => {
    const lib = await import(root + 'build/pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = root + 'build/pdf.worker.min.mjs';
    return { lib, cMapUrl: root + 'cmaps/' };
  })();
  pdfjs.catch(() => { pdfjs = null; });
  return pdfjs;
}

async function pdfText(file, base, signal) {
  const { lib, cMapUrl } = await loadPdfjs(base);
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), cMapUrl, cMapPacked: true, isEvalSupported: false, useSystemFonts: false, disableFontFace: true }).promise;
  const pages = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      if (signal?.aborted) throw errorOf('aborted', 'stopped');
      const tc = await (await doc.getPage(i)).getTextContent();
      let s = '';
      for (const it of tc.items) s += (it.str || '') + (it.hasEOL ? '\n' : '');
      pages.push(s.replace(/[ \t]+\n/g, '\n').trim());
      if (pages.join('\n\n').length > DOC_BUDGET * 4) break;   // enough to fill the budget; the rest is not read
    }
    return { text: pages.map((p, i) => (doc.numPages > 1 ? `[page ${i + 1}]\n${p}` : p)).join('\n\n'), pages: doc.numPages };
  } finally { try { await doc.destroy(); } catch { /* gone */ } }
}

// A ZIP entry, inflated with the browser's own DecompressionStream (DOCX parts are deflated).
async function zipEntry(bytes, wanted) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw errorOf('decode-failed', 'not a ZIP file');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extra = dv.getUint16(p + 30, true), comment = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (name === wanted) {
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + csize);
      if (method === 0) return data;
      if (method !== 8) throw errorOf('unsupported-format', 'compression method ' + method);
      const out = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
      return new Uint8Array(out);
    }
    p += 46 + nameLen + extra + comment;
  }
  return null;
}

async function docxText(file) {
  const xml = await zipEntry(new Uint8Array(await file.arrayBuffer()), 'word/document.xml');
  if (!xml) throw errorOf('decode-failed', 'no word/document.xml');
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(xml), 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const out = [];
  for (const p of doc.getElementsByTagNameNS(W, 'p')) {
    let s = '';
    for (const el of p.getElementsByTagNameNS(W, '*')) {
      if (el.localName === 't') s += el.textContent;
      else if (el.localName === 'tab') s += '\t';
      else if (el.localName === 'br' || el.localName === 'cr') s += '\n';
    }
    out.push(s);
  }
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), pages: null };
}

async function plainText(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (/\.html?$/i.test(file.name) || /html/.test(file.type)) text = new DOMParser().parseFromString(text, 'text/html').body?.innerText || text;
  return { text: text.replace(/\r\n/g, '\n'), pages: null };
}

/**
 * Read a document in this browser. Returns { kind: 'doc', name, mime, text (whole), pages, chars, truncated, excerpt }
 * where `excerpt` is what the model reads (at most DOC_BUDGET characters).
 * @param {File} file
 * @param {{ base: string|URL, signal?: AbortSignal }} opts `base`: the URL of vendor/elffuss-ai/
 */
export async function readDocument(file, { base, signal } = {}) {
  if (file.size > MAX_FILE) throw errorOf('too-large', 'file too large');
  const k = kindOf(file);
  const r = k === 'pdf' ? await pdfText(file, new URL(String(base), location.href).href, signal)
    : k === 'docx' ? await docxText(file)
    : k === 'text' ? await plainText(file)
    : null;
  if (!r) throw errorOf('unsupported-format', 'not a document this browser can read');
  const text = r.text.replace(/\u0000/g, '').trim();
  const truncated = text.length > DOC_BUDGET;
  return { kind: 'doc', name: file.name, mime: file.type || '', text, pages: r.pages, chars: text.length, truncated, excerpt: truncated ? text.slice(0, DOC_BUDGET) : text };
}

/** The block the model reads with the message for a document. */
export function docContext(rec, lang) {
  const es = lang === 'es';
  const head = es ? `[documento ${rec.id} «${rec.name}»${rec.pages ? `, ${rec.pages} páginas` : ''}${rec.truncated ? `, solo los primeros ${rec.excerpt.length} de ${rec.chars} caracteres` : ''}]`
    : `[document ${rec.id} "${rec.name}"${rec.pages ? `, ${rec.pages} pages` : ''}${rec.truncated ? `, only the first ${rec.excerpt.length} of ${rec.chars} characters` : ''}]`;
  return `${head}\n${rec.excerpt}\n${es ? '[fin del documento]' : '[end of document]'}`;
}

/** The line the model reads for a photo, a video or a voice note. */
export function mediaContext(rec, lang) {
  const es = lang === 'es';
  const m = rec.meta || {};
  const size = m.width && m.height ? `${m.width}×${m.height}` : '';
  const secs = m.seconds ? `${Math.round(m.seconds)} s` : '';
  if (rec.source === 'voice') return es ? `[nota de voz ${rec.id}${secs ? ` (${secs})` : ''}, escrita en este dispositivo: es el mensaje del usuario]` : `[voice note ${rec.id}${secs ? ` (${secs})` : ''}, written down on this device: it is the user's message]`;
  const what = es ? { image: 'foto', video: 'vídeo', audio: 'audio' }[rec.kind] : { image: 'photo', video: 'video', audio: 'audio' }[rec.kind];
  // Nothing here says what to do with it (it used to end «To animate it: video.animate…», and a photo sent alone got
  // animated) or that it cannot be seen: what a picture shows comes on its own line once it is looked at
  // (media-tools.js describedLine).
  const seen = rec.kind === 'image' ? describedLine(rec, lang) : null;
  // A picture not looked at yet says how to look (the chat looks before answering and takes this note away).
  const unseen = rec.kind === 'image' && !seen ? (es ? ` (sin mirar todavía: para saber qué muestra, image.describe con image "${rec.id}")` : ` (not looked at yet: to know what it shows, image.describe with image "${rec.id}")`) : '';
  return `[${es ? 'adjunto' : 'attached'} ${what} ${rec.id}${[size, secs].filter(Boolean).length ? ` (${[size, secs].filter(Boolean).join(', ')})` : ''}]${unseen}${seen ? '\n' + seen : ''}`;
}

async function imageMeta(file) {
  try { const b = await createImageBitmap(file); const m = { width: b.width, height: b.height }; b.close?.(); return m; } catch { return {}; }
}
function videoMeta(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = (m) => { URL.revokeObjectURL(url); resolve(m); };
    v.preload = 'metadata'; v.muted = true;
    v.onloadedmetadata = () => done({ width: v.videoWidth, height: v.videoHeight, seconds: Number.isFinite(v.duration) ? v.duration : undefined });
    v.onerror = () => done({});
    setTimeout(() => done({}), 4000);
    v.src = url;
  });
}

/**
 * Keep an attached file: a photo or video as media, a document read into text. Returns the stored record (without the
 * blob) plus, for documents, `excerpt`, `pages`, `chars`, `truncated`.
 */
export async function attachFile(file, { base, chat = null, signal } = {}) {
  const k = kindOf(file);
  if (!k) throw errorOf('unsupported-format', 'unsupported file');
  if (file.size > MAX_FILE) throw errorOf('too-large', 'file too large');
  if (k === 'image' || k === 'video' || k === 'audio') {
    const meta = k === 'image' ? await imageMeta(file) : await videoMeta(file);
    return putMedia({ kind: k, mime: file.type, blob: file, name: file.name, chat, source: 'attached', meta });
  }
  const d = await readDocument(file, { base, signal });
  const rec = await putMedia({ kind: 'doc', mime: d.mime, blob: file, name: d.name, chat, source: 'attached', text: d.text,
    meta: { pages: d.pages, chars: d.chars, truncated: d.truncated } });
  return { ...rec, excerpt: d.excerpt, pages: d.pages, chars: d.chars, truncated: d.truncated };
}

// ---------- Voice notes ----------
/** True where the browser can record from a microphone. */
export const canRecord = () => !!(globalThis.navigator?.mediaDevices?.getUserMedia && globalThis.MediaRecorder);

/**
 * Start recording from the microphone. Returns { stop(): Promise<{ blob, seconds }>, cancel(), seconds() }.
 * The microphone is released as soon as the note ends.
 */
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  const t0 = performance.now();
  const ended = new Promise((resolve) => { rec.onstop = resolve; });
  const free = () => stream.getTracks().forEach((t) => t.stop());
  rec.start(250);
  return {
    seconds: () => (performance.now() - t0) / 1000,
    async stop() {
      const seconds = (performance.now() - t0) / 1000;
      if (rec.state !== 'inactive') rec.stop();
      await ended;
      free();
      return { blob: new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' }), seconds };
    },
    cancel() { try { if (rec.state !== 'inactive') rec.stop(); } catch { /* gone */ } free(); },
  };
}

/** The samples of a recording, mono at 16 kHz (what Whisper reads). */
export async function toMono16k(blob) {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  const ac = new Ctx();
  try {
    const buf = await ac.decodeAudioData(await blob.arrayBuffer());
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(buf.duration * 16000)), 16000);
    const src = off.createBufferSource();
    src.buffer = buf; src.connect(off.destination); src.start();
    return (await off.startRendering()).getChannelData(0);
  } finally { try { await ac.close(); } catch { /* closed */ } }
}

/** Keep a voice note as media (an aud- id, source 'voice'). */
export function keepVoiceNote(blob, seconds, { chat = null, transcript = '' } = {}) {
  return putMedia({ kind: 'audio', mime: blob.type, blob, name: 'voice', chat, source: 'voice', text: transcript, meta: { seconds } });
}
