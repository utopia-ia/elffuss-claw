// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
// Lo que se ve de las herramientas de medios y de los adjuntos en el chat (el mismo fichero en Claw y en Code; cada uno
// le dice dónde está su registro de mensajes con configureUi):
//   · la tarjeta de una imagen, un audio o un vídeo (progreso por etapas y Parar mientras se hace; el medio, su id y
//     el botón de descargar cuando está), también al restaurar la conversación, leída de este navegador;
//   · el «+» de la caja (Documento, Foto o vídeo, y Cámara en el móvil), los adjuntos esperando como fichas, y el
//     micrófono para una nota de voz (mantener y soltar, o tocar dos veces), escrita aquí por Whisper.
// Todo se lee y se hace en este dispositivo: nada se sube.
import { t as tr, uiLang } from './i18n.js';
import { mediaUrl, mediaKindOf, downloadName, formatBytes } from './tools/media-tools.js';
import { attachFile, docContext, mediaContext, kindOf, DOC_ACCEPT, canRecord, startRecording, toMono16k, keepVoiceNote } from './tools/attach.js';
import { AI_BASE, transcribe, CHAT } from './tools/media.js';

const $ = (id) => document.getElementById(id);
const lang = () => (uiLang() === 'es' ? 'es' : 'en');
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const ICON = {
  image: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17.5l5-4.5 4 3.5 3-2.5 4.5 3.5"/></svg>',
  audio: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
  video: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="6" width="12" height="12" rx="2"/><path d="M15.5 10.5l5-3v9l-5-3"/></svg>',
  doc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4M9 12h6M9 15.5h6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3v10H4z"/><circle cx="12" cy="13" r="3.2"/></svg>',
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};
let ui = { log: () => $('log'), append: (node) => $('log')?.appendChild(node) };
/** Dónde pinta: el registro del chat (`log()`) y cómo se añade a él (`append(node)`). Por defecto, #log. */
export function configureUi(o) { ui = { ...ui, ...o }; }
const log = () => ui.log();
const toEnd = () => { const l = log(); if (l) l.scrollTop = l.scrollHeight; };

// ---------- El medio de un id ----------
export function mediaElement(kind, id, label = '') {
  const node = kind === 'image' ? document.createElement('img') : document.createElement(kind === 'audio' ? 'audio' : 'video');
  node.className = 'media-el';
  if (kind === 'image') { node.alt = label || id; node.decoding = 'async'; } else { node.controls = true; node.preload = 'metadata'; if (kind === 'video') node.playsInline = true; }
  mediaUrl(id).then((u) => { if (u) node.src = u; else node.replaceWith(el('span', 'md-line', tr('mdGone'))); }).catch(() => {});
  return node;
}

// ---------- La tarjeta de una herramienta de medios ----------
/**
 * Pinta la tarjeta de una llamada en el chat y devuelve { progress({ text, pct }), done(result) }.
 * `onStop` es el ■ del turno: Parar aborta la tarea a través de su señal.
 */
export function mediaCard(call, { onStop = () => {} } = {}) {
  const kind = mediaKindOf(call.tool) || 'image';
  const card = el('div', 'msg media-card');
  card.dataset.tool = call.tool;
  const what = String(call.args?.prompt || call.args?.text || '').slice(0, 300);
  const head = el('div', 'md-head');
  head.insertAdjacentHTML('afterbegin', ICON[kind]);
  const kicker = el('span', 'md-kicker', tr('mdMaking_' + kind));
  head.append(kicker);
  card.append(head);
  if (what) card.append(el('b', 'md-title', what));
  const line = el('span', 'md-line md-progress', '');
  line.setAttribute('aria-live', 'polite');
  const meter = el('div', 'md-meter is-busy'); meter.append(el('i'));
  const acts = el('div', 'md-actions');
  const stop = el('button', 'ghost md-stop', tr('mdStop')); stop.type = 'button';
  stop.addEventListener('click', () => onStop());
  acts.append(stop);
  card.append(line, meter, acts);
  ui.append(card);
  toEnd();
  return {
    progress(p) {
      line.textContent = p?.text || '';
      meter.classList.toggle('is-busy', p?.pct == null);
      meter.querySelector('i').style.width = (p?.pct ?? 0) + '%';
    },
    done(r = {}) { paintDone(card, kind, what, r); },
  };
}

function paintDone(card, kind, what, r) {
  for (const n of card.querySelectorAll('.md-progress, .md-meter, .md-actions')) n.remove();
  const kicker = card.querySelector('.md-kicker');
  if (r.media) {
    card.dataset.media = r.media.id;
    kicker.textContent = `${tr('mdKind_' + r.media.kind)} · ${r.media.id}`;
    card.append(el('span', 'md-line', tr('mdHere')));
    const acts = el('div', 'md-actions');
    const a = el('a', 'md-download', '⬇ ' + tr('mdDownload'));
    a.download = downloadName(r.media);
    mediaUrl(r.media.id).then((u) => { if (u) a.href = u; else a.remove(); }).catch(() => {});
    acts.append(a);
    const fig = el('figure', 'md-media');
    fig.append(mediaElement(r.media.kind, r.media.id, what));
    card.append(acts, fig);
    toEnd();
    return;
  }
  card.classList.add('is-error');
  kicker.textContent = r.stopped ? tr('mdStopped') : r.cannot ? tr('mdCannot') : '⚠️';
  if (r.denied) card.append(el('span', 'md-line', tr('mdDeniedLine')));
  else if (!r.stopped && r.error) card.append(el('span', 'md-line', r.error));
}

/** Al restaurar la conversación: la tarjeta de un resultado de medios, con el medio leído de este navegador. */
export function restoredMediaCard(tool, text, id) {
  const kind = mediaKindOf(tool) || 'image';
  const card = el('div', 'msg media-card');
  const head = el('div', 'md-head');
  head.insertAdjacentHTML('afterbegin', ICON[kind]);
  head.append(el('span', 'md-kicker', ''));
  card.append(head);
  ui.append(card);
  if (id) paintDone(card, kind, '', { media: { id, kind, mime: '', name: id } });
  else paintDone(card, kind, '', { cannot: /no se puede|cannot be made/i.test(text), error: text });
  return card;
}

// ---------- Adjuntos en un mensaje del usuario ----------
export function attachmentsEl(attach = []) {
  const box = el('div', 'att-sent');
  for (const a of attach) {
    const card = el('div', 'att-card att-' + a.kind);
    card.dataset.media = a.id;
    if (a.kind === 'doc') {
      card.insertAdjacentHTML('afterbegin', ICON.doc);
      const body = el('div', 'att-body');
      body.append(el('b', 'att-name', a.name));
      const facts = [a.meta?.pages ? tr('docPages', { n: a.meta.pages }) : null, a.meta?.chars != null ? tr('docChars', { n: a.meta.chars }) : null,
        a.meta?.truncated ? tr('docCut', { n: a.meta.read || 0 }) : null].filter(Boolean).join(' · ');
      if (facts) body.append(el('span', 'att-line', facts));
      body.append(el('span', 'att-id', a.id));
      card.append(body);
    } else {
      if (a.source === 'voice') card.append(el('span', 'att-line', tr('voiceNote')));
      card.append(mediaElement(a.kind, a.id, a.name), el('span', 'att-id', a.id));
    }
    box.append(card);
  }
  return box;
}

/** What the model reads for the attachments of a message, and what is kept with it. */
export function attachmentContext(recs) {
  const kept = recs.map((a) => ({ id: a.id, kind: a.kind, name: a.name, mime: a.mime, source: a.source,
    meta: { ...(a.meta || {}), ...(a.kind === 'doc' ? { pages: a.pages, chars: a.chars, truncated: a.truncated, read: a.excerpt?.length || 0 } : {}) } }));
  const context = recs.map((a) => (a.kind === 'doc' ? docContext(a, lang()) : mediaContext(a, lang()))).join('\n\n');
  return { kept, context };
}

// ---------- La caja: «+», fichas y micrófono ----------
const pending = [];          // { file, rec?, error? }
let onVoice = () => {};
let changed = () => {};
export const hasReadyAttachments = () => pending.length > 0 && pending.every((p) => p.rec);
/** Lo adjuntado y listo, que sale con este mensaje (y deja la caja vacía). */
export function takeAttachments() {
  const recs = pending.filter((p) => p.rec).map((p) => p.rec);
  pending.length = 0;
  paintChips();
  return recs;
}

function paintChips() {
  const ul = $('att-chips');
  if (!ul) return;
  ul.textContent = '';
  if (rec.state) ul.append(recChip());
  for (const p of pending) {
    const li = el('li', 'att-chip' + (p.error ? ' is-error' : p.rec ? '' : ' is-reading'));
    const kind = p.rec?.kind || kindOf(p.file) || 'doc';
    li.insertAdjacentHTML('afterbegin', ICON[kind === 'pdf' || kind === 'docx' || kind === 'text' ? 'doc' : kind] || ICON.doc);
    li.append(el('span', 'att-chip-name', p.file.name || ''), el('span', 'att-chip-state', p.error || (p.rec ? p.rec.id : tr('attReading'))));
    const x = el('button', 'att-chip-x'); x.type = 'button'; x.innerHTML = ICON.x; x.setAttribute('aria-label', tr('attRemove', { name: p.file.name || '' }));
    x.addEventListener('click', () => { pending.splice(pending.indexOf(p), 1); paintChips(); });
    li.append(x);
    ul.append(li);
  }
  ul.hidden = !ul.children.length;
  changed();
}

function addFiles(files) {
  for (const file of files) {
    const p = { file, rec: null, error: null };
    pending.push(p);
    if (!kindOf(file)) { p.error = tr('attUnsupported'); continue; }
    attachFile(file, { base: AI_BASE, chat: CHAT })
      .then((r) => { p.rec = r; }, (e) => { console.warn('[claw] adjunto', e); p.error = tr('attFailed'); })
      .finally(paintChips);
  }
  paintChips();
}

// La nota de voz.
const rec = { state: null, text: '', ctl: null, at: 0, held: false, timer: null, ctlVoice: null };
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function recChip() {
  const li = el('li', 'att-chip rec-chip' + (rec.state === 'rec' ? ' is-rec' : rec.state === 'error' ? ' is-error' : ' is-reading'));
  li.insertAdjacentHTML('afterbegin', ICON.mic);
  const s = el('span', 'att-chip-name', rec.text); s.setAttribute('aria-live', 'polite');
  li.append(s);
  if (rec.state !== 'busy') {
    const x = el('button', 'att-chip-x'); x.type = 'button'; x.innerHTML = ICON.x; x.setAttribute('aria-label', tr('recCancel'));
    x.addEventListener('click', cancelRecording);
    li.append(x);
  }
  return li;
}
function setMic(on) { const b = $('mic-btn'); b?.classList.toggle('is-rec', on); b?.setAttribute('aria-pressed', String(on)); }
function cancelRecording() {
  if (rec.ctl) { rec.ctl.cancel(); clearInterval(rec.timer); rec.ctl = null; setMic(false); }
  rec.state = null; paintChips();
}
async function beginRecording() {
  try {
    rec.ctl = await startRecording();
    rec.at = performance.now(); rec.held = true;
    rec.state = 'rec'; rec.text = tr('recording', { s: '0:00' });
    rec.timer = setInterval(() => { rec.text = tr('recording', { s: clock(rec.ctl?.seconds() || 0) }); paintChips(); }, 500);
    setMic(true); paintChips();
  } catch (e) {
    console.warn('[claw] micrófono', e);
    rec.state = 'error'; rec.text = tr('micDenied'); paintChips();
  }
}
async function finishRecording() {
  const r = rec.ctl;
  if (!r) return;
  rec.ctl = null; clearInterval(rec.timer); setMic(false);
  const { blob, seconds } = await r.stop();
  if (seconds < 0.6 || !blob.size) { rec.state = null; paintChips(); return; }
  rec.state = 'busy'; rec.text = tr('transcribing'); paintChips();
  const ctl = new AbortController();
  rec.ctlVoice = ctl;
  try {
    const samples = await toMono16k(blob);
    const out = await transcribe(samples, { signal: ctl.signal, lang: lang(), language: lang(), onProgress: () => {} });
    if (out.text) {
      const voice = await keepVoiceNote(blob, seconds, { chat: CHAT, transcript: out.text });
      rec.state = null; paintChips();
      onVoice(out.text, voice);
    } else if (out.reason === 'denied') { rec.state = null; paintChips(); }
    else { rec.state = 'error'; rec.text = out.error || tr('voiceEmpty'); paintChips(); }
  } catch (e) {
    if (e?.name !== 'AbortError') console.warn('[claw] nota de voz', e);
    rec.state = e?.name === 'AbortError' ? null : 'error'; rec.text = tr('voiceEmpty'); paintChips();
  } finally { rec.ctlVoice = null; }
}

/**
 * Monta el «+», las fichas y el micrófono en la caja (#composer, #prompt). `onVoiceText(text, rec)` envía una nota de
 * voz ya escrita; `onChange()` avisa cuando cambia lo que está listo para enviar; el micrófono va delante de
 * `sendButton()` (#send por defecto).
 */
export function mountComposer({ onVoiceText = () => {}, onChange = () => {}, sendButton = () => $('send') } = {}) {
  onVoice = onVoiceText; changed = onChange;
  const form = $('composer');
  if (!form || $('att-btn')) return;
  const chips = el('ul', 'att-chips'); chips.id = 'att-chips'; chips.hidden = true;
  form.before(chips);
  const wrap = el('div', 'att-wrap');
  const btn = el('button', 'icon-btn att-btn'); btn.type = 'button'; btn.id = 'att-btn';
  btn.innerHTML = ICON.plus; btn.title = tr('attach'); btn.setAttribute('aria-label', tr('attach'));
  btn.setAttribute('aria-haspopup', 'menu'); btn.setAttribute('aria-expanded', 'false');
  const menu = el('div', 'att-menu'); menu.id = 'att-menu'; menu.setAttribute('role', 'menu'); menu.hidden = true;
  const inputs = {};
  const item = (key, icon, label, accept, capture) => {
    const b = el('button'); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.dataset.att = key;
    b.innerHTML = ICON[icon]; b.append(el('span', null, label));
    const inp = el('input'); inp.type = 'file'; inp.hidden = true; inp.id = 'att-' + key; inp.accept = accept;
    if (capture) inp.setAttribute('capture', 'environment'); else inp.multiple = true;
    inp.className = 'att-input';
    inp.addEventListener('change', () => { addFiles([...inp.files]); inp.value = ''; $('prompt')?.focus(); });
    b.addEventListener('click', () => { close(); inp.click(); });
    inputs[key] = inp;
    menu.append(b);
    return b;
  };
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  item('doc', 'doc', tr('attDoc'), DOC_ACCEPT);
  item('media', 'image', tr('attMedia'), 'image/*,video/*');
  const cam = item('camera', 'camera', tr('attCamera'), 'image/*', true);
  cam.hidden = !matchMedia('(pointer: coarse)').matches;
  btn.addEventListener('click', () => { const open = menu.hidden; menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); if (open) menu.querySelector('button:not([hidden])')?.focus(); });
  document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.att-wrap')) close(); });
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); btn.focus(); } });
  wrap.append(btn, menu, ...Object.values(inputs));
  form.prepend(wrap);
  // Una imagen pegada o soltada en la caja también es un adjunto.
  $('prompt')?.addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])]; if (f.length) { e.preventDefault(); addFiles(f); } });
  form.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  form.addEventListener('drop', (e) => { const f = [...(e.dataTransfer?.files || [])]; if (f.length) { e.preventDefault(); addFiles(f); } });
  // El micrófono, al lado de enviar.
  if (canRecord()) {
    const mic = el('button', 'icon-btn mic-btn'); mic.type = 'button'; mic.id = 'mic-btn';
    mic.innerHTML = ICON.mic; mic.title = tr('micLabel'); mic.setAttribute('aria-label', tr('micLabel')); mic.setAttribute('aria-pressed', 'false');
    mic.addEventListener('pointerdown', (e) => { if (e.button !== 0 || rec.ctlVoice) return; if (rec.ctl) { finishRecording(); return; } beginRecording(); });
    mic.addEventListener('pointerup', () => { if (!rec.ctl || !rec.held) return; rec.held = false; if (performance.now() - rec.at >= 400) finishRecording(); });
    mic.addEventListener('click', (e) => { if (e.detail !== 0 || rec.ctlVoice) return; if (rec.ctl) finishRecording(); else beginRecording().then(() => { rec.held = false; }); });
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && rec.ctl) cancelRecording(); });
    sendButton()?.before(mic);
  }
}

/** La pregunta de la descarga de un modelo de medios, en el diálogo de permisos de Claw. */
export function consentMeta(q) {
  return {
    icon: '⬇️',
    label: tr('mdConsentL', { what: tr('mdWhat_' + q.kind), size: formatBytes(q.bytes, lang()) }),
    desc: tr('mdConsentD'),
  };
}
