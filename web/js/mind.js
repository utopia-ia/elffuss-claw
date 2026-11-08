// Vista «Mente de Elffuss» — el pensamiento subyacente del cerebro CEO en un
// mundo 3D de fantasía psicodélica trance, con la CIUDAD real del proyecto
// (motor VibeCodeViewer) flotando por debajo.
//  · cada línea/tool-call que llega nace como una ESTRELLA de texto (color por
//    PERFIL, tamaño/tipografía según lo que ocurre) que se desvanece sola.
//  · los perfiles (nombre, foco, color) se editan desde ⚙ — el usuario los crea
//    a su gusto.
//  · «≡ historial»: panel con TODO lo que ha llegado, sin recortar.
//  · cuando lee/escribe un fichero real, un haz baja hasta él en la ciudad.
//  · overlay PERSISTENTE (música/animación no reinician al salir y volver).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as ceo from './ceo.js';
import * as mindLog from './mind-log.js';
import { abrirModal } from './modal.js';
import { renderMarkdown } from './md.js';
import { t } from './i18n.js';

const SOUNDCLOUD = 'https://soundcloud.com/dekel-official/dekel-baoba-festival-2023';

// El reproductor de SoundCloud se maneja con su protocolo de postMessage (el que
// usa su api.js: un JSON {method, value} al iframe), sin cargar su api.js: es
// código de terceros y la página no ejecuta ninguno (web/vendor/third-party/).
// Solo hacen falta play y pause.
const SC_ORIGIN = 'https://w.soundcloud.com';
function scWidget(iframe) {
  const call = (method) => { try { iframe.contentWindow?.postMessage(JSON.stringify({ method }), SC_ORIGIN); } catch { /* — */ } };
  return { play: () => call('play'), pause: () => call('pause') };
}
const CEO_COLOR = '#ff4d8d';

let open = false, built = false, raf = null;
let overlay, S, widget, onOpenFile = () => {}, onExecute = () => {};
let etiquetaAbrir = null;                      // texto del botón que abre el fichero de una propuesta
let cerrarModal = null;                        // devuelve el foco y la página de detrás (modal.js)
let musicaPuesta = false;                      // la música es opcional: solo suena si la pides
let pintarPlayStop = () => {};
let logMontado = false;
// Ciudad de fondo (vista real del workspace) y semilla de pensamientos previos:
// AMBOS opcionales e inyectados por la app anfitriona — Code tiene un motor
// VibeCodeViewer sobre su proyecto único; Claw (v1) no lo ofrece y la Mente
// funciona igual de bien sin ciudad de fondo.
let loadThoughts = async () => [];             // () => [{path, md}]
let buildCityFn = null;                        // (scene) => {cityWrap, cityCity, cityModel} | null
// Dónde escribe el cerebro, dicho con el nombre de verdad: «dentro del proyecto»
// es cosa de Code; en Claw es la primera carpeta autorizada. () => Promise<texto>
let etiquetaAlma = async () => t('mindSoulDir');
// Por qué no puede pensar ahora mismo (sin modelo, sin carpeta…), o null.
let motivoNoPensar = async () => null;
export function init({ loadThoughts: lt, buildCity: bc, etiquetaAlma: ea, motivoNoPensar: mn } = {}) {
  if (lt) loadThoughts = lt;
  if (bc) buildCityFn = bc;
  if (ea) etiquetaAlma = ea;
  if (mn) motivoNoPensar = mn;
}
let anchorMap = new Map();     // id de perfil (+ 'ceo') → Vector3 (anclas del mundo)
const anchors = [];            // { el, pos } — solo etiquetas de propuestas forjadas
let nodesGroup, thoughtNodes = [];
let starGroup, stars = [];     // estrellas de pensamiento efímeras
let cityWrap = null, cityCity = null, cityModel = null;
let beams = [], fileActivity = [];

export function isOpen() { return open; }
// `etiqueta`: cómo se llama el botón en ESTA app. «Abrir en el editor» es de
// Code; Claw no tiene editor y lee el fichero en el chat.
export function setOpenFile(fn, { etiqueta = null } = {}) { onOpenFile = fn; etiquetaAbrir = etiqueta; }
// `fn(md)` devuelve false si no la ejecutó (p. ej. sin modelo): el panel de la
// propuesta se queda abierto en vez de cerrarse como si hubiera arrancado.
export function setExecuteProposal(fn) { onExecute = fn; }
// En Básico el panel de la propuesta no enseña «Ejecutar» (lo esconde el CSS con
// body.modo-basico) sino que hace falta un modelo, con un botón que lleva a
// elegirlo: lo que haga ese botón lo pone la app anfitriona.
let onElegirModelo = null;
export function setElegirModelo(fn) { onElegirModelo = fn; }
// Lo que hace la app anfitriona al cerrarse la Mente (Claw devuelve la URL a la
// pestaña de debajo: ver kernel.js).
let onCerrar = () => {};
export function alCerrar(fn) { onCerrar = typeof fn === 'function' ? fn : () => {}; }

const escHtml = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const profileOf = channel => channel === 'ceo'
  ? { id: 'ceo', name: 'CEO', color: CEO_COLOR }
  : ceo.getProfiles().find(p => p.id === channel) || { id: channel, name: channel, color: '#7c5cff' };

// ── música: SOLO si la pides ────────────────────────────────────────────────
// Antes, abrir la Mente incrustaba el reproductor de SoundCloud con autoplay y
// cargaba su api.js: una página de un tercero contactada sin pedirlo, en una
// app que promete que nada sale de tu máquina. Ahora hay un botón; hasta que lo
// pulsas no se carga nada de fuera, y hay un enlace normal a la pista.
function wireMusic(root) {
  const btn = root.querySelector('#mind-music-btn');
  const pintar = () => {
    btn.textContent = musicaPuesta ? t('mindMusicOff') : t('mindMusicOn');
    btn.setAttribute('aria-pressed', musicaPuesta ? 'true' : 'false');
  };
  btn.onclick = () => {
    musicaPuesta = !musicaPuesta;
    if (musicaPuesta) mountMusic(root); else unmountMusic(root);
    pintar();
  };
  pintar();
}
function mountMusic(root) {
  if (root.querySelector('.mind-music')) return;
  const wrap = document.createElement('div');
  wrap.className = 'mind-music';
  const url = 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(SOUNDCLOUD) +
    '&auto_play=true&hide_related=true&show_comments=false&show_user=false&show_reposts=false&visual=false&color=%23ff4d8d';
  wrap.innerHTML = '<iframe id="mind-sc" title="' + escHtml(t('mindMusicT')) + '" width="100%" height="120" frameborder="no" allow="autoplay; encrypted-media" src="' + url + '"></iframe>' +
    '<div class="mind-music-cap">▶ Dekel · Baoba Festival — <a href="' + SOUNDCLOUD + '" target="_blank" rel="noopener noreferrer">SoundCloud ↗</a></div>';
  root.appendChild(wrap);
  const iframe = wrap.querySelector('#mind-sc');
  widget = scWidget(iframe);
}
function unmountMusic(root) {
  try { widget?.pause(); } catch { /* — */ }
  widget = null;
  root.querySelector('.mind-music')?.remove();
}

// ══ ESTRELLAS de pensamiento: cada línea/tool-call nace, brilla y se apaga ══
function makeTextSprite(text, color, { fontSize = 16, bold = false, glow = 10 } = {}) {
  const pad = 8;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `${bold ? 700 : 500} ${fontSize}px ui-monospace, Menlo, monospace`;
  const w = Math.ceil(probe.measureText(text).width) + pad * 2;
  const h = fontSize + pad * 2;
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.font = `${bold ? 700 : 500} ${fontSize}px ui-monospace, Menlo, monospace`;
  g.textBaseline = 'middle';
  g.shadowColor = color; g.shadowBlur = glow;
  g.fillStyle = color;
  g.fillText(text, pad, h / 2 + 1);
  const tex = new THREE.CanvasTexture(cv);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const sprite = new THREE.Sprite(mat);
  const scale = 0.09;
  sprite.scale.set(w * scale, h * scale, 1);
  return sprite;
}

// kind: 'line' (charla normal) · 'tool' (tool-call) · 'event' (ciclo/estado) · 'built' (propuesta forjada)
const KIND_STYLE = {
  line: { fontSize: 13, bold: false, glow: 8, life: 6, jitter: 15 },
  tool: { fontSize: 17, bold: true, glow: 16, life: 9, jitter: 9 },
  event: { fontSize: 20, bold: true, glow: 14, life: 7, jitter: 6 },
  built: { fontSize: 26, bold: true, glow: 22, life: 13, jitter: 4 },
};
function spawnStar(channel, text, kind = 'line') {
  if (!starGroup || !text) return;
  const prof = profileOf(channel);
  const st = KIND_STYLE[kind] || KIND_STYLE.line;
  const anchor = anchorMap.get(prof.id) || new THREE.Vector3(0, 20, 0);
  const j = st.jitter;
  const label = kind === 'tool' ? '⟐ ' + text : kind === 'event' ? '★ ' + text : kind === 'built' ? '✦ ' + text : text;
  const sprite = makeTextSprite(label.slice(0, kind === 'line' ? 52 : 72), prof.color, st);
  sprite.position.copy(anchor).add(new THREE.Vector3((Math.random() - 0.5) * j, (Math.random() - 0.5) * j * 0.6, (Math.random() - 0.5) * j));
  sprite.material.opacity = 0;
  starGroup.add(sprite);
  stars.push({ obj: sprite, born: elapsed, life: st.life, seed: Math.random() * 1000, up: kind === 'built' ? 0.5 : 0.22 });
  if (stars.length > 160) { const old = stars.shift(); starGroup.remove(old.obj); old.obj.material.map.dispose(); old.obj.material.dispose(); }
}

// ── historial COMPLETO (todo lo que llega, sin recortar) ────────────────────
// Lo lleva mind-log.js, con la Mente abierta o cerrada; aquí solo se pinta.
const LOG_CAP = 500;
function renderLogRow({ channel, text, path }) {
  const body = document.getElementById('mind-log-body');
  if (!body) return;
  const prof = profileOf(channel);
  const row = document.createElement('div');
  row.className = 'ml-row';
  row.innerHTML = `<span class="ml-dot" style="background:${prof.color}"></span><b style="color:${prof.color}">${escHtml(prof.name)}</b> <span class="ml-t">${escHtml(text)}</span>`;
  // Una propuesta guardada se puede abrir desde su línea (antes la ruta era
  // texto suelto).
  if (path) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ml-open';
    b.textContent = t('mindOpenProposal');
    b.title = path;
    b.onclick = () => mostrarPropuesta(path);
    row.appendChild(b);
  }
  body.appendChild(row);
  while (body.children.length > LOG_CAP) body.removeChild(body.firstChild);
  body.scrollTop = body.scrollHeight;
}
mindLog.suscribir(l => {
  if (logMontado) renderLogRow(l);
  if (open && l.estrella) spawnStar(l.channel, l.estrella[1], l.estrella[0]);
});

// Último «no puedo» del cerebro (sin modelo, otra pestaña lo lleva…): el panel
// ⚙ lo enseña cuando «Pensar ahora» no arranca, en vez de cerrarse sin más.
let ultimoAviso = '';

// ceo.js → aquí. El historial se apunta SIEMPRE (mind-log.js); lo que solo se
// dibuja —nodos, haces, perfiles— necesita el mundo montado.
export function pushThought(channel, ev) {
  if (!ev) return;
  mindLog.registrar(channel, ev);
  if (channel === 'sys') { pintarPlayStop(); return; }
  if (channel === 'ceo' && ev.type === 'paused') ultimoAviso = ev.text || '';
  if (channel === 'ceo' && ev.type === 'built') forjadaAhora = true;
  if (!built) return;
  if (channel === 'ceo') {
    if (ev.type === 'reprogram' && ev.profiles) rebuildWorld();
    else if (ev.type === 'built') addThoughtNode(ev);
    return;
  }
  if (open && ev.type === 'tool' && ev.path) fileBeam(ev.path, /escrib/i.test(ev.text) ? 'write' : 'read');
}

// ── nodos de pensamiento clicables (cada .md forjado = un punto brillante) ──
function addThoughtNode({ path, md, text }) {
  if (!nodesGroup) return;
  const i = thoughtNodes.length;
  const a = i * 2.399963; // ángulo áureo
  const r = 30 + i * 5;
  const mesh = new THREE.Mesh(
    new THREE.IcosahedronGeometry(3.2, 0),
    new THREE.MeshBasicMaterial({ color: 0xff4d8d, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
  mesh.position.set(Math.cos(a) * r, 6 + Math.sin(i * 0.7) * 10, Math.sin(a) * r);
  mesh.userData = { path, md, text };
  nodesGroup.add(mesh);
  thoughtNodes.push(mesh);
  // Un <button>: se alcanza con el teclado y es clicable ENTERO. Antes era un
  // div con pointer-events:none (heredado de su capa): su clic no llegaba nunca
  // y solo funcionaba atinar a la malla 3D que hubiera debajo.
  const lab = document.createElement('button');
  lab.type = 'button';
  lab.className = 'mind-node-label';
  lab.textContent = (path || t('mindThought')).split('/').pop();
  lab.title = path || '';
  lab.addEventListener('click', () => selectThoughtNode(mesh));
  document.getElementById('mind-anchors').appendChild(lab);
  anchors.push({ el: lab, pos: mesh.position });
  mesh.userData.label = lab;
}

async function loadExistingThoughts() {
  try { for (const it of await loadThoughts()) addThoughtNode(it); } catch { /* aún no hay */ }
}

// selección de un nodo de propuesta — desde la malla 3D (raycast) o su etiqueta
function selectThoughtNode(mesh) { showThoughtPanel(mesh); focusOn(mesh.position, 26); }

// Abrir una propuesta por su ruta (#/mente/<ruta>, una notificación, el
// historial). Si su nodo no está —se guardó con la Mente sin montar y no estaba
// en la carpeta al abrirla—, se enseña lo que se sepa de ella.
export function mostrarPropuesta(path) {
  if (!built || !path) return false;
  const node = thoughtNodes.find(n => n.userData.path === path);
  if (node) { selectThoughtNode(node); return true; }
  return false;
}

function showThoughtPanel(node) {
  const root = document.getElementById('mind-panel');
  const md = node.userData.md || node.userData.text || '(sin contenido)';
  const path = node.userData.path || t('mindThought');
  root.innerHTML = `<div class="mp-head"><span class="mp-path"></span><button id="mp-x" type="button">✕</button></div>` +
    `<div class="mp-body">${renderMarkdown(md)}</div>` +
    `<div class="mp-actions">` +
    `<button id="mp-exec" type="button" class="mp-exec">${escHtml(t('mindRunProposal'))}</button>` +
    (onElegirModelo ? `<div class="proposal-needs-model mp-needs-model">${escHtml(t('proposalNeedsModelShort'))} <button id="mp-pick" type="button">${escHtml(t('pickModel'))}</button></div>` : '') +
    (node.userData.path ? `<button id="mp-open" type="button" class="mp-open">${escHtml(etiquetaAbrir || t('mindOpenEditor'))}</button>` : '') +
    `</div>`;
  root.querySelector('.mp-path').textContent = path;
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', path);
  root.classList.add('show');
  const x = root.querySelector('#mp-x');
  x.setAttribute('aria-label', t('close'));
  x.onclick = () => root.classList.remove('show');
  root.querySelector('#mp-exec').onclick = () => { if (onExecute(md) !== false) root.classList.remove('show'); };
  const openBtn = root.querySelector('#mp-open');
  if (openBtn) openBtn.onclick = () => { onOpenFile(node.userData.path); root.classList.remove('show'); };
  const pick = root.querySelector('#mp-pick');
  if (pick) pick.onclick = () => onElegirModelo?.();
  // El foco, al primer botón que se vea («Ejecutar», o «Elegir modelo» en Básico).
  const primero = ['#mp-exec', '#mp-pick', '#mp-open'].map(s => root.querySelector(s)).find(b => b && b.getClientRects().length);
  primero?.focus({ preventScroll: true });
}

// ══ perfiles: anclas 3D + leyenda (recalculadas al abrir o al reprogramar) ══
function computeAnchors() {
  const map = new Map();
  map.set('ceo', new THREE.Vector3(0, 46, 0));
  const profs = ceo.getProfiles();
  const n = Math.max(profs.length, 1);
  profs.forEach((p, i) => {
    const a = (i / n) * Math.PI * 2;
    map.set(p.id, new THREE.Vector3(Math.cos(a) * 70, 8 + (i % 2) * 20, Math.sin(a) * 70));
  });
  return map;
}
function renderLegend() {
  const el = document.getElementById('mind-legend');
  if (!el) return;
  const profs = ceo.getProfiles();
  // Botones (antes divs sin rol ni foco): con el teclado también se vuela a un perfil.
  el.innerHTML = `<button type="button" class="ml-item" data-id="ceo"><span class="ml-sw" style="background:${CEO_COLOR}"></span>CEO</button>` +
    profs.map(p => `<button type="button" class="ml-item" data-id="${escHtml(p.id)}"><span class="ml-sw" style="background:${escHtml(p.color)}"></span>${escHtml(p.name)}</button>`).join('');
  el.setAttribute('aria-label', t('mindProfiles'));
  el.querySelectorAll('.ml-item').forEach(row => {
    row.title = t('mindFlyTo', { name: row.textContent });
    row.onclick = () => { const pos = anchorMap.get(row.dataset.id); if (pos) focusOn(pos, 46); };
  });
}
// vuelo suave de la cámara hacia un punto — así «clic en algo → la cámara se centra»
let flyTo = null;
function focusOn(pos, distance = 40) {
  if (!S) return;
  const dir = new THREE.Vector3().subVectors(S.camera.position, S.controls.target);
  if (dir.lengthSq() < 0.001) dir.set(0, 0.3, 1);
  dir.normalize().multiplyScalar(distance);
  flyTo = { fromPos: S.camera.position.clone(), toPos: pos.clone().add(dir), fromTarget: S.controls.target.clone(), toTarget: pos.clone(), t0: elapsed, dur: 1.1 };
}
const easeInOut = k => k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
function rebuildWorld() { anchorMap = computeAnchors(); renderLegend(); }

// ── panel ⚙: reprograma misión, carpeta-alma y PERFILES (editables) ──────
// «Pensar ahora» puede tardar minutos con un modelo de verdad: su estado vive
// fuera del panel, que se redibuja cada vez que se abre.
let pensando = false, estadoPensar = '', forjadaAhora = false;
function wireConfig(root) {
  const btn = root.querySelector('#mind-config');
  const cfg = root.querySelector('#mind-cfg');
  const profRowHtml = p => {
    const n = escHtml(p.name || t('mindNewProfile'));
    return `<div class="cfg-prof" data-id="${escHtml(p.id || '')}">
      <input type="color" class="cp-color" value="${escHtml(p.color || '#7c5cff')}" aria-label="${escHtml(t('mindProfColor', { name: p.name || t('mindNewProfile') }))}">
      <input type="text" class="cp-name" value="${escHtml(p.name || '')}" placeholder="${escHtml(t('mindProfName'))}" aria-label="${escHtml(t('mindProfName'))}">
      <input type="text" class="cp-focus" value="${escHtml(p.focus || '')}" placeholder="${escHtml(t('mindProfFocus'))}" aria-label="${escHtml(t('mindProfFocusL', { name: n }))}">
      <button type="button" class="cp-del" title="${escHtml(t('mindProfDel'))}" aria-label="${escHtml(t('mindProfDel'))}">✕</button></div>`;
  };
  const notifState = () => (!('Notification' in window)) ? { txt: t('mindNotifNo'), can: false }
    : Notification.permission === 'granted' ? { txt: t('mindNotifOk'), can: false }
    : Notification.permission === 'denied' ? { txt: t('mindNotifBlocked'), can: false }
    : { txt: t('mindNotifAsk'), can: true };
  const draw = () => {
    const profs = ceo.getProfiles();
    const ns = notifState();
    cfg.setAttribute('role', 'region');
    cfg.setAttribute('aria-label', t('mindCfgTitle'));
    cfg.innerHTML =
      '<div class="cfg-head">' + escHtml(t('mindCfgTitle')) + '<button id="cfg-x" type="button">✕</button></div>' +
      '<div class="cfg-notif">' + escHtml(t('mindNotif')) + ' ' + escHtml(ns.txt) + (ns.can ? ' <button id="cfg-notif-ask" type="button" class="cfg-notif-btn">' + escHtml(t('mindNotifBtn')) + '</button>' : '') + '</div>' +
      '<label for="cfg-mission">' + escHtml(t('mindMission')) + '</label>' +
      '<textarea id="cfg-mission" rows="3">' + escHtml(ceo.getMission()) + '</textarea>' +
      '<label for="cfg-dir" id="cfg-dir-label">' + escHtml(t('mindSoulDir')) + '</label>' +
      '<input id="cfg-dir" value="' + escHtml(ceo.getSoulDir()) + '">' +
      '<label>' + escHtml(t('mindProfilesL')) + '</label>' +
      '<div id="cfg-profiles">' + profs.map(profRowHtml).join('') + '</div>' +
      '<button id="cfg-add-prof" type="button" class="cfg-add">' + escHtml(t('mindAddProfile')) + '</button>' +
      '<div class="cfg-actions"><button id="cfg-think-now" type="button" class="cfg-ghost">' + escHtml(t('mindThinkNow')) + '</button>' +
      '<button id="cfg-save" type="button" class="cfg-save">' + escHtml(t('mindReprogram')) + '</button></div>' +
      '<div id="cfg-status" class="cfg-status" role="status" aria-live="polite"></div>' +
      '<div class="cfg-note">' + escHtml(t('mindCfgNote')) + '</div>';
    const x = cfg.querySelector('#cfg-x');
    x.setAttribute('aria-label', t('close'));
    // El foco vuelve a ⚙ (antes se quedaba en <body>, dentro de la Mente modal).
    x.onclick = () => { cfg.classList.remove('show'); root.querySelector('#mind-config')?.focus(); };
    // Dónde escribe de verdad (en Claw, la primera carpeta autorizada).
    Promise.resolve().then(() => etiquetaAlma()).then(txt => {
      const l = cfg.querySelector('#cfg-dir-label'); if (l && txt) l.textContent = txt;
    }).catch(() => {});
    cfg.querySelector('#cfg-notif-ask')?.addEventListener('click', () => { Notification.requestPermission().then(draw); });
    cfg.querySelector('#cfg-add-prof').onclick = () => {
      cfg.querySelector('#cfg-profiles').insertAdjacentHTML('beforeend', profRowHtml({ color: '#ff9f45', name: '', focus: '' }));
      wireRows();
      cfg.querySelector('#cfg-profiles .cfg-prof:last-child .cp-name')?.focus();
    };
    const estado = cfg.querySelector('#cfg-status');
    estado.textContent = estadoPensar;
    const think = cfg.querySelector('#cfg-think-now');
    think.disabled = pensando;
    // «Pensar ahora» ya no cierra el panel a ciegas: dice si no puede (sin
    // modelo, sin carpeta) y, si puede, que está pensando y cómo acaba.
    think.onclick = async () => {
      const motivo = await motivoNoPensar();
      const st = () => cfg.querySelector('#cfg-status');
      if (motivo) { estadoPensar = motivo; if (st()) st().textContent = motivo; return; }
      pensando = true; think.disabled = true; forjadaAhora = false; ultimoAviso = '';
      estadoPensar = t('mindThinking');
      if (st()) st().textContent = estadoPensar;
      let ok = false;
      try { ok = await ceo.forceCycle(); } catch { ok = false; }
      pensando = false;
      estadoPensar = ok && forjadaAhora ? t('mindThoughtDone') : (ultimoAviso || t('mindCantThink'));
      if (st()) st().textContent = estadoPensar;
      const b = cfg.querySelector('#cfg-think-now'); if (b) b.disabled = false;
    };
    cfg.querySelector('#cfg-save').onclick = () => {
      // preserva el id original de cada perfil (si no, cada guardado los
      // regeneraría desde el nombre y los ciclos en curso perderían el hilo)
      const rows = [...cfg.querySelectorAll('.cfg-prof')].map(r => ({
        id: r.dataset.id || undefined,
        color: r.querySelector('.cp-color').value,
        name: r.querySelector('.cp-name').value.trim(),
        focus: r.querySelector('.cp-focus').value.trim(),
      }));
      ceo.setMission(cfg.querySelector('#cfg-mission').value);
      ceo.setSoulDir(cfg.querySelector('#cfg-dir').value);
      ceo.setProfiles(rows);
      // Reprogramar NO enciende el cerebro: antes reactivaba en silencio uno
      // que habías pausado, y el botón seguía diciendo «reanudar».
      pintarPlayStop();
      cfg.classList.remove('show');
      root.querySelector('#mind-config')?.focus();
    };
    wireRows();
    function wireRows() { cfg.querySelectorAll('.cp-del').forEach(b => { b.onclick = () => b.closest('.cfg-prof').remove(); }); }
  };
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', 'mind-cfg');
  const abrir = () => { draw(); cfg.classList.add('show'); btn.setAttribute('aria-expanded', 'true'); cfg.querySelector('#cfg-mission')?.focus(); };
  const cerrar = () => { cfg.classList.remove('show'); btn.setAttribute('aria-expanded', 'false'); };
  btn.onclick = () => (cfg.classList.contains('show') ? cerrar() : abrir());
  new MutationObserver(() => btn.setAttribute('aria-expanded', cfg.classList.contains('show') ? 'true' : 'false'))
    .observe(cfg, { attributes: true, attributeFilter: ['class'] });
}
function wireHistory(root) {
  const btn = root.querySelector('#mind-history'), panel = root.querySelector('#mind-log');
  btn.setAttribute('aria-controls', 'mind-log');
  const sync = () => btn.setAttribute('aria-expanded', panel.classList.contains('show') ? 'true' : 'false');
  btn.onclick = () => { panel.classList.toggle('show'); sync(); };
  const x = panel.querySelector('#ml-x');
  x.setAttribute('aria-label', t('close'));
  x.onclick = () => { panel.classList.remove('show'); sync(); btn.focus(); };
  new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['class'] });
  sync();
}

// play/stop del cerebro, visible dentro de la Mente. La elección la persiste
// ceo.js (misma clave que usa el clic en la elfa) → sobrevive a recargar.
//
// Pausar a mitad de un ciclo no es instantáneo: el ciclo se aborta, pero tiene
// que soltar el modelo. Mientras tanto se dice «pausando…» y no «pausado»
// —decir lo segundo con el modelo aún ocupado era mentir— y se repinta solo
// hasta que el ciclo ha terminado de verdad (ceo.isRunning() en false).
//
// Es EL interruptor del cerebro autónomo: abrir la Mente ya no lo enciende (lo
// hacía la primera vez, para siempre, sin decirlo). Se repinta con cada cambio
// de estado que anuncie ceo.js (pushThought 'sys') y al volver a abrir la
// Mente: antes solo con su propio clic, y tras «Reprogramar» decía lo contrario
// de lo que pasaba.
function wirePlayStop(root) {
  const btn = root.querySelector('#mind-playstop');
  let repinta = null;
  const paint = () => {
    const on = ceo.isEnabled();
    const pausando = !on && ceo.isRunning();
    btn.textContent = on ? t('mindPause') : pausando ? t('mindPausing')
      : (ceo.hasDecided?.() ? t('mindResume') : t('mindStart'));
    btn.title = t('mindBrainExplain');
    btn.classList.toggle('paused', !on);
    btn.classList.toggle('pausing', pausando);
    clearTimeout(repinta);
    if (pausando) repinta = setTimeout(paint, 250);
  };
  btn.onclick = () => { if (ceo.isEnabled()) ceo.disable(); else ceo.enable(); paint(); };
  pintarPlayStop = paint;
  paint();
}

// ══ ciudad de fondo (motor de la app anfitriona, por debajo del mundo) ══════
async function buildBackgroundCity(scene) {
  if (!buildCityFn) return;
  try {
    const city = await buildCityFn(scene);
    if (!city) return;
    cityWrap = city.cityWrap; cityCity = city.cityCity; cityModel = city.cityModel;
  } catch { /* sigue sin ciudad de fondo */ }
}
// haz de luz que baja hasta el fichero real en la ciudad + resalta su celda
function fileBeam(path, kind) {
  if (!cityModel || !cityCity || !S) return;
  const rel = String(path).replace(/^\.?\//, '');
  const f = cityModel.fileByRel.get(rel);
  if (!f) return;
  const local = new THREE.Vector3(f.box.cx, f.box.cy, f.box.cz);
  const world = cityWrap.localToWorld(local.clone());
  const top = world.clone(); top.y += 50;
  const geo = new THREE.BufferGeometry().setFromPoints([top, world]);
  const mat = new THREE.LineBasicMaterial({ color: kind === 'write' ? 0xff4d8d : 0x49e8ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  const line = new THREE.Line(geo, mat);
  S.scene.add(line);
  beams.push({ obj: line, born: elapsed, life: 1.4 });
  fileActivity.push({ id: f.id, born: elapsed, life: 2.2 });
}

// ── mundo psicodélico ───────────────────────────────────────────────────────
function buildScene(canvas, W, H) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(W, H, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 2000);
  camera.position.set(0, 40, 150);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.06; controls.autoRotate = false;
  controls.enablePan = false; controls.minDistance = 60; controls.maxDistance = 420;

  const N = 14000;
  const pos = new Float32Array(N * 3), rad = new Float32Array(N);
  let s = 987654321; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < N; i++) {
    const arm = Math.floor(rnd() * 4);
    const r = Math.pow(rnd(), 0.6) * 120 + 6;
    const a = arm * (Math.PI / 2) + r * 0.03 + (rnd() - 0.5) * 0.5;
    const y = (rnd() - 0.5) * (14 - r * 0.06);
    pos[i * 3] = Math.cos(a) * r; pos[i * 3 + 1] = y; pos[i * 3 + 2] = Math.sin(a) * r; rad[i] = r;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aRad', new THREE.BufferAttribute(rad, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uBass: { value: 0 }, uMid: { value: 0 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `uniform float uTime, uBass, uMid; attribute float aRad; varying vec3 vC;
      vec3 hsv(float h){ vec3 k=vec3(1.,2./3.,1./3.); vec3 p=abs(fract(h+k)*6.-3.); return clamp(p-1.,0.,1.);}
      float hash(vec3 p){ p=fract(p*0.3183099+0.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
      float vnoise(vec3 x){ vec3 i=floor(x),f=fract(x); f=f*f*(3.0-2.0*f);
        return mix(mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
                   mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z); }
      float fbm(vec3 p){ float a=0.5,s=0.0; for(int i=0;i<4;i++){ s+=a*vnoise(p); p*=2.02; a*=0.5;} return s; }
      void main(){
        vec3 pos=position;
        float n=fbm(pos*0.03 + vec3(0.0,uTime*0.18,0.0));
        pos += normalize(pos+0.001) * (n-0.5) * (5.0 + uMid*4.0 + uBass*7.0);
        float sw = uTime*0.14 + aRad*0.015 + uBass*0.18;
        float cs=cos(sw), sn=sin(sw);
        pos.xz = mat2(cs,-sn,sn,cs) * pos.xz;
        pos *= (1.0 + uBass*0.05);
        float h=fract(aRad*0.004+uTime*0.03+n*0.12); vC=hsv(h)*(1.3-aRad*0.004)*(0.95+uMid*0.18+uBass*0.12);
        vec4 mv=modelViewMatrix*vec4(pos,1.0); gl_PointSize=(2.2+60.0/-mv.z)*(1.0+uBass*0.18); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `varying vec3 vC; void main(){ vec2 d=gl_PointCoord-0.5; float m=smoothstep(0.5,0.0,length(d)); gl_FragColor=vec4(vC*2.0,m); }`,
  });
  const galaxy = new THREE.Points(geo, mat); scene.add(galaxy);
  const core = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(18, 1)),
    new THREE.LineBasicMaterial({ color: 0xff4d8d, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(core);
  const rings = [];
  for (let i = 0; i < 24; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(22, 0.5, 8, 80),
      new THREE.MeshBasicMaterial({ color: 0x7c5cff, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.rotation.x = Math.PI / 2; ring.position.y = -70 + i * 6; ring.userData.i = i;
    scene.add(ring); rings.push(ring);
  }
  nodesGroup = new THREE.Group(); scene.add(nodesGroup);
  starGroup = new THREE.Group(); scene.add(starGroup);
  const composer = new EffectComposer(renderer);
  composer.setSize(W, H); composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 1.1, 0.5, 0.2);
  composer.addPass(bloom); composer.addPass(new OutputPass());
  return { renderer, scene, camera, controls, composer, bloom, mat, galaxy, core, rings };
}

// La Mente es una capa MODAL: lo de detrás queda inerte mientras está abierta
// (modal.js), el foco entra en ella y al salir vuelve a donde estaba (el botón
// 🧠). Antes Tab recorría la página tapada y el foco se quedaba detrás.
export async function openMind() {
  if (open) return;
  open = true;
  if (built) {
    overlay.style.display = '';
    if (musicaPuesta) { try { widget?.play(); } catch { /* — */ } }
    cerrarModal = abrirModal(overlay, { foco: '#mind-close', dejar: ['toasts'] });
    pintarPlayStop();
    startLoop();
    return;
  }

  overlay = document.createElement('div');
  overlay.id = 'mind-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t('mindAria'));
  overlay.setAttribute('aria-describedby', 'mind-explica');
  overlay.innerHTML =
    '<canvas id="mind-canvas" aria-hidden="true"></canvas>' +
    `<div id="mind-title">${escHtml(t('mindTitle'))}<span id="mind-explica">${escHtml(t('mindExplain'))}</span></div>` +
    '<div id="mind-legend" role="group"></div>' +
    '<button id="mind-playstop" type="button"></button>' +
    `<button id="mind-config" type="button" title="${escHtml(t('mindCfgTitle'))}">${escHtml(t('mindCfgBtn'))}</button>` +
    `<button id="mind-history" type="button" title="${escHtml(t('mindHistoryT'))}">${escHtml(t('mindHistoryBtn'))}</button>` +
    `<button id="mind-close" type="button" title="${escHtml(t('mindCloseT'))}">${escHtml(t('mindCloseBtn'))}</button>` +
    '<button id="mind-music-btn" type="button" class="mind-music-btn"></button>' +
    '<div id="mind-anchors"></div><div id="mind-panel"></div><div id="mind-cfg"></div>' +
    `<div id="mind-log" role="region" aria-label="${escHtml(t('mindHistoryTitle'))}"><div class="ml-head">${escHtml(t('mindHistoryTitle'))}<button id="ml-x" type="button">✕</button></div><div id="mind-log-body" role="log"></div></div>`;
  document.body.appendChild(overlay);
  cerrarModal = abrirModal(overlay, { foco: '#mind-close', dejar: ['toasts'] });
  wireConfig(overlay); wireHistory(overlay); wirePlayStop(overlay); wireMusic(overlay);
  anchors.length = 0; thoughtNodes = []; stars = [];
  rebuildWorld();

  const canvas = overlay.querySelector('#mind-canvas');
  S = buildScene(canvas, window.innerWidth, window.innerHeight);
  buildBackgroundCity(S.scene);
  await loadExistingThoughts();
  // El historial: lo guardado más lo que llegó con la Mente cerrada (mind-log.js).
  await mindLog.cargar();
  for (const l of mindLog.todas()) renderLogRow(l);
  logMontado = true;

  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
  let downXY = null;
  canvas.addEventListener('pointerdown', e => { downXY = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', e => {
    if (!downXY) return; const moved = Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]); downXY = null;
    if (moved > 5 || !thoughtNodes.length) return;
    ptr.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    ray.setFromCamera(ptr, S.camera);
    const hit = ray.intersectObjects(thoughtNodes)[0];
    if (hit) selectThoughtNode(hit.object);
  });

  const onResize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    S.renderer.setSize(w, h, false); S.composer.setSize(w, h); S.bloom.resolution.set(w, h);
    S.camera.aspect = w / h; S.camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', onResize); S.onResize = onResize;
  overlay.querySelector('#mind-close').addEventListener('click', closeMind);
  // Escape cierra lo de más arriba: un panel abierto antes que la Mente entera.
  // Con un permiso pendiente (un <dialog>), Escape es suyo.
  S.onKey = e => {
    if (e.key !== 'Escape' || !open) return;
    if (document.querySelector('dialog[open]')) return;
    const capa = ['#mind-cfg', '#mind-panel', '#mind-log'].map(s => overlay.querySelector(s)).find(el => el?.classList.contains('show'));
    if (capa) { capa.classList.remove('show'); overlay.querySelector('#mind-close')?.focus(); return; }
    closeMind();
  };
  document.addEventListener('keydown', S.onKey);
  built = true;
  startLoop();
}

// Etiquetas de propuestas: se proyectan del mundo 3D a la pantalla, así que
// con muchas acumuladas acaban solapándose ilegibles según el ángulo de
// cámara. Aquí: cap a las más cercanas y reparto anti-solape (empuja hacia
// abajo la que choca con otra ya colocada), para que se apilen separadas.
const MAX_LABELS = 14, LABEL_W = 90, LABEL_H = 20;
function projectAnchors() {
  const w = window.innerWidth, h = window.innerHeight, v = new THREE.Vector3();
  const projected = [];
  for (const a of anchors) {
    v.copy(a.pos).project(S.camera);
    if (v.z > 1) { a.el.style.display = 'none'; continue; } // detrás de la cámara
    projected.push({ a, x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, depth: v.z });
  }
  projected.sort((p1, p2) => p1.depth - p2.depth); // las más cercanas a la cámara, prioridad
  projected.forEach((p, i) => { p.a.el.style.display = i < MAX_LABELS ? '' : 'none'; });
  const visible = projected.slice(0, MAX_LABELS).sort((p1, p2) => p1.x - p2.x || p1.y - p2.y);
  const placed = [];
  for (const p of visible) {
    let y = p.y;
    for (const q of placed) if (Math.abs(q.x - p.x) < LABEL_W && Math.abs(q.y - y) < LABEL_H) y = q.y + LABEL_H;
    placed.push({ x: p.x, y });
    p.a.el.style.left = p.x + 'px'; p.a.el.style.top = y + 'px';
    p.a.el.style.transform = 'translate(-50%,-50%)';
  }
}
const wob = (t, seed, freq = 0.1) => Math.sin(t * freq + seed) * 0.6 + Math.sin(t * freq * 0.43 + seed * 2.1) * 0.3 + Math.sin(t * freq * 0.19 + seed * 4.7) * 0.1;

let elapsed = 0, lastMs = 0, smBass = 0, smMid = 0;
function startLoop() {
  if (raf) return;
  const loop = (ms) => {
    raf = requestAnimationFrame(loop);
    const dt = lastMs ? (ms - lastMs) / 1000 : 0;
    elapsed += dt; lastMs = ms;
    const t = elapsed;
    const beat = 60 / 138;
    const bp = (t % beat) / beat;
    const bassRaw = Math.pow(1 - bp, 3);
    const midRaw = 0.5 + 0.5 * Math.sin(t * 6.0);
    smBass += (bassRaw - smBass) * 0.05;
    smMid += (midRaw - smMid) * 0.06;
    S.mat.uniforms.uTime.value = t;
    S.mat.uniforms.uBass.value = smBass;
    S.mat.uniforms.uMid.value = smMid;
    S.galaxy.rotation.y = t * 0.05;
    S.galaxy.rotation.x = wob(t, 1.7, 0.05) * 0.15;
    S.galaxy.rotation.z = wob(t, 5.2, 0.04) * 0.1;
    S.galaxy.scale.setScalar(1 + smBass * 0.02);
    const pulse = 1 + smBass * 0.05 + Math.sin(t * 0.9) * 0.03;
    S.core.scale.setScalar(pulse); S.core.rotation.y = t * 0.16; S.core.rotation.x = t * 0.09;
    S.core.position.x = wob(t, 3.1, 0.11) * 6; S.core.position.z = wob(t, 9.4, 0.09) * 6;
    S.core.material.color.setHSL((t * 0.04) % 1, 0.9, 0.6);
    for (const r of S.rings) {
      r.position.y += 0.14 + smBass * 0.12;
      if (r.position.y > 74) r.position.y -= 144;
      r.position.x = wob(t, r.userData.i * 1.3 + 1, 0.08) * 3;
      r.scale.setScalar(1 + smBass * 0.12 + Math.sin(t * 0.8 + r.userData.i) * 0.04);
      r.material.opacity = 0.2 + smBass * 0.16;
      r.material.color.setHSL((t * 0.05 + r.userData.i * 0.03) % 1, 0.85, 0.6);
    }
    for (let i = 0; i < thoughtNodes.length; i++) { const n = thoughtNodes[i]; n.rotation.y = t + i; n.scale.setScalar(1 + Math.sin(t * 2 + i) * 0.14); }
    // estrellas: nacen (fade-in), viven, se apagan solas y se reciclan
    for (let i = stars.length - 1; i >= 0; i--) {
      const st = stars[i], age = t - st.born;
      if (age > st.life) { starGroup.remove(st.obj); st.obj.material.map.dispose(); st.obj.material.dispose(); stars.splice(i, 1); continue; }
      const fadeIn = Math.min(1, age / 0.5), fadeOut = Math.min(1, (st.life - age) / (st.life * 0.35));
      st.obj.material.opacity = Math.min(fadeIn, fadeOut);
      st.obj.position.y += st.up * dt;
      st.obj.position.x += Math.sin(t * 0.6 + st.seed) * 0.3 * dt;
    }
    // haces sobre la ciudad + celdas de fichero resaltadas por actividad
    for (let i = beams.length - 1; i >= 0; i--) {
      const b = beams[i], age = t - b.born;
      if (age > b.life) { S.scene.remove(b.obj); b.obj.geometry.dispose(); b.obj.material.dispose(); beams.splice(i, 1); continue; }
      b.obj.material.opacity = 0.9 * Math.max(0, 1 - age / b.life);
    }
    if (cityCity) for (let i = fileActivity.length - 1; i >= 0; i--) {
      const a = fileActivity[i], age = t - a.born;
      if (age > a.life) { cityCity.paintFile(a.id, 0); fileActivity.splice(i, 1); continue; }
      cityCity.paintFile(a.id, Math.max(0, 1 - age / a.life));
    }
    if (flyTo) {
      const k = Math.min(1, (t - flyTo.t0) / flyTo.dur), e = easeInOut(k);
      S.camera.position.lerpVectors(flyTo.fromPos, flyTo.toPos, e);
      S.controls.target.lerpVectors(flyTo.fromTarget, flyTo.toTarget, e);
      if (k >= 1) flyTo = null;
    }
    S.controls.update();
    projectAnchors();
    S.composer.render();
  };
  loop(performance.now());
}

export function closeMind() {
  open = false;
  if (raf) { cancelAnimationFrame(raf); raf = null; }
  lastMs = 0;
  try { widget?.pause(); } catch {}
  if (overlay) overlay.style.display = 'none';
  cerrarModal?.();
  cerrarModal = null;
  try { onCerrar(); } catch { /* lo de la app anfitriona no impide cerrar */ }
}

// para tests/depuración
export function _debug() {
  return {
    starCount: stars.length, hasCity: !!cityCity, profileCount: ceo.getProfiles().length,
    beamCount: beams.length, fileActivityCount: fileActivity.length,
    cameraPos: S ? [S.camera.position.x, S.camera.position.y, S.camera.position.z] : null,
    flying: !!flyTo,
  };
}
export function _debugFocusOn(id) { const p = anchorMap.get(id); if (p) focusOn(p, 46); }
