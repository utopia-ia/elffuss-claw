// UI: chat + visualizador + paneles. Todo el DOM vive aquí.
import * as db from './db.js';
import * as perms from './permissions.js';
import * as settings from './settings.js';
import * as skills from './skills.js';
import { fs, apps, vault, tasks, watch, memory } from './tools/index.js';
import { renderMarkdown, linkify } from './md.js';
import * as rutas from './rutas.js';
import { t as tr, uiLang } from './i18n.js';
import { humanizeStreamPreview } from './humanize.js'; // alias: dentro de tick(t) el token ya se llama t
import { UI } from './icons.js';
import { cacheEstimate } from './model-cache.js';
import * as modelos from './model-storage.js';
import * as workspace from './workspace.js';
import * as telemetry from './telemetry.js';

let onSettingsChangedCb = () => {};
let onSkillInstalledCb = () => {};

const $ = id => document.getElementById(id);

// ---------- chat ----------
export function addMsg(cls, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + cls;
  // las respuestas de Elffuss se renderizan como markdown; lo del usuario, plano
  if (cls === 'assistant') {
    div.classList.add('md');
    div.innerHTML = renderMarkdown(text);
  } else {
    div.textContent = text;
  }
  $('log').appendChild(div);
  $('log').scrollTop = $('log').scrollHeight;
  if (/(^|\s)user(\s|$)/.test(cls)) ocultarSugerencias();
  return div;
}

// Las sugerencias de debajo del chat sirven para empezar. En cuanto hay un
// mensaje del usuario —uno nuevo, uno en cola o la conversación restaurada al
// abrir, que también entra por aquí— sobran. Se ocultan con `hidden` y no se
// borran: el cambio de idioma las reescribe, y 🧹 recarga la página, con lo que
// vuelven en una conversación vacía.
function ocultarSugerencias() {
  const chips = $('chips');
  if (chips && !chips.hidden) chips.hidden = true;
}

// Llevar a un mensaje del chat: en el móvil, al lado del chat; el mensaje a la
// vista, con el foco (para el teclado y el lector de pantalla) y resaltado un
// momento para que se vea cuál es.
export function irAlMensaje(div) {
  if (!div?.isConnected) return;
  if (isMobile()) flipTo('chat');
  div.tabIndex = -1;
  div.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  div.focus({ preventScroll: true });
  div.classList.add('resaltado');
  setTimeout(() => div.classList.remove('resaltado'), 1600);
}

// Una línea de la conversación que escucha el copiloto (viene del Translator):
// quién habla y qué dice, con su estilo, no como un mensaje del usuario.
export function addTranscripcion(quien, texto) {
  const div = document.createElement('div');
  div.className = 'msg transcript';
  const q = document.createElement('b');
  q.textContent = quien + ': ';
  div.append(q, document.createTextNode(texto));
  $('log').appendChild(div);
  $('log').scrollTop = $('log').scrollHeight;
  return div;
}

function shortArgs(args = {}) {
  const s = Object.entries(args)
    .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join(' · ');
  return s ? ` (${s.slice(0, 120)})` : '';
}

// Adónde lleva cada herramienta: el «🔧 app.create …» del chat enlaza a lo que
// ha tocado (la app, las tareas, las skills, las carpetas).
function rutaDeHerramienta(call) {
  const t = call.tool || '', a = call.args || {};
  if ((t === 'app.create' || t === 'app.open') && a.name) return rutas.href('apps', a.name);
  if (t.startsWith('app.')) return rutas.href('apps');
  if (t === 'tasks.add' || t === 'tasks.list' || t === 'tasks.remove') return rutas.href('tareas');
  if (t.startsWith('fs.watch')) return rutas.href('tareas', 'automatizaciones');
  if ((t === 'skill.create' || t === 'skill.edit' || t === 'skill.get') && a.name) return rutas.href('skills', a.name);
  if (t.startsWith('skill.')) return rutas.href('skills');
  if (t.startsWith('fs.')) return rutas.href('permisos');
  if (t.startsWith('vault.')) return rutas.href('vault');
  if (t.startsWith('memory.')) return rutas.href('memoria');
  return null;
}

export function addTool(call) {
  const div = addMsg('tool', `🔧 ${call.tool}${shortArgs(call.args)}`);
  const destino = rutaDeHerramienta(call);
  if (destino) {
    const a = document.createElement('a');
    a.href = destino;
    a.className = 'tool-link';
    a.textContent = '↗';
    a.title = tr('toolGoTo');
    a.setAttribute('aria-label', tr('toolGoTo'));
    div.append(' ', a);
  }
  return div;
}

export function addToolResult(tool, result) {
  const err = result.startsWith('ERROR');
  const det = document.createElement('details');
  det.className = 'msg tool-result' + (err ? ' err' : '');
  const sum = document.createElement('summary');
  sum.textContent = (err ? '⚠️ ' : '✓ ') + result.split('\n')[0].slice(0, 110);
  const pre = document.createElement('pre');
  // Las URL de web.fetch / web.search se pueden abrir (http y https, pestaña
  // nueva, sin referrer); el resto sigue siendo texto plano.
  pre.innerHTML = linkify(result.slice(0, 2000));
  det.append(sum, pre);
  $('log').appendChild(det);
  $('log').scrollTop = $('log').scrollHeight;
}

// Burbuja de «pensando»: visible, con avatar, puntos animados y el texto
// del modelo en streaming (cola de 240 caracteres).
export function thinkingBubble() {
  const div = document.createElement('div');
  div.className = 'msg thinking';
  const img = document.createElement('img');
  img.src = 'img/elffuss.svg';
  img.className = 'mini';
  img.alt = '';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = tr('thinking');
  const dots = document.createElement('span');
  dots.className = 'dots';
  dots.append(...[0, 1, 2].map(() => document.createElement('i')));
  const gen = document.createElement('div');
  gen.className = 'gen';
  div.append(img, label, dots, gen);
  // #log es una región viva (role=log en index.html). La burbuja se oculta a los
  // lectores de pantalla: cambia de texto con cada token y se leería sin parar.
  // Mientras trabaja, el log queda «ocupado» y lo que llegue se anuncia al final.
  div.setAttribute('aria-hidden', 'true');
  $('log').setAttribute('aria-busy', 'true');
  $('log').appendChild(div);
  $('log').scrollTop = $('log').scrollHeight;
  // Barra del PREFILL. El prefill es la espera larga —leer el prompt antes de
  // escribir la primera letra— y hasta ahora no se veía: con un prompt de arnés
  // en el modelo grande son decenas de segundos de burbuja quieta, y una espera
  // sin señal se lee como «se ha colgado». De hecho se reportó así.
  //
  // Va DENTRO de la burbuja que ya existe en vez de un elemento nuevo: la
  // burbuja aparece justo cuando empieza el turno, que es exactamente cuando
  // empieza el prefill.
  const barra = document.createElement('div');
  barra.className = 'prefill';
  const relleno = document.createElement('i');
  barra.appendChild(relleno);
  barra.hidden = true;
  div.insertBefore(barra, gen);

  let buf = '';
  return {
    // `hechos` y `total` vienen del motor por lote TERMINADO en la GPU, no
    // encolado: la barra no llega al 100 % antes de tiempo.
    prefill(hechos, total) {
      if (!total) return;
      const pct = Math.max(0, Math.min(100, Math.round((hechos / total) * 100)));
      label.textContent = tr('reading', { p: pct });
      barra.hidden = false;
      relleno.style.width = pct + '%';
    },
    tick(t) {
      // Al escribir la primera letra el prefill ha terminado: fuera la barra, o
      // se quedaría puesta al 100 % durante toda la respuesta.
      if (!barra.hidden) barra.hidden = true;
      buf += t;
      label.textContent = tr('writing', { n: buf.length });
      // Si está emitiendo un tool-call (p.ej. app.create con un HTML enorme), NO
      // volcamos el JSON/HTML crudo que parpadea: una frase humana («creando
      // app…»). Para el texto normal, caja que CRECE y se puede leer/scrollear
      // entera (antes se mostraban solo los últimos 240 y desaparecía lo de
      // arriba). Se respeta tu scroll si subes a leer.
      const preview = humanizeStreamPreview(buf);
      if (preview) {
        gen.classList.add('tool-preview');
        gen.textContent = '⟐ ' + preview;
      } else {
        gen.classList.remove('tool-preview');
        const pegado = gen.scrollHeight - gen.scrollTop - gen.clientHeight < 28;
        gen.textContent = buf;
        if (pegado) gen.scrollTop = gen.scrollHeight;
      }
    },
    tool(name) {
      buf = '';
      gen.textContent = '';
      label.textContent = tr('using', { name });
    },
    // ■ pulsado y el turno aún soltando el modelo: la burbuja lo dice en vez
    // de seguir animando como si nada.
    stopping() {
      label.textContent = tr('stopping');
      div.classList.add('stopping');
    },
    // Lo que llegó a escribir, si era texto para el usuario (no una herramienta
    // a medias, que se enseña como «creando app…»): lo que se conserva al parar.
    partial() { return humanizeStreamPreview(buf) ? '' : buf.trim(); },
    remove() { div.remove(); if (!document.querySelector('#log .msg.thinking')) $('log').removeAttribute('aria-busy'); },
  };
}

// Un mensaje de la cola que ■ dejó sin procesar: tachado y, para quien no lo
// ve, dicho con palabras (el tachado solo no llega a un lector de pantalla).
export function markCancelled(el) {
  if (!el) return;
  el.classList.remove('queued');
  el.classList.add('cancelled');
  if (el.querySelector('.sr-only')) return;
  const s = document.createElement('span');
  s.className = 'sr-only';
  s.textContent = ' ' + tr('cancelled');
  el.append(s);
}

// Región viva (#stop-status) para lo que no se oye de otro modo: «Parando…».
// Parar con el ratón o con Enter deja el foco en otro sitio, el botón solo lo
// dice en su etiqueta y la burbuja de «pensando» está oculta a los lectores (cambia
// en cada token). Lo que entra en el chat (#log) o en un aviso (#toasts) NO pasa
// por aquí: esas dos ya son regiones vivas, y repetirlo aquí lo leía dos veces.
// Se vacía y se escribe en otra tarea para que el mismo texto dos veces seguidas
// se vuelva a leer.
let anuncio = null;
export function announce(texto) {
  const r = $('stop-status');
  if (!r) return;
  clearTimeout(anuncio);
  r.textContent = '';
  anuncio = setTimeout(() => { r.textContent = texto; }, 50);
}

// Vaciar el chat a la vista, dejando el saludo (🧹).
export function clearLog() {
  for (const el of [...$('log').children]) if (!el.classList.contains('sys')) el.remove();
}

// Avisos. Antes se iban a los 4,5 s pasara lo que pasara: uno de 184 caracteres
// (el de Hard Work) no daba tiempo a leerlo, no había forma de quitarlos ni de
// pararlos, y ninguno llevaba a ningún sitio. Ahora:
//   · duran según lo que hay que leer, y se paran con el ratón o el foco encima;
//   · se cierran con ✕;
//   · pueden llevar UNA acción («Deshacer», «Ver tarea», «Elegir ahora»…);
//   · #toasts es una región viva (index.html): un lector de pantalla los anuncia.
// `opts` admite un número (ms), como antes, o { ms, accion: { label, run } }.
export function toast(text, opts = {}) {
  if (typeof opts === 'number') opts = { ms: opts };
  const { accion = null, ms = null } = opts || {};
  const t = document.createElement('div');
  t.className = 'toast';
  const txt = document.createElement('span');
  txt.className = 'toast-txt';
  txt.textContent = text;
  t.appendChild(txt);
  let timer = null, restante = 0, desde = 0, parado = false;
  const quitar = () => { clearTimeout(timer); t.remove(); };
  if (accion?.label && typeof accion.run === 'function') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-accion';
    b.textContent = accion.label;
    b.onclick = () => { quitar(); try { accion.run(); } catch (e) { console.warn('[elffuss] acción del aviso:', e); } };
    t.appendChild(b);
  }
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'toast-x';
  x.textContent = '✕';
  x.title = tr('close');
  x.setAttribute('aria-label', tr('close'));
  x.onclick = quitar;
  t.appendChild(x);
  $('toasts').appendChild(t);
  // ~50 ms por carácter, entre 4 y 12 s; con acción, unos segundos más para
  // que dé tiempo a decidir.
  restante = ms ?? (Math.min(12000, Math.max(4000, 1500 + String(text).length * 50)) + (accion ? 4000 : 0));
  // Se para con el RATÓN encima o con el foco dentro, no con un toque: en un
  // teléfono un toque cuenta como «encima» y no hay «salir», así que el aviso
  // tocado se quedaba para siempre (y si tapaba ■, el toque nunca llegaba a ■).
  let ratonEncima = false;
  const arrancar = () => { desde = Date.now(); clearTimeout(timer); timer = setTimeout(quitar, restante); };
  const pausar = () => { if (parado) return; parado = true; clearTimeout(timer); restante = Math.max(1500, restante - (Date.now() - desde)); };
  const seguir = () => { if (!parado || ratonEncima || t.contains(document.activeElement)) return; parado = false; arrancar(); };
  t.addEventListener('pointerenter', e => { if (e.pointerType !== 'mouse') return; ratonEncima = true; pausar(); });
  t.addEventListener('pointerleave', e => { if (e.pointerType !== 'mouse') return; ratonEncima = false; seguir(); });
  t.addEventListener('focusin', pausar);
  t.addEventListener('focusout', () => setTimeout(seguir, 0));
  arrancar();
  return t;
}

// ---------- modal de permisos ----------
// Tres cosas que fallaban, las tres con el teclado:
//   · Escape cerraba el diálogo SIN contestar: la promesa no se resolvía nunca,
//     el turno se quedaba colgado en «Elffuss está usando…» y todo lo que
//     escribieras después esperaba en la cola hasta recargar —y con ella el
//     cerebro CEO, que no arrancaba otro ciclo—. Ahora Escape (y cualquier otro
//     cierre) es «Denegar».
//   · Dos peticiones a la vez se pisaban los botones: la segunda reasignaba los
//     onclick de la primera, que ya no se podía contestar. Ahora van en cola,
//     una detrás de otra (permissions.js ya las pone en fila por ámbito; esta
//     cola cubre además a quien llame aquí directamente).
//   · Si la petición nacía de un Enter (p. ej. en la contraseña de la Bóveda),
//     el diálogo se abría DENTRO de ese mismo evento, el foco caía en «Denegar»
//     y la misma pulsación lo activaba: denegado sin haberlo visto. Ahora se
//     abre en la tarea siguiente, cuando esa tecla ya ha terminado.
let colaPermisos = Promise.resolve();
export function askPermission(scope, meta, detail) {
  const turno = colaPermisos.then(() => mostrarPermiso(scope, meta, detail));
  colaPermisos = turno.catch(() => {});
  return turno;
}

function mostrarPermiso(scope, meta, detail) {
  return new Promise(resolve => {
    const dlg = $('perm-dialog');
    $('perm-title').textContent = `${meta?.icon || '❓'} ${tr('permWord')}: ${meta?.label || scope}`;
    $('perm-desc').textContent = meta?.desc || '';
    $('perm-detail').textContent = detail || '';
    const previo = document.activeElement;
    let hecho = false, mostrado = false;
    const done = ok => {
      if (hecho) return;
      hecho = true;
      $('perm-allow').onclick = null;
      $('perm-deny').onclick = null;
      dlg.removeEventListener('cancel', alCancelar);
      dlg.removeEventListener('close', alCerrar);
      if (dlg.open) dlg.close();
      refreshPerms();
      if (previo && previo !== document.body && document.contains(previo)) {
        try { previo.focus({ preventScroll: true }); } catch { /* — */ }
      }
      resolve(ok);
    };
    const alCancelar = e => { e.preventDefault(); done(false); };   // Escape = Denegar
    // Cualquier otro cierre, también. Pero solo el de ESTE diálogo: el evento
    // «close» de la petición anterior llega en una tarea aparte, cuando esta ya
    // ha empezado a escuchar, y sin la guarda la denegaba antes de enseñarla.
    const alCerrar = () => { if (mostrado && !dlg.open) done(false); };
    $('perm-allow').onclick = () => done(true);
    $('perm-deny').onclick = () => done(false);
    dlg.addEventListener('cancel', alCancelar);
    dlg.addEventListener('close', alCerrar);
    setTimeout(() => {
      if (hecho) return;
      try { dlg.showModal(); mostrado = true; } catch { done(false); }
    }, 0);
  });
}

// ---------- visualizador ----------
const isMobile = () => matchMedia('(max-width: 700px)').matches;

// Cuándo abrió el USUARIO una app a mano (panel Apps o su dirección): el
// tablero del copiloto no la tapa durante un rato (ver kernel.js).
let aperturaManualT = 0;
export const aperturaManual = () => aperturaManualT;

// `ruta`: es una app guardada (apps.create/open) y su dirección es #/apps/<nombre>.
// El tablero del copiloto también se pinta aquí, pero no es una app guardada.
export function renderApp(name, html, { ruta = false } = {}) {
  _stage?.hide?.($('vista-empty'), false);   // si estaba el escaparate de descarga, quitarlo
  $('vista-empty').hidden = true;
  const frame = $('appframe');
  frame.hidden = false;
  frame.srcdoc = html;
  frame.title = tr('appFrameT', { name });
  selectTab('vista', { reflejar: !ruta });
  if (ruta) rutas.reflejar('apps', name);
  refreshApps();
  if (isMobile()) flipTo('viz'); // en móvil, saltar a ver la app recién creada
}

// móvil: una sola columna, chat ↔ visualizador conmutables
export function mostrarChat() { if (isMobile()) flipTo('chat'); }
function flipTo(side) {
  document.body.classList.toggle('show-viz', side === 'viz');
  pintarFlip();
}
// El botón dice adónde lleva, en el idioma de la página (empezaba con «Vista»
// escrito en el HTML para todos los idiomas).
function pintarFlip() {
  const enViz = document.body.classList.contains('show-viz');
  const b = $('btn-flip');
  b.textContent = enViz ? tr('flipChat') : tr('flipView');
  b.title = enViz ? tr('flipToChat') : tr('flipToView');
  b.setAttribute('aria-label', b.title);
}

// ---------- pestañas ----------
// Pestañas de verdad (tablist/tab/tabpanel, aria-selected, tabindex itinerante y
// flechas) y con dirección: cada una se refleja en la URL (#/apps, #/tareas…;
// ver rutas.js), así que se pueden enlazar, guardar y recorrer con «Atrás».
// `push`: un clic del usuario crea entrada de historial; lo que se abre solo
// (la Vista al crear una app) reemplaza la actual y no ensucia el historial.
export function selectTab(name, { push = false, reflejar = true } = {}) {
  document.querySelectorAll('#tabs button').forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('.panel').forEach(p =>
    p.classList.toggle('active', p.id === 'panel-' + name));
  if (reflejar) rutas.reflejar(name, null, { push });
  if (name === 'apps') return refreshApps();
  if (name === 'tareas') return refreshTasks();
  if (name === 'vault') return refreshVault();
  if (name === 'permisos') return refreshPerms();
  if (name === 'ajustes') return refreshSettings();
  if (name === 'skills') return refreshSkillsPanel();
}

// Ir a donde dice una ruta (#/…). Lo usan el arranque, «Atrás»/«Adelante» y
// los enlaces del chat. La Mente no vive en ui.js: la abre quien la registre.
let onMenteCb = () => {};
export function setOnMente(fn) { onMenteCb = fn; }
export async function navegar(ruta) {
  if (!ruta) return;
  const { seccion, detalle } = ruta;
  const verPanel = async (tab) => { await selectTab(tab, { reflejar: false }); if (isMobile()) flipTo('viz'); };
  if (seccion === 'mente') return onMenteCb(detalle);
  if (seccion === 'modelo') {
    // No es un sitio sino una acción: se hace y la URL vuelve a decir dónde estás.
    rutas.reflejar(tabActiva() || 'vista');
    enfocarSelectorModelo();
    return;
  }
  if (seccion === 'apps' && detalle) {
    const app = (await apps.allApps()).find(a => a.name === detalle);
    if (app) { aperturaManualT = Date.now(); await apps.open({ name: app.name }); rutas.reflejar('apps', app.name); return; }
    toast(tr('appMissing', { name: detalle }));
    return verPanel('apps');
  }
  // La memoria vive en Ajustes; #/memoria/<id> señala un hecho por su id (el
  // texto del hecho nunca va en la URL).
  if (seccion === 'memoria') { await verPanel('ajustes'); resaltar('ajustes', detalle || 'memoria'); return; }
  if (!['vista', 'apps', 'tareas', 'vault', 'skills', 'permisos', 'ajustes'].includes(seccion)) return;
  await verPanel(seccion);
  if (detalle) resaltar(seccion, detalle);
}

// Señala un elemento dentro del panel (una tarea, una skill, la sección
// «Acerca de»…): lo trae a la vista, lo marca y le da el foco.
function resaltar(seccion, detalle) {
  const panel = $('panel-' + seccion);
  const sel = `[data-ruta="${CSS.escape(detalle)}"]`;
  const tryIt = (n = 0) => {
    const el = panel?.querySelector(sel);
    if (!el) { if (n < 20) setTimeout(() => tryIt(n + 1), 50); return; }
    panel.querySelectorAll('.resaltado').forEach(e => e.classList.remove('resaltado'));
    el.classList.add('resaltado');
    el.querySelector('details')?.setAttribute('open', '');   // p. ej. el texto de una skill
    if (!el.hasAttribute('tabindex') && !/^(BUTTON|A|INPUT|DETAILS|SUMMARY)$/.test(el.tagName)) el.tabIndex = -1;
    el.scrollIntoView({ block: 'nearest' });
    try { el.focus({ preventScroll: true }); } catch { /* — */ }
  };
  tryIt();
}

// El selector de modelo es un <select>: se enfoca y, donde se puede, se
// despliega. Es a donde llevan los «elige un modelo arriba» del chat.
export function enfocarSelectorModelo() {
  const sel = $('model-select');
  if (!sel) return;
  sel.focus();                       // está en la cabecera: a la vista en los dos lados del móvil
  try { sel.showPicker?.(); } catch { /* sin gesto de usuario no se despliega: queda enfocado */ }
}

// Skills en su propia pestaña (visible y descubrible)
export function refreshSkillsPanel() {
  const panel = $('panel-skills');
  panel.replaceChildren(el('h3', null, tr('skillsTitle')));
  panel.appendChild(el('p', 'muted', tr('skillsDesc')));
  renderSkills(panel);
}

function card(...children) {
  const c = document.createElement('div');
  c.className = 'card';
  c.append(...children);
  return c;
}
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
// Un botón ocupado (o ya hecho, como una skill instalada) se marca con
// aria-disabled y NO con disabled: desactivar el botón que tiene el foco lo saca
// del foco y el teclado cae a <body> (lo mismo que hace ■, ver setStopping).
// Mientras está marcado, su clic no hace nada.
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.onclick = e => { if (b.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; } return onClick(e); };
  return b;
};
function ocupado(b, on, { hecho = false } = {}) {
  if (!b) return;
  if (on) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
  if (on && !hecho) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
}
// Tras repintar una lista, el foco va al mismo control de la fila que ocupa
// ahora el sitio de la que se fue (la siguiente), o de la anterior si era la
// última; sin filas, a `respaldo` (el título de la sección, un campo…). Antes
// caía a <body> y quien usa el teclado o un lector de pantalla volvía a empezar
// desde arriba tras cada acción. Solo si el foco se perdió: si ya está en otra
// parte (otro panel, el chat), no se toca; y solo si el destino está a la vista.
const focoPerdido = () => !document.activeElement || document.activeElement === document.body;
function enfocar(destino) {
  if (!destino?.isConnected || !destino.getClientRects().length) return false;
  if (!destino.matches('button, a[href], input, select, textarea, summary') && !destino.hasAttribute('tabindex')) destino.tabIndex = -1;
  try { destino.focus(); } catch { return false; }
  return document.activeElement === destino;
}
function enfocarFila(filas, i, selector, respaldo) {
  if (!focoPerdido()) return;
  const lista = [...filas];
  const fila = lista.length ? lista[Math.max(0, Math.min(i, lista.length - 1))] : null;
  if (!enfocar(fila && (selector ? fila.querySelector(selector) : fila))) enfocar(respaldo);
}

// ---------- panel apps ----------
export async function refreshApps() {
  const list = await apps.allApps();
  const panel = $('panel-apps');
  panel.replaceChildren(el('h3', null, tr('appsTitle')));
  if (!list.length) {
    panel.appendChild(el('p', 'muted', tr('appsEmpty')));
    return;
  }
  for (const app of list) {
    const c = card(
      el('b', null, app.name),
      el('span', 'muted', new Date(app.created).toLocaleString(uiLang())),
      // Por apps.open(): así la app abierta es ESTA también para el modelo
      // (CONTEXTO AHORA), no solo en pantalla.
      btn(tr('open'), 'primary', () => { aperturaManualT = Date.now(); apps.open({ name: app.name }).catch(e => toast('⚠️ ' + e.message)); }),
      botonBorrarApp(app),
    );
    c.dataset.app = app.name;
    panel.appendChild(c);
  }
}
// 🗑 con nombre propio y «Deshacer» (borraba al instante, sin vuelta atrás). Si
// era la app abierta, el visor se vacía (ver apps.setOnRemoved en init). El foco
// va al 🗑 de la app que queda en su sitio y, tras «Deshacer», al de la devuelta.
function botonBorrarApp(app) {
  const b = btn('🗑', 'ghost', async () => {
    const panel = $('panel-apps');
    const i = [...panel.querySelectorAll('.card[data-app]')].indexOf(b.closest('.card'));
    await apps.removeApp({ name: app.name });
    await refreshApps();
    enfocarFila(panel.querySelectorAll('.card[data-app]'), i, '.borrar-app', panel.querySelector('h3'));
    toast(tr('appRemoved', { name: app.name }), { accion: { label: tr('undo'), run: async () => {
      try {
        await apps.restoreApp(app);
        await refreshApps();
        enfocarFila(panel.querySelectorAll(`.card[data-app="${CSS.escape(app.name)}"]`), 0, '.borrar-app');
      } catch (e) { toast('⚠️ ' + e.message); }
    } } });
  });
  b.classList.add('borrar-app');
  b.title = tr('appDelL', { name: app.name });
  b.setAttribute('aria-label', tr('appDelL', { name: app.name }));
  return b;
}
// El visor deja de enseñar una app borrada.
function vaciarVisor() {
  const f = $('appframe');
  f.hidden = true;
  f.srcdoc = '';
  f.title = tr('appFrameEmpty');
  $('vista-empty').hidden = false;
  if (/^#\/apps\//.test(location.hash)) rutas.reflejar('apps');
}

// ---------- panel tareas ----------
// Un repintado a la vez: «Ejecutar ahora» repinta, y la tarea que lanza también
// (tareasCambiaron). Dos a la vez se pisaban, y el último en llegar tiraba los
// botones en los que ya se había puesto el foco. Quien llama mientras uno está
// en marcha espera a ese, que repinta otra vez al terminar.
let tareasPintando = null, tareasOtraVez = false;
export function refreshTasks() {
  if (tareasPintando) { tareasOtraVez = true; return tareasPintando; }
  tareasPintando = (async () => {
    do { tareasOtraVez = false; await pintarTareas(); } while (tareasOtraVez);
  })().finally(() => { tareasPintando = null; });
  return tareasPintando;
}
// Tras quitar una tarea o una automatización, el foco va al mismo botón de la
// fila que queda en su sitio; tras «Ejecutar ahora», al 🗑 de esa tarea (ya no
// tiene «Ejecutar ahora»). Dónde estaba la fila se mira AL PULSAR, antes de
// esperar nada: si otro repintado llega entretanto, la fila ya no está.
function posicionEnTareas(boton) {
  const fila = boton.closest('[data-ruta]');
  const auto = !!fila?.closest('.automatizaciones');
  const grupo = auto ? '.automatizaciones .card[data-ruta]' : '.card[data-tarea]';
  return { auto, grupo, i: [...$('panel-tareas').querySelectorAll(grupo)].indexOf(fila), ruta: fila?.dataset.ruta };
}
async function repintarTareasYEnfocar({ auto, grupo, i, ruta }, { misma = false } = {}) {
  const panel = $('panel-tareas');
  await refreshTasks();
  const titulo = panel.querySelector(auto ? '.automatizaciones h3' : 'h3');
  if (misma) enfocarFila(panel.querySelectorAll(`.card[data-ruta="${CSS.escape(ruta || '')}"]`), 0, '.borrar-tarea', titulo);
  else enfocarFila(panel.querySelectorAll(grupo), i, auto ? '.quitar-auto' : '.borrar-tarea', titulo);
}
async function pintarTareas() {
  const [list, watches] = await Promise.all([
    db.all('tasks').then(l => l.sort((a, b) => a.when - b.when)),
    watch.allWatches().catch(() => []),
  ]);
  const panel = $('panel-tareas');
  panel.replaceChildren(el('h3', null, tr('tasksTitle')));
  if (!list.length) panel.appendChild(el('p', 'muted', tr('tasksEmpty')));
  for (const t of list) {
    const estado = el('span', null, t.done ? '✅' : '⏳');
    estado.title = t.done ? tr('taskDone') : tr('taskPending');
    estado.setAttribute('aria-label', estado.title);
    const id = el('code', null, t.id);        // el id que nombran los avisos del chat
    id.title = tr('taskId');
    const fila = [estado, el('b', null, t.prompt), el('span', 'muted', new Date(t.when).toLocaleString(uiLang())), id];
    if (!t.done) {
      const ya = btn(tr('taskRunNow'), 'ghost', async () => {
        const pos = posicionEnTareas(ya);
        ocupado(ya, true);
        const hecha = await tasks.marcarHecha(t.id);
        if (hecha) onRunTaskCb(hecha);
        await repintarTareasYEnfocar(pos, { misma: true });
      });
      ya.setAttribute('aria-label', tr('taskRunNowL', { prompt: t.prompt }));
      fila.push(ya);
    }
    const borrar = btn('🗑', 'ghost', async () => {
      const pos = posicionEnTareas(borrar);
      await tasks.removeTask({ id: t.id });
      toast(tr('taskDeleted', { id: t.id }));
      await repintarTareasYEnfocar(pos);
    });
    borrar.className = 'ghost borrar-tarea';
    borrar.title = tr('taskDelL', { prompt: t.prompt });
    borrar.setAttribute('aria-label', tr('taskDelL', { prompt: t.prompt }));
    fila.push(borrar);
    const c = card(...fila);
    c.dataset.ruta = t.id;          // #/tareas/<id>
    c.dataset.tarea = '1';
    panel.appendChild(c);
  }
  // Automatizaciones de carpetas (fs.watch): antes no tenían interfaz; solo se
  // podían ver o quitar pidiéndoselo al chat.
  const sec = el('section', 'automatizaciones');
  sec.dataset.ruta = 'automatizaciones';    // #/tareas/automatizaciones
  sec.appendChild(el('h3', null, tr('watchTitle')));
  if (!watches.length) sec.appendChild(el('p', 'muted', tr('watchEmpty')));
  for (const w of watches) {
    const x = btn('✕', 'ghost', async () => {
      const pos = posicionEnTareas(x);
      await watch.removeWatch({ id: w.id });
      toast(tr('watchRemoved', { id: w.id }));
      await repintarTareasYEnfocar(pos);
    });
    x.className = 'ghost quitar-auto';
    x.title = tr('watchDelL', { from: w.from, to: w.to });
    x.setAttribute('aria-label', x.title);
    const c = card(el('span', null, '👁'), el('b', null, `${w.from} → ${w.to}`),
      el('span', 'muted', `${w.pattern || '*'} · ${tr('watchSeen', { n: Object.keys(w.seen || {}).length })}`), el('code', null, w.id), x);
    c.dataset.ruta = w.id;
    sec.appendChild(c);
  }
  panel.appendChild(sec);
}
// El kernel manda a la cola una tarea lanzada a mano («Ejecutar ahora»).
let onRunTaskCb = () => {};
export function setOnRunTask(fn) { onRunTaskCb = fn; }
// Algo ha cambiado en tareas o automatizaciones (una tarea se lanzó, una
// automatización procesó un fichero): si el panel está abierto, se repinta. Se
// quedaba con ⏳ después de que la tarea se hubiera lanzado.
export function tareasCambiaron() { if (tabActiva() === 'tareas') refreshTasks(); }

// ---------- panel vault ----------
// Lo que haces aquí lo haces tú: no pasa por el permiso «Bóveda», que es el del
// agente (ver tools/vault.js, `desdePanel`). Y el panel se repinta cuando la
// bóveda se cierra sola: antes seguía ofreciendo «Bloquear ahora» y un secreto
// revelado se quedaba en claro.
const VAULT_REVELADO_MS = 30000;   // un secreto a la vista se vuelve a tapar solo
let vaultOyente = null, vaultRepintado = Promise.resolve();
const tabActiva = () => document.querySelector('#tabs button.active')?.dataset.tab;
export async function refreshVault() {
  vaultOyente ||= vault.alBloquear(motivo => {
    if (tabActiva() === 'vault') vaultRepintado = refreshVault();
    if (motivo === 'auto') toast(tr('vaultAutoLocked'));
  });
  const panel = $('panel-vault');
  panel.replaceChildren(el('h3', null, tr('vaultTitle')));
  const setup = await vault.isSetup();

  if (!vault.isUnlocked()) {
    panel.appendChild(el('p', 'muted', setup ? tr('vaultLocked') : tr('vaultUnset')));
    // Un <form>: Enter envía como el botón, sin un keydown a mano.
    const form = el('form', 'row');
    const input = el('input');
    input.type = 'password';
    input.id = 'vault-master';
    input.autocomplete = setup ? 'current-password' : 'new-password';
    input.placeholder = tr('vaultMasterPh');
    input.setAttribute('aria-label', tr('vaultMasterPh'));
    const go = el('button', 'primary', setup ? tr('vaultUnlock') : tr('vaultCreate'));
    go.type = 'submit';
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (!input.value) { input.focus(); return; }
      go.disabled = true;
      try {
        await vault.unlock(input.value, { desdePanel: true });
        toast(setup ? tr('vaultUnlockedT') : tr('vaultCreatedT'));
        await refreshVault();
        panel.querySelector('#vault-name')?.focus();
      } catch (err) {
        go.disabled = false;
        toast('⚠️ ' + (/incorrecta/.test(err.message) ? tr('vaultWrongPw') : err.message));
        input.select();
      }
    });
    form.append(input, go);
    panel.appendChild(form);
    return;
  }

  const estado = el('div', 'row between');
  // Al bloquear el panel se repinta (y el botón desaparece): el foco va a la
  // contraseña, que es lo siguiente que se usa; antes caía a <body>.
  estado.append(el('span', 'muted', tr('vaultOpenState')),
    btn(tr('vaultLockNow'), 'ghost', async () => {
      vault.lock();                     // el oyente de alBloquear repinta el panel…
      toast(tr('vaultLockedNow'));
      await vaultRepintado;             // …y se espera a ese repintado, sin pintar dos veces
      $('panel-vault').querySelector('#vault-master')?.focus();
    }));
  panel.appendChild(estado);

  const form = el('form', 'row');
  const name = el('input');
  name.id = 'vault-name';
  name.placeholder = tr('vaultNamePh');
  name.setAttribute('aria-label', tr('vaultNameL'));
  const secret = el('input');
  secret.type = 'password';
  secret.autocomplete = 'off';
  secret.placeholder = tr('vaultSecretPh');
  secret.setAttribute('aria-label', tr('vaultSecretL'));
  const add = el('button', 'primary', tr('save'));
  add.type = 'submit';
  form.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await vault.setSecret({ name: name.value.trim(), secret: secret.value }, { desdePanel: true });
      toast(tr('vaultSavedT', { name: name.value.trim() }));
      name.value = secret.value = '';
      await refreshVault();
      panel.querySelector('#vault-name')?.focus();
    } catch (err) { toast('⚠️ ' + err.message); }
  });
  form.append(name, secret, add);
  panel.appendChild(form);

  for (const n of await vault.secretNames()) {
    const val = el('code', null, '••••••');
    let tapar = null;
    const ver = btn('👁', 'ghost', async () => {
      if (ver.getAttribute('aria-pressed') === 'true') { ocultar(); return; }
      try {
        val.textContent = await vault.getSecret({ name: n }, { desdePanel: true });
        ver.setAttribute('aria-pressed', 'true');
        ver.title = tr('vaultHide', { name: n });
        clearTimeout(tapar);
        tapar = setTimeout(ocultar, VAULT_REVELADO_MS);
      } catch (err) { toast('⚠️ ' + err.message); refreshVault(); }
    });
    const ocultar = () => {
      clearTimeout(tapar);
      val.textContent = '••••••';
      ver.setAttribute('aria-pressed', 'false');
      ver.title = tr('vaultShow', { name: n });
    };
    ver.setAttribute('aria-pressed', 'false');
    ver.title = tr('vaultShow', { name: n });
    ver.setAttribute('aria-label', tr('vaultShowL', { name: n }));
    // Tras borrar, el foco va al 🗑 del secreto que queda en su sitio o, si no
    // queda ninguno, al nombre de uno nuevo.
    const borrar = btn('🗑', 'ghost', async () => {
      if (!window.confirm(tr('vaultDelConfirm', { name: n }))) return;
      const i = [...panel.querySelectorAll('.card[data-secreto]')].indexOf(borrar.closest('.card'));
      try { await vault.removeSecret({ name: n }); toast(tr('vaultDeleted', { name: n })); }
      catch (err) { toast('⚠️ ' + err.message); }
      await refreshVault();
      enfocarFila(panel.querySelectorAll('.card[data-secreto]'), i, '.borrar-secreto', panel.querySelector('#vault-name, #vault-master'));
    });
    borrar.className = 'ghost borrar-secreto';
    borrar.title = tr('vaultDel', { name: n });
    borrar.setAttribute('aria-label', tr('vaultDel', { name: n }));
    const c = card(el('b', null, n), val, ver, borrar);
    c.dataset.secreto = n;
    panel.appendChild(c);
  }
}

// ---------- panel permisos ----------
// Un repintado a la vez, como en Tareas: el panel se pinta en dos tiempos (los
// permisos, y tras leer las carpetas, las carpetas), y dos a la vez —revocar
// mientras se cierra un diálogo de permiso— duplicaban las carpetas.
let permisosPintando = null, permisosOtraVez = false;
export function refreshPerms() {
  if (permisosPintando) { permisosOtraVez = true; return permisosPintando; }
  permisosPintando = (async () => {
    do { permisosOtraVez = false; await pintarPermisos(); } while (permisosOtraVez);
  })().finally(() => { permisosPintando = null; });
  return permisosPintando;
}
async function pintarPermisos() {
  const panel = $('panel-permisos');
  panel.replaceChildren(el('h3', null, tr('permsTitle')));
  const g = perms.grants();
  if (!g.length)
    panel.appendChild(el('p', 'muted', tr('permsEmpty')));
  // Tras revocar (o quitar una carpeta), el foco va al mismo botón de la fila
  // que queda en su sitio, o al título si ya no queda ninguna.
  for (const scope of g) {
    const meta = perms.SCOPES[scope] || {};
    const revocar = btn(tr('revoke'), 'ghost', async () => {
      const i = [...panel.querySelectorAll('.card[data-permiso]')].indexOf(revocar.closest('.card'));
      perms.revoke(scope);
      await refreshPerms();
      enfocarFila(panel.querySelectorAll('.card[data-permiso]'), i, 'button', panel.querySelector('h3'));
    });
    const c = card(
      el('b', null, `${meta.icon || ''} ${meta.label || scope}`),
      el('span', 'muted', meta.desc || ''),
      revocar,
    );
    c.dataset.permiso = scope;
    panel.appendChild(c);
  }
  const folders = await fs.folders();
  if (folders.length) {
    panel.appendChild(el('h3', null, tr('foldersTitle')));
    // Dónde escribe la Mente: en la primera carpeta (ceo-adapter.js).
    panel.appendChild(el('p', 'muted', tr('folderSoulNote', { name: folders[0] })));
    for (const f of folders) {
      const quitar = btn(tr('remove'), 'ghost', async () => {
        const i = [...panel.querySelectorAll('.card[data-carpeta]')].indexOf(quitar.closest('.card'));
        if (!(await quitarCarpeta(f, folders))) return;
        enfocarFila(panel.querySelectorAll('.card[data-carpeta]'), i, 'button',
          panel.querySelector('.card[data-permiso] button') || panel.querySelector('h3'));
      });
      quitar.setAttribute('aria-label', tr('folderRemoveL', { name: f }));
      const c = card(el('b', null, '📁 ' + f), quitar);
      c.dataset.ruta = f;           // #/permisos/<carpeta>
      c.dataset.carpeta = '1';
      panel.appendChild(c);
    }
  }
}
// Quitar una carpeta pide confirmación y dice qué arrastra: las automatizaciones
// que la usan (que si no seguían sondeándola y fallando en silencio) y, si es la
// primera, que la Mente pasará a escribir en la siguiente.
async function quitarCarpeta(f, folders) {
  const dependientes = (await watch.allWatches().catch(() => [])).filter(w => w.from === f || w.to === f);
  let txt = tr('folderRemoveConfirm', { name: f });
  if (dependientes.length) txt += '\n\n' + tr('folderRemoveWatches', { list: dependientes.map(w => `${w.from} → ${w.to}`).join(', ') });
  if (folders[0] === f) txt += '\n\n' + (folders[1] ? tr('folderRemoveSoulNext', { next: folders[1] }) : tr('folderRemoveSoulNone'));
  if (!window.confirm(txt)) return false;
  for (const w of dependientes) await watch.removeWatch({ id: w.id }).catch(() => {});
  await db.del('fs', f);
  toast(tr('folderRemoved', { name: f }) + (dependientes.length ? ' · ' + tr('folderRemovedWatches', { n: dependientes.length }) : ''));
  await refreshPerms();
  return true;
}

// ---------- progreso y estado del modelo ----------
// Escaparate de descarga: mientras baja el modelo y NO hay app abierta, mostramos
// la galaxia + carrusel de mini-UIs en el panel Vista (en móvil evita la caja
// flotante que se solapaba con el compositor). Con app abierta → caja flotante.
let _stage = null;
async function _loadStage() { if (!_stage) _stage = await import('./loading-stage.js'); return _stage; }
function _pct(p) {
  if (typeof p === 'string') return p;
  if (p && p.status === 'progress' && p.total) return Math.round(p.loaded / p.total * 100);
  return p;
}
// El escaparate se monta en la Vista SOLO si ya la estás mirando. Antes cada
// cambio de cerebro —también uno remoto, que ni descarga— te llevaba a la Vista
// (estando en Ajustes, saltabas a la Vista) y en el móvil te sacaba del chat.
//
// El módulo del escaparate se importa al vuelo, y un cerebro que carga al
// momento (un proveedor externo) llamaba a modelProgress(null) antes de que
// llegara: no había escaparate que quitar, y al llegar se montaba y se quedaba
// para siempre con «Preparando tu sistema operativo…». `_finCargas` cuenta las
// cargas terminadas: si cambió mientras se esperaba, no se monta (o se quita).
let _finCargas = 0;
async function _showStage(p) {
  const pedido = _finCargas;
  const st = await _loadStage();
  if (pedido !== _finCargas) return;
  if (!st.isMounted()) await st.show($('panel-vista'), $('vista-empty'));
  if (pedido !== _finCargas) { st.hide($('vista-empty'), $('appframe').hidden !== false); return; }
  st.setProgress(_pct(p));
}
const mirandoLaVista = () => tabActiva() === 'vista' && (!isMobile() || document.body.classList.contains('show-viz'));

export function modelProgress(p) {
  const box = $('model-progress');
  const appHidden = $('appframe').hidden !== false;   // ¿aún no hay app abierta?
  if (p == null) {                                     // carga terminada
    _finCargas++;                                      // (ver _showStage)
    box.hidden = true;
    _stage?.hide?.($('vista-empty'), appHidden);
    return;
  }
  if (appHidden && (mirandoLaVista() || _stage?.isMounted?.())) { box.hidden = true; _showStage(p); return; }

  box.hidden = false;
  // La barra es una barra de progreso de verdad para un lector de pantalla.
  const track = box.querySelector('.track');
  const anunciar = pct => {
    if (pct == null) track.removeAttribute('aria-valuenow');
    else track.setAttribute('aria-valuenow', String(pct));
    track.setAttribute('aria-valuetext', $('model-progress-text').textContent || '');
  };
  if (typeof p === 'string') {
    $('model-progress-text').textContent = p;
    // Sacar el % del texto, igual que hace el escaparate (loading-stage.js).
    // Los proveedores informan con cadenas del tipo «… · 42 %», y este camino
    // —la caja flotante, o sea con la app abierta— las daba TODAS por
    // desconocidas: la barra se quedaba animada de principio a fin aunque el
    // porcentaje viniera dentro. Con un modelo de gigabytes eso es la
    // diferencia entre ver que avanza y creer que se ha colgado.
    const m = p.match(/(\d+)\s*%/);
    if (m) {
      $('model-bar').classList.remove('indet');
      $('model-bar').style.width = Math.min(100, +m[1]) + '%';
      anunciar(Math.min(100, +m[1]));
    } else {
      $('model-bar').classList.add('indet');  // sin % conocido → barra animada
      $('model-bar').style.width = '';
      anunciar(null);
    }
    return;
  }
  if (p.status === 'progress' && p.total) {
    const pct = Math.round(p.loaded / p.total * 100);
    $('model-bar').classList.remove('indet');
    $('model-bar').style.width = pct + '%';
    $('model-progress-text').textContent =
      `Descargando modelo · ${pct}% · ${(p.loaded / 1e6 | 0)}/${(p.total / 1e6 | 0)} MB`;
    anunciar(pct);
  }
}

// Mientras carga un cerebro el selector se desactiva: elegir otro a la vez
// arrancaba una segunda carga en paralelo. Un control desactivado pierde el
// foco (cae a <body>), así que se recuerda y, al terminar, el foco vuelve al
// selector si nadie lo ha llevado a otra parte mientras tanto.
let selectorTeniaFoco = false;
export function modeloCargando(on) {
  const sel = $('model-select');
  if (on) selectorTeniaFoco = selectorTeniaFoco || document.activeElement === sel;
  sel.disabled = !!on;
  if (on) sel.setAttribute('aria-busy', 'true'); else sel.removeAttribute('aria-busy');
  if (!on && selectorTeniaFoco) {
    selectorTeniaFoco = false;
    if (!document.activeElement || document.activeElement === document.body) {
      try { sel.focus({ preventScroll: true }); } catch { /* — */ }
    }
  }
}

// ⓘ junto al selector: la ficha del modelo cargado en Hugging Face (un
// <option> no puede llevar enlace). Sin ficha pública, no hay ⓘ. Nunca se
// enlazan los ficheros de pesos.
let fichaModelo = null;
export function setFichaModelo(url, nombre = '') {
  fichaModelo = url ? { url, nombre } : null;
  const a = $('model-card');
  if (!a) return;
  a.hidden = !url;
  if (url) {
    a.href = url;
    a.title = tr('modelCardL', { name: nombre });
    a.setAttribute('aria-label', a.title);
  }
}

export function modelStatus(state) { // 'off' | 'loading' | 'on' | 'gpu'
  const d = $('model-status');
  d.className = 'dot ' + state;
  // El punto solo era color (y un title en español): ahora dice el estado, en su
  // nombre accesible y, en corto, con palabras a la vista junto a él.
  const txt = tr({ off: 'modelStOff', loading: 'modelStLoading', on: 'modelStOn', gpu: 'modelStGpu' }[state] || 'modelStOff');
  d.title = txt;
  d.setAttribute('aria-label', txt);
  const corto = $('model-status-txt');
  if (corto) {
    corto.textContent = tr({ off: 'modelStOffShort', loading: 'modelStLoadingShort', on: 'modelStOnShort', gpu: 'modelStGpuShort' }[state] || 'modelStOffShort');
    corto.className = 'model-st-txt ' + state;
  }
}

// ---------- selector de modelo (dinámico) ----------
export function rebuildModelSelect(options, current) {
  const sel = $('model-select');
  sel.replaceChildren();
  // Los grupos van SIEMPRE al final, pase lo que pase con el orden de la lista.
  // Se creaban según aparecían, y bastó meter un cerebro agrupado en mitad de la
  // lista para que «Básico (sin modelo)» —la opción más segura que hay— quedara
  // colgando por debajo del encabezado «⚠ Avanzado», como si fuera uno de ellos.
  const groups = new Map();   // label de optgroup → <optgroup>
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = etiquetaModelo(o.label);
    if (o.group) {            // cerebros «Avanzado · poco rendimiento» agrupados y avisados
      let g = groups.get(o.group);
      if (!g) { g = document.createElement('optgroup'); g.label = etiquetaModelo(o.group); groups.set(o.group, g); }
      g.appendChild(opt);
    } else {
      sel.appendChild(opt);
    }
  }
  for (const g of groups.values()) sel.appendChild(g);
  if (current && options.some(o => o.id === current)) sel.value = current;
}

export function setModel(id) { $('model-select').value = id; }

// Las etiquetas del selector se escriben en español (kernel.js). Fuera del
// español se traducen sus coletillas —«por defecto», «ligero», «Básico (sin
// modelo)»…—, que era lo que quedaba en español en todos los idiomas; los
// nombres de modelo y los tamaños se quedan como están.
const COLETILLAS = [
  ['Básico (sin modelo)', 'optBasic'],
  ['⚠ Avanzado · sin garantía de rendimiento', 'optWeakGroup'],
  ['⚠ Avanzado', 'optAdvanced'],
  ['se guarda: solo se baja la primera vez', 'optSavedOnce'],
  ['se guarda', 'optSaved'],
  ['más ligero, carga antes', 'optLighter'],
  ['poco rendimiento', 'optWeak'],
  ['por defecto', 'optDefault'],
  ['— ligero', 'optLight'],
  ['— texto', 'optText'],
  ['— lento', 'optSlow'],
  [' · nube', 'optCloud'],
];
function etiquetaModelo(label) {
  if (uiLang() === 'es') return label;
  let out = String(label);
  for (const [es, k] of COLETILLAS) if (out.includes(es)) out = out.split(es).join(tr(k));
  return out;
}


// Consumo en vivo: qué está gastando Elffuss ahora mismo y cómo soltarlo.
// Se refresca solo mientras el panel está abierto.
function usageCard() {
  const card = el('div', 'card col');
  card.appendChild(el('b', null, '📊 ' + tr('useTitle')));
  const ram = el('div', 'row between'), disk = el('div', 'row between'), brain = el('div', 'row between');
  const mk = (row, label) => { row.appendChild(el('span', 'muted', label)); const v = el('span', null, '…'); row.appendChild(v); card.appendChild(row); return v; };
  const vRam = mk(ram, tr('useRam')), vDisk = mk(disk, tr('useDisk')), vBrain = mk(brain, tr('useBrain'));
  const gb = n => n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : Math.round(n / 1048576) + ' MB';
  const freeBtn = btn(tr('useFree'), 'ghost', () => { onFreeModelCb(); toast(tr('useFreed')); setTimeout(paint, 400); });
  card.appendChild(freeBtn);
  let timer = null;
  async function paint() {
    const m = performance.memory;
    vRam.textContent = m?.jsHeapSizeLimit
      ? `${gb(m.usedJSHeapSize)} / ${gb(m.jsHeapSizeLimit)} (${Math.round(m.usedJSHeapSize / m.jsHeapSizeLimit * 100)}%)`
      : tr('useNoRam');
    // Este origen (estimate) más el almacén compartido, medido por model-storage.js
    // como el chip y «Vaciar caché»: el modelo grande vive en los brokers de sus
    // hosts y estimate() no lo ve. Sin camino al compartido no hay «?».
    const [{ usage, quota, persisted }, m2] = await Promise.all([cacheEstimate(), modelos.medir()]);
    const comp = { usage: m2.compartido, ok: m2.compartidoOk || !m2.hayCompartido };
    vDisk.textContent = `${gb(usage + comp.usage)}${quota ? ' / ' + gb(quota) : ''} ${persisted ? '· ✓' : '· ⚠'}` + (comp.ok ? '' : ' · ?');
    const sel = $('model-select');
    vBrain.textContent = sel ? (sel.options[sel.selectedIndex]?.textContent || '—').slice(0, 34) : '—';
    if (fichaModelo) {             // la ficha del modelo, también aquí
      const a = document.createElement('a');
      a.href = fichaModelo.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = ' ⓘ';
      a.title = tr('modelCardL', { name: fichaModelo.nombre });
      a.setAttribute('aria-label', a.title);
      vBrain.appendChild(a);
    }
    // Sin modelo cargado el botón se esconde; si tenía el foco (acaba de
    // pulsarse), el foco pasa al título de la tarjeta y no cae a <body>.
    const sinModelo = !(sel && sel.value !== 'rules');
    if (sinModelo && document.activeElement === freeBtn) enfocar(card.querySelector(':scope > b'));
    freeBtn.style.display = sinModelo ? 'none' : '';
    // refrescar solo mientras se está viendo
    clearTimeout(timer);
    if (document.querySelector('#tabs button.active')?.dataset.tab === 'ajustes') timer = setTimeout(paint, 4000);
  }
  paint();
  return card;
}
let onFreeModelCb = () => {};
export function setOnFreeModel(fn) { onFreeModelCb = fn; }
let onWipeCb = async () => { await workspace.wipe({ confirm: 'BORRAR' }); location.reload(); };
export function setOnWipe(fn) { onWipeCb = fn; }

// ---------- espacio de trabajo (carpeta en disco, inventario, limpieza) ----------
const kb = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';

function workspaceCard() {
  const card = el('div', 'card col');
  card.appendChild(el('b', null, '💾 ' + tr('wsTitle')));
  card.appendChild(el('span', 'muted', tr('wsDesc')));

  const state = el('div', 'muted');
  const row = el('div', 'row');
  const inv = el('div', 'col');
  card.append(state, row, inv);

  // Repintar tira los botones de la fila: si el foco estaba en uno, va al primero
  // de la fila nueva («Guardar ahora», «Elegir carpeta»…), no a <body>.
  const repintar = async () => { await paint(); if (focoPerdido()) enfocar(row.querySelector('button')); };
  const paint = async () => {
    const st = workspace.status();
    row.replaceChildren();
    state.textContent = !st.supported.pick ? tr('wsNoSupport')
      : !st.folder ? tr('wsNoFolder')
      : st.ready ? tr('wsFolder', { name: st.folder }) + (st.lastSaveAt ? ' · ' + tr('wsSavedAt', { time: new Date(st.lastSaveAt).toLocaleTimeString() }) : '')
      : tr('wsNeedsPerm', { name: st.folder });

    if (st.supported.pick) {
      if (!st.folder) row.appendChild(btn(tr('wsPick'), 'primary', async () => {
        try { await workspace.pick(); toast(tr('wsPicked')); await repintar(); } catch (e) { toast('⚠️ ' + e.message); }
      }));
      else if (!st.ready) row.appendChild(btn(tr('wsRegrant'), 'primary', async () => {
        try { await workspace.regrant(); toast(tr('wsPicked')); await repintar(); } catch (e) { toast('⚠️ ' + e.message); }
      }));
      else {
        row.appendChild(btn(tr('wsSaveNow'), 'primary', async () => {
          try { const r = await workspace.save({ reason: 'manual' }); toast(r.ok ? tr('wsSaved', { n: r.wrote.length }) : '⚠️ ' + (r.errors[0]?.error || '')); await repintar(); }
          catch (e) { toast('⚠️ ' + (e.message === 'needs-regrant' ? tr('wsNeedsPerm', { name: st.folder }) : e.message)); await repintar(); }
        }));
        const auto = el('label', 'row');
        const chk = el('input'); chk.type = 'checkbox'; chk.checked = workspace.autosaveEnabled();
        chk.onchange = () => { workspace.autosave({ enabled: chk.checked }); toast(chk.checked ? tr('wsAutoOn') : tr('wsAutoOff')); };
        auto.append(chk, el('span', 'muted', tr('wsAuto')));
        row.appendChild(auto);
        row.appendChild(btn(tr('wsForget'), 'ghost', async () => { await workspace.forget(); await repintar(); }));
      }
    }
    // copia descargable: funciona en TODOS los navegadores (Safari/Firefox incluidos)
    row.appendChild(btn(tr('wsDownload'), 'ghost', async () => {
      const blob = await workspace.bundle();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `elffuss-claw-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }));

    // inventario: «ver qué hay» en cada almacén
    inv.replaceChildren(el('b', null, tr('wsWhat')));
    for (const it of await workspace.inventory()) {
      const line = el('div', 'row between');
      line.appendChild(el('span', null, `${it.icon} ${it.label}`));
      line.appendChild(el('span', 'muted', it.error ? '⚠️' : `${it.count} · ${kb(it.bytes)}${it.sensitive ? ' 🔒' : ''}`));
      inv.appendChild(line);
    }
    const danger = el('div', 'row');
    const wipe = btn(tr('wsWipe'), 'ghost', async () => {
      if (!window.confirm(tr('wsWipeConfirm'))) return;
      ocupado(wipe, true);                 // aria-disabled: sin perder el foco (ver btn)
      // Lo hace el kernel: para el turno en marcha, borra y RECARGA. Borrar solo
      // el IndexedDB dejaba la conversación en pantalla y en memoria, y el
      // siguiente mensaje la volvía a guardar entera; skills, bóveda abierta y
      // app actual también seguían vivas hasta recargar.
      try { await onWipeCb(); }
      catch (e) { ocupado(wipe, false); toast('⚠️ ' + (e?.message || e)); }
    });
    danger.appendChild(wipe);
    inv.appendChild(danger);
  };
  paint().catch(() => { state.textContent = '—'; });
  return card;
}

// ---------- panel ajustes (config avanzada de proveedores) ----------
export function refreshSettings() {
  const panel = $('panel-ajustes');
  panel.replaceChildren();
  // Lo que se consulta a menudo va PRIMERO: qué está gastando y cómo limpiarlo.
  // Los proveedores externos son configuración avanzada y bajan al final.
  panel.appendChild(usageCard());
  panel.appendChild(workspaceCard());
  panel.appendChild(memoriaCard());
  // Los modelos EXTERNOS (no locales) van al final, en su propia sección
  // plegada: son la excepción, no la norma — Elffuss corre en tu máquina.
  const ext = document.createElement('details');
  ext.className = 'card col ext-block';
  const extSum = document.createElement('summary');
  extSum.textContent = tr('extTitle');
  ext.appendChild(extSum);
  ext.appendChild(el('p', 'muted', tr('extDesc')));

  const cfgs = settings.configs();
  for (const [id, c] of Object.entries(cfgs)) {
    const wrap = el('div', 'card col');
    const head = el('div', 'row between');
    // La casilla con nombre: era una casilla suelta sin etiqueta.
    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.id = 'prov-' + id;
    toggle.checked = c.enabled;
    const title = el('label', 'prov-name', c.label);
    title.htmlFor = toggle.id;
    toggle.setAttribute('aria-label', tr('provEnableL', { label: c.label }));
    head.append(title, toggle);
    wrap.appendChild(head);
    // La ayuda de cada proveedor en el idioma de la página (settings.js la tiene
    // en español, que es lo que sale si no hay traducción).
    const kAyuda = 'provHelp_' + id, ayuda = tr(kAyuda);
    wrap.appendChild(el('span', 'muted', ayuda !== kAyuda ? ayuda : (c.help || '')));

    const model = el('input');
    model.placeholder = tr('modelPh');
    model.value = c.model || '';
    const base = el('input');
    base.placeholder = tr('endpointPh');
    base.value = c.baseURL || '';
    const key = el('input');
    key.type = 'password';
    key.placeholder = c.kind === 'anthropic' ? 'sk-ant-…' : (id === 'ollama' || id === 'server' ? tr('keyNeeded') : 'sk-…');
    key.value = c.apiKey || '';

    wrap.append(labeled(tr('lblModel'), model), labeled(tr('lblEndpoint'), base));
    if (id !== 'ollama' && id !== 'server') wrap.append(labeled(tr('lblApiKey'), key));

    const save = () => {
      settings.update(id, {
        enabled: toggle.checked,
        model: model.value.trim(),
        baseURL: base.value.trim(),
        apiKey: key.value,
      });
      onSettingsChangedCb();
    };
    // «Elígelo en el selector de modelo», con un botón que lleva a él (antes
    // decía «en el selector 🧠», y 🧠 abre la Mente).
    toggle.onchange = () => {
      save();
      if (toggle.checked) toast(tr('provOn', { label: c.label }), { accion: { label: tr('pickModel'), run: enfocarSelectorModelo } });
      else toast(tr('provOff', { label: c.label }));
    };
    wrap.appendChild(btn(tr('save'), 'primary', () => { save(); toast(tr('saved')); }));
    ext.appendChild(wrap);
  }

  // --- Almacenamiento del modelo (caché persistente) ---
  const store = el('div', 'card col');
  store.appendChild(el('b', null, tr('storeTitle')));
  const info = el('span', 'muted', tr('storeCalc'));
  store.appendChild(info);
  // Lo mismo que el chip 💾 (model-storage.js): cuenta solo pesos, y vacía los de
  // este origen y los del almacén compartido de CADA broker con modelos (antes
  // el modelo grande, guardado en los brokers de sus hosts, no se tocaba).
  // Ocupado con aria-disabled, no disabled: con disabled el foco caía a <body>
  // nada más pulsarlo (ver btn).
  const clearBtn = btn(tr('storeClear'), 'ghost', async () => {
    ocupado(clearBtn, true);
    info.textContent = tr('storeClearing');
    try { avisarLiberado(await modelos.vaciar()); }
    catch (e) { toast(tr('diskFail', { err: e?.message || e })); }
    ocupado(clearBtn, false);
    await paintStore();
  });
  store.appendChild(clearBtn);
  panel.appendChild(store);
  async function paintStore() {
    contarCompartido();             // Ajustes abierto: el chip ya puede preguntar al compartido
    const [{ total, compartido, compartidoOk, hayCompartido }, { quota, persisted }] = await Promise.all([modelos.medir(), cacheEstimate()]);
    const gb = n => (n / 1073741824).toFixed(2) + ' GB';
    info.textContent = (total >= UMBRAL_CHIP ? tr('storeCached', { gb: gb(total) }) : tr('storeNone'))
      + (persisted ? tr('storePersist') : tr('storeNoPersist'))
      + (quota ? tr('storeLimit', { gb: gb(quota) }) : '')
      + (!hayCompartido ? '' : !compartidoOk ? tr('storeSharedUnknown') : compartido ? tr('storeShared', { gb: gb(compartido) }) : '');
  }
  paintStore();

  // --- 📨 Errores y feedback (opt-in — apagado no sale NADA de tu máquina) ---
  const telCard = el('div', 'card col');
  telCard.innerHTML =
    `<b>${tr('telTitle')}</b>` +
    `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:6px">` +
    `<input type="checkbox" id="tel-enabled"> ` +
    `<span>${tr('telAuto')}</span>` +
    `</label>` +
    `<span class="muted">${tr('telPrivacy')}</span>` +
    `<label class="muted" for="tel-feedback" style="font-size:.8em;margin-top:4px">${tr('telManual')}</label>` +
    `<textarea id="tel-feedback" rows="2" style="width:100%;resize:vertical" placeholder="${tr('telPh')}"></textarea>`;
  // Dice si LLEGÓ: antes daba las gracias y vaciaba el texto aunque el envío
  // fallara. Si falla, el texto se queda y se ofrece el sitio público de
  // incidencias, que además deja un enlace para seguirlo.
  const telSendBtn = btn(tr('send'), 'primary', async () => {
    const ta = telCard.querySelector('#tel-feedback');
    const text = ta.value.trim();
    if (!text) { toast(tr('writeSomething')); ta.focus(); return; }
    ocupado(telSendBtn, true);            // aria-disabled: el foco se queda en «Enviar»
    const wasEnabled = telemetry.isEnabled();
    if (!wasEnabled) telemetry.setEnabled(true); // envío manual es explícito, se permite aunque el automático esté apagado
    let llego = false;
    try { llego = await telemetry.sendFeedback(text); }
    finally {
      if (!wasEnabled) telemetry.setEnabled(false); // no activa el automático de fondo si no lo pidió
      ocupado(telSendBtn, false);
    }
    if (llego) { ta.value = ''; toast(tr('sentThanks')); }
    else toast(tr('sendFailed'), { accion: { label: tr('openIssues'), run: () => window.open(ISSUES_URL, '_blank', 'noopener,noreferrer') } });
  });
  telCard.appendChild(telSendBtn);
  const alt = el('span', 'muted', tr('telIssues') + ' ');
  alt.appendChild(enlaceFuera(ISSUES_URL, 'git.elffuss.com/elffuss/claw/issues ↗'));
  telCard.appendChild(alt);
  panel.appendChild(telCard);
  panel.appendChild(ext);        // externos: lo último de todo
  telCard.querySelector('#tel-enabled').checked = telemetry.isEnabled();
  telCard.querySelector('#tel-enabled').onchange = e => telemetry.setEnabled(e.target.checked);

  panel.appendChild(acercaDe());
  panel.appendChild(el('p', 'muted', tr('skillsTabHint')));
}

// ---------- memoria ----------
// Lo que Elffuss recuerda de ti (memory.save) se veía solo como un número en
// «Qué hay guardado» o pidiéndoselo al chat. Aquí se ve y se olvida hecho a hecho.
function memoriaCard() {
  const c = el('div', 'card col');
  c.dataset.ruta = 'memoria';      // #/memoria
  pintarMemoria(c);
  return c;
}
// Tras olvidar un hecho, el foco va al ✕ del que queda en su sitio (o al título
// de la sección) y, tras «Deshacer», al del hecho devuelto.
async function pintarMemoria(c) {
  const hechos = (await db.all('memory').catch(() => [])).sort((a, b) => a.at - b.at);
  c.replaceChildren(el('b', null, tr('memTitle')), el('span', 'muted', tr('memDesc')));
  if (!hechos.length) c.appendChild(el('span', 'muted', tr('memEmpty')));
  for (const f of hechos) {
    const fila = el('div', 'row between');
    fila.dataset.ruta = f.id;       // #/memoria/<id>
    const x = btn('✕', 'ghost', async () => {
      const i = [...c.querySelectorAll('.row[data-ruta]')].indexOf(fila);
      await memory.forget({ id: f.id });
      await pintarMemoria(c);
      enfocarFila(c.querySelectorAll('.row[data-ruta]'), i, 'button', c.querySelector(':scope > b'));
      toast(tr('memForgotten'), { accion: { label: tr('undo'), run: async () => {
        await db.set('memory', f.id, f);
        await pintarMemoria(c);
        enfocarFila(c.querySelectorAll(`.row[data-ruta="${CSS.escape(f.id)}"]`), 0, 'button');
      } } });
    });
    x.title = tr('memForgetL', { fact: String(f.fact).slice(0, 60) });
    x.setAttribute('aria-label', x.title);
    fila.append(el('span', null, f.fact), x);
    c.appendChild(fila);
  }
}

// ---------- acerca de ----------
// Dónde está el código, dónde se cuentan los fallos y con qué licencia. No
// estaba en ninguna parte de la interfaz.
const REPO_URL = 'https://github.com/KikoCis/elffuss-claw';
const COMUNIDAD_URL = 'https://git.elffuss.com/elffuss/claw';
const ISSUES_URL = COMUNIDAD_URL + '/issues';
function enlaceFuera(href, texto) {
  const a = document.createElement('a');
  a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.textContent = texto;
  return a;
}
// El sello del build: un commit limpio enlaza a GitHub; «-dirty» (desplegado con
// cambios sin commitear, ver deploy.sh) no, porque ese commit no es lo que se
// sirve; en desarrollo no hay sello.
export function enlaceBuild(sello) {
  const s = String(sello || '').trim();
  if (/^[0-9a-f]{7,40}$/.test(s)) return enlaceFuera(`${REPO_URL}/commit/${s}`, s);
  if (/^[0-9a-f]{7,40}-dirty$/.test(s)) { const x = el('span', null, s); x.title = tr('buildDirty'); return x; }
  return el('span', null, tr('buildDev'));
}
function acercaDe() {
  const c = el('div', 'card col');
  c.dataset.ruta = 'acerca';      // #/ajustes/acerca
  c.appendChild(el('b', null, tr('aboutTitle')));
  const l1 = el('span', 'muted', tr('aboutCode') + ' ');
  l1.append(enlaceFuera(REPO_URL, 'github.com/KikoCis/elffuss-claw ↗'), ' · ' + tr('aboutCommunity') + ' ',
    enlaceFuera(COMUNIDAD_URL, 'git.elffuss.com/elffuss/claw ↗'), ' · ', enlaceFuera(ISSUES_URL, tr('aboutIssues') + ' ↗'));
  const l2 = el('span', 'muted', tr('aboutLicense') + ' · ' + tr('aboutBuild') + ' ');
  l2.appendChild(enlaceBuild($('build')?.dataset.sello || $('build')?.textContent));
  c.append(l1, l2);
  return c;
}

// Dos secciones que se repintan solas: lo instalado (con su contador) y las
// fuentes. Antes «Quitar» y «Añadir repo» llamaban a refreshSettings() —el panel
// de AJUSTES— y aquí no cambiaba nada hasta cambiar de pestaña; «Instalar» no
// tocaba el contador; «Explorar» añadía la lista al final del panel, una copia
// más por clic.
async function renderSkills(panel) {
  const instaladas = el('section', 'skills-instaladas');
  const fuentes = el('section', 'skills-fuentes');
  panel.append(instaladas, fuentes);
  pintarInstaladas(instaladas);
  await pintarFuentes(fuentes, instaladas);
}

// La skill instalada desde un repo enlaza a su SKILL.md; todas dejan ver lo
// que se inyecta al modelo (el panel lo prometía y no había forma de verlo).
const enlaceSkillMd = (repo, path, branch = 'HEAD') => {
  const a = document.createElement('a');
  a.href = `https://github.com/${repo}/blob/${encodeURIComponent(branch)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.className = 'repo-link';
  a.textContent = 'SKILL.md ↗';
  return a;
};
function pintarInstaladas(box) {
  const inst = skills.installed();
  // Encabezado de verdad (antes una línea gris que no se distinguía del texto):
  // «Instaladas» y «Explorar catálogos» son dos partes que no se mezclan. Si se
  // queda sin filas, el foco viene aquí.
  const h = el('h4', 'sk-h', tr('installedN', { n: inst.length }));
  h.tabIndex = -1;
  box.replaceChildren(h);
  for (const s of inst) {
    const c = el('div', 'card col');
    c.dataset.ruta = s.name;        // #/skills/<nombre>
    const fila = el('div', 'row between');
    const desdeRepo = s.repo && s.path && !String(s.path).startsWith('local/');
    const origen = desdeRepo ? enlaceSkillMd(s.repo, s.path) : el('span', 'muted', s.repo || 'local');
    // Quitar: el foco va al «Quitar» de la skill que queda en su sitio (o al
    // contador), y las listas de «Explorar» abiertas vuelven a ofrecer instalarla.
    const quitar = btn(tr('remove'), 'ghost quitar-skill', async () => {
      const i = [...box.querySelectorAll('.card[data-ruta]')].indexOf(c);
      await skills.remove(s.name);
      pintarInstaladas(box);
      actualizarListas();
      enfocarFila(box.querySelectorAll('.card[data-ruta]'), i, '.quitar-skill', box.firstElementChild);
      toast(tr('skillRemoved', { name: s.name }), { accion: { label: tr('undo'), run: async () => {
        try {
          await skills.install(s);
          pintarInstaladas(box);
          actualizarListas();
          enfocarFila(box.querySelectorAll(`.card[data-ruta="${CSS.escape(s.name)}"]`), 0, '.quitar-skill');
        } catch (e) { toast('⚠️ ' + e.message); }
      } } });
    });
    quitar.setAttribute('aria-label', tr('skillRemoveL', { name: s.name }));
    fila.append(el('b', null, s.name), el('span', 'muted', desdeRepo ? s.repo : ''), origen, quitar);
    const ver = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = tr('skillSeeText');
    const pre = el('pre', 'skill-text', [s.description, s.content].filter(Boolean).join('\n\n'));
    ver.append(sum, pre);
    c.append(fila, ver);
    box.appendChild(c);
  }
}

async function pintarFuentes(box, instaladas) {
  const srcs = await skills.sources();
  box.replaceChildren(el('h4', 'sk-h', tr('catalogsH')), el('p', 'muted sk-nota', tr('catalogsHint')));
  for (const src of srcs) {
    const c = el('div', 'card col');
    c.dataset.ruta = 'repo:' + src.repo;
    const fila = el('div', 'row between');
    const link = document.createElement('a');
    link.href = 'https://github.com/' + src.repo;
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.className = 'repo-link';
    link.textContent = src.repo + ' ↗';
    const lista = el('div', 'repo-skills');
    lista.id = 'repo-' + src.repo.replace(/[^\w-]/g, '-');
    lista.hidden = true;
    lista.setAttribute('aria-live', 'polite');
    const explorar = btn(tr('browse'), 'primary explorar-repo', () => explorarRepo(src.repo, lista, explorar, instaladas));
    explorar.setAttribute('aria-expanded', 'false');
    explorar.setAttribute('aria-controls', lista.id);
    fila.append(el('b', null, src.label), link, explorar);
    if (!src.official) {          // las que añadiste tú se pueden quitar
      // El foco va al «Explorar» del repo que queda en su sitio (o al campo
      // para añadir otro).
      const x = btn('✕', 'ghost', async () => {
        const i = [...box.querySelectorAll('.card[data-ruta]')].indexOf(c);
        await skills.removeSource(src.repo);
        toast(tr('repoRemoved', { repo: src.repo }));
        await pintarFuentes(box, instaladas);
        enfocarFila(box.querySelectorAll('.card[data-ruta]'), i, '.explorar-repo', box.querySelector('form input'));
      });
      x.title = tr('repoRemoveL', { repo: src.repo });
      x.setAttribute('aria-label', tr('repoRemoveL', { repo: src.repo }));
      fila.appendChild(x);
    }
    c.append(fila, lista);
    box.appendChild(c);
  }
  const form = el('form', 'row');
  const inp = el('input'); inp.placeholder = tr('repoPh');
  inp.setAttribute('aria-label', tr('repoPh'));
  const add = el('button', 'primary', tr('addRepo'));
  add.type = 'submit';
  form.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const repo = await skills.addSource(inp.value);
      inp.value = '';
      toast(tr('repoAdded', { repo }));
      await pintarFuentes(box, instaladas);
      box.querySelector(`[data-ruta="${CSS.escape('repo:' + repo)}"] button`)?.focus();
    } catch (err) { toast('⚠️ ' + err.message); }
  });
  form.append(inp, add);
  box.appendChild(form);
}

// El botón de una skill en la lista de «Explorar»: «Instalar», o «Instalada ✓»
// sin poder pulsarse. Su nombre accesible dice lo mismo que se ve (se quedaba en
// «Instalar: <nombre>» ya instalada). aria-disabled y no disabled: el foco no
// cae a <body> al instalar con el teclado (ver btn).
function pintarBotonInstalar(b, instalada, nombre) {
  b.textContent = instalada ? tr('installedOk') : tr('install');
  b.className = (instalada ? 'ghost' : 'primary') + ' instalar-skill';
  ocupado(b, instalada, { hecho: true });
  b.setAttribute('aria-label', (instalada ? tr('installedOk') : tr('install')) + ': ' + nombre);
}
// Las listas de «Explorar» ya pintadas dicen la verdad de lo instalado: al quitar
// una skill (o devolverla con «Deshacer») su botón vuelve a «Instalar» (o a
// «Instalada ✓»). Antes seguía «Instalada ✓» y desactivado, también al volver a
// abrir la lista, que no se repinta.
function actualizarListas() {
  for (const b of document.querySelectorAll('#panel-skills .repo-skills button.instalar-skill')) {
    if (b.getAttribute('aria-busy') === 'true') continue;          // instalándose ahora mismo
    pintarBotonInstalar(b, skills.isInstalled(b.dataset.repo, b.dataset.path), b.dataset.nombre);
  }
}

// La lista de un repo va DENTRO de su tarjeta y el botón la abre y la cierra.
// Mientras carga, el botón está ocupado (aria-disabled): el foco se queda en él.
async function explorarRepo(repo, lista, boton, instaladas) {
  if (!lista.hidden) {
    lista.hidden = true;
    boton.textContent = tr('browse');
    boton.setAttribute('aria-expanded', 'false');
    return;
  }
  lista.hidden = false;
  boton.setAttribute('aria-expanded', 'true');
  boton.textContent = tr('hideList');
  if (lista.dataset.cargada) { actualizarListas(); return; }
  ocupado(boton, true);
  lista.setAttribute('aria-busy', 'true');
  lista.replaceChildren(el('div', 'muted', tr('loadingRepo', { repo })));
  try {
    const found = await skills.listFromRepo(repo);
    lista.replaceChildren(el('div', 'muted', tr('repoSkills', { repo, n: found.length })));
    for (const sk of found.slice(0, 120)) {
      const c = el('div', 'card');
      const b = btn('', '', async () => {
        if (skills.isInstalled(sk.repo, sk.path)) return;
        ocupado(b, true);
        b.textContent = '…';
        try {
          const entry = await skills.installFromRepo(sk);
          pintarBotonInstalar(b, true, sk.name);
          pintarInstaladas(instaladas);
          actualizarListas();
          const msg = onSkillInstalledCb(entry);   // → mensaje «cómo usarla» en el chat
          // …y el aviso lleva a ese mensaje. Antes era un segundo botón en la
          // fila (dos acciones por fila) y, en el móvil, instalar te sacaba de
          // Skills al chat sin pedirlo: ahora te quedas donde estabas.
          toast(tr('skillInstalledToast', { name: entry.name }), msg ? { accion: { label: tr('skillSeeChat'), run: () => irAlMensaje(msg) } } : {});
        } catch (e) { pintarBotonInstalar(b, false, sk.name); toast('⚠️ ' + e.message); }
      });
      b.dataset.repo = sk.repo; b.dataset.path = sk.path; b.dataset.nombre = sk.name;
      pintarBotonInstalar(b, skills.isInstalled(sk.repo, sk.path), sk.name);
      c.append(el('b', null, sk.name), el('span', 'muted', sk.dir), enlaceSkillMd(sk.repo, sk.path, sk.branch || 'HEAD'), b);
      lista.appendChild(c);
    }
    lista.dataset.cargada = '1';
  } catch (e) {
    lista.replaceChildren(el('div', 'muted', '⚠️ ' + e.message));
  } finally {
    ocupado(boton, false);
    lista.removeAttribute('aria-busy');
  }
}

function labeled(label, input) {
  const row = el('label', 'field');
  row.append(el('span', 'muted', label), input);
  return row;
}

// ---------- botón enviar ↔ parar ----------
// Mientras Elffuss trabaja, #send es ■ y PARA (mismo icono, título y aria que
// en Elffuss Code). Va como type="button" a propósito: así un clic en él —con
// ratón, dedo o teclado— solo para, y Enter en la caja ya no pasa por el botón
// (sin botón de enviar, el formulario se envía directamente) y sigue mandando
// a la cola lo que escribas, que es como funciona la cola de Claw.
const STOP_ICON = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="2" y="2" width="10" height="10" rx="2" fill="currentColor"/></svg>';
let working = false, parando = false;
export function setWorking(on) {
  working = !!on;
  parando = false;
  const b = $('send');
  if (!b) return;
  b.type = working ? 'button' : 'submit';
  b.classList.toggle('is-stop', working);
  b.classList.remove('is-stopping');
  b.removeAttribute('aria-busy');
  b.removeAttribute('aria-disabled');
  b.innerHTML = working ? STOP_ICON : UI.send;
  b.title = working ? tr('stop') : tr('send');
  b.setAttribute('aria-label', b.title);
}

// «Parando…»: ya se pulsó ■ y el turno aún está soltando el modelo (un cerebro
// que no suelta al momento, una herramienta, Hard Work leyendo la carpeta…).
// Antes el ■ seguía igual tras el clic —rojo, «Parar», pulsable— y parecía que
// no había hecho caso. Mientras dura, los clics no hacen nada. Se marca con
// aria-disabled y NO con disabled: deshabilitar el botón que tiene el foco lo
// saca del foco y el teclado cae a <body> (lo mismo que en Elffuss Code).
// Vuelve a ➤ (o a ■ si arranca el siguiente de la cola) con setWorking().
export function setStopping() {
  const b = $('send');
  if (!b || !working) return;
  parando = true;
  b.classList.add('is-stopping');
  b.setAttribute('aria-busy', 'true');
  b.setAttribute('aria-disabled', 'true');
  b.textContent = tr('stopping');
  b.title = tr('stopping');
  b.setAttribute('aria-label', b.title);
}

// ---------- arranque ----------
export function init({ onSend, onStop = () => {}, onModelChange, onSettingsChanged, onPickFolder = () => onSend(tr('pFolder')) }) {
  perms.setAsker(askPermission);
  apps.setRenderer((name, html) => renderApp(name, html, { ruta: true }));
  apps.setOnRemoved(vaciarVisor);
  if ($('appframe').hidden) $('appframe').title = tr('appFrameEmpty');
  onSettingsChangedCb = onSettingsChanged || (() => {});
  // al instalar una skill: mensaje «cómo usarla» en el chat + volver al chat en móvil
  onSkillInstalledCb = entry => {
    // addMsg renderiza markdown en 'assistant'. En el móvil ya no se salta al
    // chat: el aviso de «instalada» trae «Ver cómo usarla en el chat».
    return addMsg('assistant', skills.usageMessage(entry));
  };

  // Historial del prompt: ↑/↓ recuperan lo enviado (como una shell). Persistente.
  const HKEY = 'elffuss.promptHistory';
  let hist = []; try { hist = JSON.parse(localStorage.getItem(HKEY) || '[]'); } catch { /* corrupto */ }
  let hIdx = -1, draft = '';
  $('prompt').addEventListener('keydown', e => {
    if (!$('cmd-menu').hidden) return;             // el menú «/» ya usa ↑/↓
    const inp = e.target;
    if (e.key === 'ArrowUp') {
      if (!hist.length) return;
      if (hIdx === -1) { draft = inp.value; hIdx = hist.length; }
      hIdx = Math.max(0, hIdx - 1); inp.value = hist[hIdx]; e.preventDefault();
      requestAnimationFrame(() => inp.setSelectionRange(inp.value.length, inp.value.length));
    } else if (e.key === 'ArrowDown') {
      if (hIdx === -1) return;
      hIdx++; inp.value = hIdx >= hist.length ? (hIdx = -1, draft) : hist[hIdx]; e.preventDefault();
    }
  });
  $('send').addEventListener('click', e => {
    if (!working) return;        // en reposo es el submit de siempre
    e.preventDefault();
    if (parando) return;         // ya se está parando: otro clic no hace nada
    onStop();
  });
  $('composer').addEventListener('submit', e => {
    e.preventDefault();
    // Mientras trabaja, aquí solo se llega con Enter (el ■ no envía): con texto
    // va a la cola como siempre, y sin texto no hace nada —un segundo Enter
    // dado por inercia no debe tirar el trabajo en curso—. Parar es el ■.
    const text = $('prompt').value.trim();
    if (!text || text === '/') return;     // un «/» suelto es abrir el menú, no un mensaje
    $('prompt').value = '';
    if (hist[hist.length - 1] !== text) hist.push(text);
    if (hist.length > 100) hist = hist.slice(-100);
    try { localStorage.setItem(HKEY, JSON.stringify(hist)); } catch { /* lleno */ }
    hIdx = -1; draft = '';
    onSend(text, { desdeCaja: true });     // solo lo escrito en la caja puede ir por Hard Work
  });
  // Chips: botones (antes <span> sin foco). «Autoriza una carpeta» abre el
  // selector de carpetas EN el clic: pasándoselo al modelo, el selector nativo
  // llegaba después de su turno y el navegador ya no lo dejaba abrir.
  $('chips').addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (!c) return;
    if (c.dataset.accion === 'carpeta') onPickFolder();
    else onSend(c.textContent.trim());
    // El chip pulsado desaparece con el primer mensaje: sin esto el foco del
    // teclado se perdía en <body>. En el móvil no, para no abrir el teclado.
    if (matchMedia('(pointer: fine)').matches) $('prompt')?.focus({ preventScroll: true });
  });
  document.querySelectorAll('#tabs button').forEach(b =>
    b.addEventListener('click', () => selectTab(b.dataset.tab, { push: true })));
  // Flechas, Inicio y Fin entre pestañas (patrón de tablist): solo la activa
  // está en el orden de tabulación, y moverse con flechas la activa.
  $('tabs').addEventListener('keydown', e => {
    const tabs = [...document.querySelectorAll('#tabs [role="tab"]')];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const j = e.key === 'ArrowRight' ? (i + 1) % tabs.length
      : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    tabs[j].focus();
    selectTab(tabs[j].dataset.tab);
  });
  $('btn-perms').addEventListener('click', () => { selectTab('permisos', { push: true }); if (isMobile()) flipTo('viz'); });
  $('model-select').addEventListener('change', e => onModelChange(e.target.value));
  // El selector tenía por nombre un icono: ahora se llama «Cerebro (modelo de IA)».
  $('model-select').setAttribute('aria-label', tr('modelSelectL'));
  modelStatus($('model-status').className.replace('dot', '').trim() || 'off');
  $('btn-flip').addEventListener('click', () =>
    flipTo(document.body.classList.contains('show-viz') ? 'chat' : 'viz'));
  pintarFlip();
  // En el teléfono el botón flota por encima de los chips y del compositor: su
  // alto real (cambia con el idioma y el teclado) va a --alto-pie.
  const altoPie = () => document.documentElement.style.setProperty('--alto-pie',
    (($('composer')?.offsetHeight || 0) + ($('chips')?.offsetHeight || 0)) + 'px');
  try { const ro = new ResizeObserver(altoPie); ro.observe($('composer')); ro.observe($('chips')); } catch { /* sin ResizeObserver: queda el valor por defecto */ }
  altoPie();
  // En el teléfono los avisos se apilan encima de la caja de progreso (ver
  // #toasts en elffuss.css): su alto, cuando se ve, va a --alto-progreso.
  const altoProgreso = () => {
    const caja = $('model-progress');
    document.documentElement.style.setProperty('--alto-progreso', (caja && !caja.hidden ? caja.offsetHeight + 8 : 0) + 'px');
  };
  try { new ResizeObserver(altoProgreso).observe($('model-progress')); } catch { /* sin ResizeObserver: 0 */ }
  altoProgreso();

  // el sello del build enlaza al commit cuando es un commit limpio
  { const b = $('build'); if (b) { const sello = b.textContent.trim(); b.dataset.sello = sello; b.replaceChildren(enlaceBuild(sello)); } }

  // iconos vectoriales (sin emojis)
  $('model-ico').innerHTML = UI.code;
  $('btn-clear').innerHTML = UI.newChat || UI.clear;
  setWorking(working);   // icono, título y aria del botón enviar/parar
  $('btn-slash').innerHTML = UI.slash;

  // menú de comandos (/) en el chat, estilo plugin de agente.
  // Un menú de verdad: role=menu, ↑/↓/Inicio/Fin, Enter, Escape, y el foco
  // vuelve a donde toca. Escribiendo «/» filtra por prefijo («/sk» → /skills) y
  // Enter ejecuta el marcado; un «/» suelto nunca se manda al modelo. Después
  // de ejecutar, la caja queda limpia y con el foco.
  const verPanel = tab => { selectTab(tab, { push: true }); if (isMobile()) flipTo('viz'); };
  // Cada comando tiene su nombre en español y en inglés. Se ENSEÑA el de la
  // página (español en español, inglés en los demás) y, escribiendo, valen los
  // dos: en inglés, /settings, /tasks o /clear no encontraban nada. Si ningún
  // nombre empieza así, se busca en lo que hace cada uno (su pista).
  const cmds = [
    { label: '/reloj', en: '/clock', hint: tr('cmClock'), run: () => onSend(tr('pClock')) },
    { label: '/carpeta', en: '/folder', hint: tr('cmFolder'), run: () => onPickFolder() },     // el selector nativo se abre en el gesto
    { label: '/skills', en: '/skills', hint: tr('cmSkills'), run: () => verPanel('skills') },
    { label: '/modelo', en: '/model', hint: tr('cmModel'), run: () => enfocarSelectorModelo(), foco: false },
    { label: '/ajustes', en: '/settings', hint: tr('cmSettings'), run: () => verPanel('ajustes') },
    { label: '/tareas', en: '/tasks', hint: tr('cmTasks'), run: () => verPanel('tareas') },
    { label: '/vault', en: '/vault', hint: tr('cmVault'), run: () => verPanel('vault') },
    { label: '/limpiar', en: '/clear', hint: tr('cmClear'), run: () => $('btn-clear').click() },
    { label: '/atajos', en: '/shortcuts', hint: tr('cmKeys'), run: () => mostrarAtajos(), foco: false },
  ];
  const nombreCmd = c => (uiLang() === 'es' ? c.label : c.en);
  const cmdMenu = $('cmd-menu');
  const slash = $('btn-slash');
  const caja = $('prompt');
  cmdMenu.setAttribute('aria-label', tr('cmdMenuL'));
  slash.setAttribute('aria-haspopup', 'menu');
  slash.setAttribute('aria-controls', 'cmd-menu');
  slash.setAttribute('aria-expanded', 'false');
  slash.title = tr('cmdMenuL');
  slash.setAttribute('aria-label', tr('cmdMenuL'));
  // Dos formas, dos patrones de ARIA. Escribiendo «/» el foco se queda en la caja:
  // la caja es un combobox (aria-controls, aria-expanded) y el menú una lista
  // (listbox) con su opción marcada (aria-selected), que la caja señala con
  // aria-activedescendant. Antes la caja señalaba elementos de un role=menu que
  // no era suyo, y los lectores de pantalla lo anunciaban mal o nada. Con el botón
  // «/» el foco entra en el menú: ese sí es un role=menu con menuitems.
  caja.setAttribute('role', 'combobox');
  caja.setAttribute('aria-autocomplete', 'list');
  caja.setAttribute('aria-controls', 'cmd-menu');
  caja.setAttribute('aria-expanded', 'false');
  const sinTilde = x => x.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  let visibles = [], activo = -1, comoLista = false;
  const filas = () => [...cmdMenu.querySelectorAll('.cmd-item')];
  const marcar = i => {
    const fs = filas();
    activo = fs.length ? (i + fs.length) % fs.length : -1;
    fs.forEach((f, j) => {
      f.classList.toggle('activo', j === activo);
      if (comoLista) f.setAttribute('aria-selected', j === activo ? 'true' : 'false');
    });
    if (activo >= 0 && comoLista) caja.setAttribute('aria-activedescendant', fs[activo].id);
    else caja.removeAttribute('aria-activedescendant');
    if (activo >= 0) fs[activo].scrollIntoView({ block: 'nearest' });
  };
  const pintarMenu = (filtro = '/') => {
    const f = sinTilde(filtro);
    const porNombre = cmds.filter(c => [c.label, c.en].some(n => sinTilde(n).startsWith(f)));
    const palabra = f.replace(/^\//, '');
    visibles = porNombre.length || palabra.length < 3 ? porNombre
      : cmds.filter(c => sinTilde(c.hint).split(/[^\p{L}\p{N}]+/u).some(w => w.startsWith(palabra)));
    cmdMenu.setAttribute('role', comoLista ? 'listbox' : 'menu');
    cmdMenu.replaceChildren();
    visibles.forEach((c, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'cmd-item';
      row.id = 'cmd-' + i;
      row.setAttribute('role', comoLista ? 'option' : 'menuitem');
      row.tabIndex = -1;
      const b = document.createElement('b'); b.textContent = nombreCmd(c);
      const h = document.createElement('span'); h.textContent = c.hint;
      row.append(b, h);
      row.onclick = () => ejecutar(c);
      cmdMenu.appendChild(row);
    });
    if (!visibles.length) cmdMenu.appendChild(el('div', 'cmd-vacio', tr('cmNone')));
    marcar(0);
  };
  // `lista`: abierto escribiendo (el foco sigue en la caja); si no, con el botón.
  const abrirMenu = (filtro = '/', { lista = true } = {}) => {
    comoLista = lista;
    pintarMenu(filtro);
    cmdMenu.hidden = false;
    slash.setAttribute('aria-expanded', lista ? 'false' : 'true');
    caja.setAttribute('aria-expanded', lista ? 'true' : 'false');
  };
  const cerrarMenu = ({ foco = null } = {}) => {
    if (cmdMenu.hidden) return;
    cmdMenu.hidden = true;
    slash.setAttribute('aria-expanded', 'false');
    caja.setAttribute('aria-expanded', 'false');
    caja.removeAttribute('aria-activedescendant');
    activo = -1;
    foco?.focus();
  };
  const ejecutar = c => {
    cerrarMenu();
    if (caja.value.trim().startsWith('/')) caja.value = '';
    c.run();
    if (c.foco !== false) caja.focus();
  };
  slash.addEventListener('click', () => {
    if (!cmdMenu.hidden) { cerrarMenu({ foco: slash }); return; }
    abrirMenu('/', { lista: false });
    filas()[0]?.focus();
  });
  // Dentro del menú (abierto con el botón): flechas, Inicio/Fin, Escape.
  cmdMenu.addEventListener('keydown', e => {
    const fs = filas();
    const i = fs.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? fs.length - 1 : i + (e.key === 'ArrowDown' ? 1 : -1);
      marcar(j); fs[activo]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      cerrarMenu({ foco: slash });
    } else if (e.key === 'Tab') {
      cerrarMenu();
    }
  });
  // Escribiendo «/…» en la caja: filtra, ↑/↓ marcan, Enter ejecuta, Escape cierra.
  caja.addEventListener('input', () => {
    const v = caja.value;
    if (/^\/\S*$/.test(v)) abrirMenu(v);
    else cerrarMenu();
  });
  caja.addEventListener('keydown', e => {
    if (cmdMenu.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); marcar(activo + (e.key === 'ArrowDown' ? 1 : -1)); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cerrarMenu(); }
    else if (e.key === 'Enter' && activo >= 0 && visibles[activo]) { e.preventDefault(); ejecutar(visibles[activo]); }
  });
  document.addEventListener('click', e => { if (!e.target.closest('#cmd-menu, #btn-slash, #prompt')) cerrarMenu(); });

  // Atajos globales fuera de un campo de texto: «/» va a la caja con el menú
  // abierto y «?» enseña la lista de atajos. No con una capa modal a la vista
  // (el splash de bienvenida, la Mente): antes, con el splash abierto y el foco
  // en «Entrar», «?» abría la lista de atajos encima y «/» escribía en la caja
  // inerte de detrás y dejaba su menú abierto, todo ello aún ahí al entrar.
  const capaModal = () => [...document.querySelectorAll('[aria-modal="true"]')]
    .some(el => !el.hidden && el.getClientRects().length > 0);
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t?.closest?.('input, textarea, select, [contenteditable], dialog, #mind-overlay, [aria-modal="true"]') || capaModal()) return;
    if (e.key === '/') { e.preventDefault(); if (isMobile()) flipTo('chat'); caja.focus(); caja.value = '/'; abrirMenu('/'); }
    else if (e.key === '?') { e.preventDefault(); mostrarAtajos(); }
  });
}

// La lista de atajos (antes no había ayuda de teclado en ninguna parte).
function mostrarAtajos() {
  let d = $('atajos');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'atajos';
    d.setAttribute('aria-labelledby', 'atajos-t');
    const h = el('h3', null, tr('keysTitle'));
    h.id = 'atajos-t';
    const dl = document.createElement('dl');
    dl.className = 'atajos';
    for (const [k, v] of [['Enter', 'keyEnter'], ['↑ / ↓', 'keyHist'], ['/', 'keySlash'], ['Esc', 'keyEsc'], ['?', 'keyHelp']]) {
      const dt = el('dt'); dt.appendChild(el('kbd', null, k));
      dl.append(dt, el('dd', null, tr(v)));
    }
    const cerrar = btn(tr('close'), 'primary', () => d.close());
    const fila = el('div', 'row right'); fila.appendChild(cerrar);
    d.append(h, dl, fila);
    document.body.appendChild(d);
  }
  if (!d.open) d.showModal();
}


// ---------- indicador de disco, SIEMPRE a la vista ----------
// El dato ya existía, pero dentro del panel de Ajustes: o sea escondido. Nadie
// sabía cuánto ocupaban los modelos en su navegador ni que se podían borrar.
// Aquí va en la cabecera, pequeño y permanente, y solo aparece si hay MODELOS
// guardados (model-storage.js): antes contaba el origen entero —tus apps y tu
// conversación incluidas— y con solo eso decía «💾 0 MB … pulsa para vaciarlo».
const _gbDisk = n => n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : Math.round(n / 1048576) + ' MB';
const UMBRAL_CHIP = 1048576;       // menos de 1 MB de pesos no es un modelo: no se enseña

function avisarLiberado(r) {
  toast(tr('diskFreed', { size: _gbDisk(r?.liberado || 0) }) + (r?.hayCompartido && !r.compartidoOk ? ' ' + tr('diskSharedFail') : ''));
}

// El chip mide SOLO este origen hasta que haya motivo para preguntar al almacén
// compartido: abrir el chip o Ajustes, o cargar un modelo local en esta sesión
// (kernel.js). Preguntar incrusta la página del broker (models.elffuss.com y cada
// host del registro del motor), y eso pasaba en cada carga y cada minuto, también
// en Básico sin nada descargado. Lo que vive solo en el compartido aparece en
// cuanto se da uno de esos motivos.
let preguntarCompartido = false, repintarChip = () => {};
export function contarCompartido() {
  if (preguntarCompartido) return;
  preguntarCompartido = true;
  repintarChip();
}
export function mountDiskChip() {
  const chip = document.getElementById('disk-chip');
  if (!chip) return;
  repintarChip = () => paint();
  async function paint() {
    if (chip.disabled) return;
    const { total } = await modelos.medir({ compartido: preguntarCompartido });
    if (total < UMBRAL_CHIP) { chip.hidden = true; return; }
    chip.hidden = false;
    chip.textContent = '💾 ' + _gbDisk(total);
    const txt = tr('diskChipT', { size: _gbDisk(total) });
    chip.title = txt;
    chip.setAttribute('aria-label', txt);
  }
  chip.addEventListener('click', async () => {
    preguntarCompartido = true;
    const { total, hayCompartido } = await modelos.medir();
    // El aviso solo menciona el almacén compartido si de verdad se va a vaciar.
    if (!confirm(tr(hayCompartido ? 'diskConfirm' : 'diskConfirmLocal', { size: _gbDisk(total) }))) return;
    chip.disabled = true;
    chip.setAttribute('aria-busy', 'true');
    chip.textContent = '💾 …';
    try { avisarLiberado(await modelos.vaciar()); }
    catch (e) { toast(tr('diskFail', { err: e?.message || e })); }
    chip.disabled = false;
    chip.removeAttribute('aria-busy');
    paint();
  });
  paint();
  // Cada minuto y solo con la pestaña a la vista: contar es fichero a fichero.
  setInterval(() => { if (document.visibilityState === 'visible') paint(); }, 60000);
}

// ---------- puerta de móvil ----------
// Antes, abrir esto en un móvil arrancaba SOLO la descarga del cerebro: medio
// giga de datos de alguien que no había pedido nada, y encima con muchas
// papeletas de no llegar a funcionar (el navegador de móvil cierra la pestaña
// bastante antes de sostener un modelo entero). Ahora se avisa y se espera.
//
// `onAccept()` devuelve si el cerebro cargó. Si no, la tarjeta se queda con el
// error y un «Reintentar» (antes desaparecía al pulsar y un fallo solo dejaba un
// aviso pasajero). Quién es un teléfono lo decide el kernel (esTelefono).
export function mobileGate(sizeText, onAccept) {
  const box = el('div', 'card col mobile-gate');
  box.style.cssText = 'margin:14px 0;padding:14px;gap:8px';
  box.setAttribute('role', 'region');
  box.setAttribute('aria-label', tr('mobTitle'));
  box.appendChild(el('b', null, tr('mobTitle')));
  box.appendChild(el('span', 'muted', tr('mobDesc', { size: sizeText })));
  box.appendChild(el('span', 'muted', tr('mobDesktop')));
  const estado = el('span', 'muted');
  estado.setAttribute('role', 'status');
  const boton = btn(tr('mobAnyway', { size: sizeText }), 'ghost', async () => {
    try { localStorage.setItem('elffuss.movil.ok', '1'); } catch { /* — */ }
    ocupado(boton, true);                // aria-disabled: el foco se queda en el botón
    estado.textContent = tr('mobLoading');
    let cargo = false;
    try { cargo = await onAccept(); } catch { cargo = false; }
    if (cargo) { box.remove(); return; }
    estado.textContent = tr('mobFailed');
    boton.textContent = tr('mobRetry');
    ocupado(boton, false);
  });
  box.append(estado, boton);
  (document.getElementById('log') || document.body).appendChild(box);
}
