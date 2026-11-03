// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// La memoria compartida (v2) dentro de Claw.
// ─────────────────────────────────────────────────────────────────────────────
// Una sola memoria para todas las apps de Elffuss: la guarda la página almacén
// (web/memory/), con su propia base de datos, y la usan el chat de elffuss.com,
// Claw y Code. Claw vive en el MISMO origen que esa página, así que no necesita
// iframe: abre el mismo almacén del motor en este proceso («direct»), con las
// mismas reglas y límites que el camino por mensajes.
//
// Lo que hace este módulo, y nada más:
//   · cargar el motor de memoria (js/engine/memory*.js) y la configuración de
//     Elffuss (web/memory/memory.config.js);
//   · abrir el almacén, copiar la memoria vieja de Claw (la migración es del
//     motor: sin pérdidas, idempotente, mismos ids y mismo texto) y heredar el
//     permiso «Memoria» que el usuario ya hubiera dado a Claw;
//   · darle al bucle del agente lo que necesita en cada turno: el bloque de
//     memoria, la evidencia de lo que el usuario ESCRIBIÓ, la marca de turno
//     contaminado, y las tarjetas que la interfaz tiene que enseñar.
//
// Si el motor que se sirve no trae los módulos de memoria (un despliegue sin
// ellos), `cargar()` devuelve null y Claw sigue con la memoria de antes
// (tools/memory.js, modo v1): nada se rompe y nada se pierde, porque la
// migración copia esos hechos la próxima vez que el motor sí esté.
import { uiLang } from './i18n.js';

const APP = 'claw';
// Ámbitos que lee Claw: lo de todas las apps y lo que sea solo de Claw.
const SCOPES = ['all', `app:${APP}`];
// Claw habla con el modelo en español (agent.js systemPrompt): las reglas y la
// descripción de las herramientas van en español para que los bytes de la
// cabeza del prompt no cambien con el idioma de la página. El bloque y las
// tarjetas, en el idioma de la página.
const LANG_PROMPT = 'es';
// Claw es oscuro: las tarjetas y el panel usan la paleta «dark» de la config.
const SCHEME = 'dark';
const CONV_KEY = 'elffuss.memoria.conv';
const INCOGNITO_KEY = 'elffuss.memoria.sinMemoria';

let cargando = null;
let M = null;           // { cfg, store, mem, memory, cards, ui, core }
let pintor = null;      // (tarjeta, mem) => void, lo pone ui.js
let pintorUsados = null;

// ── Carga ────────────────────────────────────────────────────────────────────

export function cargar() {
  if (!cargando) cargando = abrir().catch((e) => { console.warn('[memoria] sin memoria v2:', e?.message || e); return null; });
  return cargando;
}
export const lista = () => M;

async function abrir() {
  const [{ default: cfg }, memory, storeMod, cards, ui, core, text] = await Promise.all([
    import('../memory/memory.config.js'),
    import('./engine/memory.js'),
    import('./engine/memory-store.js'),
    import('./engine/memory-cards.js'),
    import('./engine/memory-ui.js'),
    import('./engine/memory-core.js'),
    import('./engine/memory-text.js'),
  ]);
  const persist = async () => { try { return await navigator.storage?.persist?.(); } catch { return false; } };
  const store = await storeMod.openStore(cfg, { persist });
  // La memoria vieja de Claw entra antes del primer turno: si no, el primer
  // bloque saldría vacío para quien ya tenía hechos guardados.
  try { await store.migrate(); } catch { /* el motor reintenta en cada apertura */ }
  const mem = memory.createMemory(cfg, { app: APP, lang: uiLang(), direct: store });
  M = { cfg, store, mem, memory, cards, ui, core, text };
  await heredarPermiso(mem).catch(() => {});
  return M;
}

// El permiso «🧠 Memoria» que el usuario ya dio a Claw (permissions.js) se
// hereda como permiso de Claw sobre la memoria compartida, UNA vez: si ya hay
// una decisión en el almacén (sí o no), manda esa. Queda apuntado que ya se
// heredó: revocar a Claw en el gestor borra su permiso del almacén, y sin la
// marca la siguiente carga de Claw lo volvía a dar con el permiso viejo.
const HEREDADO_KEY = 'elffuss.memoria.permisoHeredado';
async function heredarPermiso(mem) {
  try { if (localStorage.getItem(HEREDADO_KEY) === '1') return; } catch { return; }
  let antes = [];
  try { antes = JSON.parse(localStorage.getItem('elffuss.grants') || '[]'); } catch { /* sin almacenamiento */ }
  if (!Array.isArray(antes) || !antes.includes('memory')) return;
  const r = await mem.ready();
  if (r.mode === 'off') return;
  if (!r.grant) await mem.setGrant('granted');
  try { localStorage.setItem(HEREDADO_KEY, '1'); } catch { /* — */ }
}

// ── Lo que pinta la interfaz ─────────────────────────────────────────────────

export function alPintarTarjeta(fn) { pintor = fn; }
export function alPintarUsados(fn) { pintorUsados = fn; }
const pintar = (tarjeta, extra) => { if (tarjeta && pintor && M) { try { pintor(tarjeta, M, extra); } catch (e) { console.warn('[memoria] tarjeta:', e?.message); } } };

// Monta el panel de memoria en `el`. Claw comparte origen con el almacén, así
// que es el mismo panel de la página almacén, montado aquí mismo (sin iframe).
export async function montarPanel(el) {
  const m = await cargar();
  if (!m) return null;
  // Lo que una pestaña vieja de Claw (o el puente de antes) haya escrito en el
  // almacén viejo desde que se abrió esta, entra ahora (idempotente, con la
  // misma revisión que la migración).
  try { await m.store.migrate(); } catch { /* el motor reintenta en cada apertura */ }
  return m.ui.mountPanel(el, m.store, { cfg: m.cfg, lang: uiLang(), scheme: SCHEME });
}

export const urlGestor = () => new URL('memory/', location.href).href;

// ── Conversación y «Sin memoria» ─────────────────────────────────────────────
// Un id de conversación opaco y aleatorio, para «qué aprendí en esta
// conversación». Lo cambia 🧹 (nuevaConversacion), igual que el modo «Sin
// memoria», que es de la conversación.
export function conversacion() {
  let c = null;
  try { c = sessionStorage.getItem(CONV_KEY) || localStorage.getItem(CONV_KEY); } catch { /* — */ }
  if (!c || !/^[A-Za-z0-9_-]{1,40}$/.test(c)) {
    c = M ? M.core.newConv() : 'c' + Math.random().toString(36).slice(2, 14);
    try { localStorage.setItem(CONV_KEY, c); } catch { /* — */ }
  }
  return c;
}
export function nuevaConversacion() {
  try { localStorage.removeItem(CONV_KEY); localStorage.removeItem(INCOGNITO_KEY); } catch { /* — */ }
}
export function sinMemoria() { try { return localStorage.getItem(INCOGNITO_KEY) === '1'; } catch { return false; } }
export function ponerSinMemoria(v) { try { if (v) localStorage.setItem(INCOGNITO_KEY, '1'); else localStorage.removeItem(INCOGNITO_KEY); } catch { /* — */ } }

// ── Herramientas y reglas ────────────────────────────────────────────────────

// Las herramientas de memoria tal como las define el motor, en la forma del
// catálogo de Claw ({ desc, params }). null si no hay memoria v2.
export function herramientas() {
  if (!M) return null;
  return M.memory.memoryTools(M.cfg, LANG_PROMPT, { app: APP });
}
export function reglas() {
  if (!M) return '';
  return M.memory.memoryPromptRules(M.cfg, LANG_PROMPT);
}

// ── El turno ─────────────────────────────────────────────────────────────────
// Se llama UNA vez al empezar cada turno, con el mensaje del usuario ya en el
// historial. Devuelve null sin memoria v2 (y el turno sigue como antes).
//
//   bloque      { text, tokens }: el bloque <memoria> de este turno. Se reutiliza
//               tal cual en cada paso del bucle; solo se rehace tras guardar.
//   turn        lo que runMemoryTool necesita: evidencia, contaminado, conv…
//   herramienta(nombre)  apunta que una herramienta ha corrido: cualquiera que
//               no sea de memoria contamina el turno (falla cerrado).
//   resultado(nombre, r) tras una herramienta de memoria: pinta su tarjeta y
//               rehace el bloque si guardó.
//   fin(texto)  tras la respuesta final: propuesta determinista, y la lista de
//               recuerdos que tuvo presentes.
export async function empezarTurno({ history, model = null }) {
  const m = await cargar();
  if (!m) return null;
  const incognito = sinMemoria();
  const conv = conversacion();
  const ultimo = [...history].reverse().find((x) => x.role === 'user');
  const typed = ultimo?.typed === true;
  const query = typed ? ultimo.content : '';
  const anteriores = history.filter((x) => x.role === 'user' && x.typed === true);
  const prevQuery = typed && anteriores.length > 1 ? anteriores[anteriores.length - 2].content : '';
  const turn = { evidence: m.memory.typedEvidence(history), tainted: false, conv, incognito, scopes: SCOPES, forgetCards: 0 };
  const pedir = async () => {
    // Sin texto escrito por el usuario (tareas programadas, propuestas del
    // cerebro, chips) no hay consulta: solo entra lo esencial («Sobre ti»).
    const r = await m.mem.context({ query, prevQuery, model: model || {}, scopes: SCOPES, conv, incognito });
    return { text: r.text || '', tokens: r.tokens || 0, facts: r.facts || [], unavailable: !!r.unavailable };
  };
  let bloque = await pedir().catch(() => ({ text: '', tokens: 0, facts: [] }));
  const api = {
    turn,
    get bloque() { return bloque; },
    herramienta(nombre) {
      if (m.memory.taints(m.cfg, nombre)) turn.tainted = true;
    },
    // `vacio`: el texto de la app para «no recuerdo nada aún» (Claw lo tiene en
    // sus seis idiomas; el motor, en español e inglés).
    async correr(nombre, args, { vacio = null } = {}) {
      const r = await m.memory.runMemoryTool(m.mem, nombre, args, turn);
      if (vacio && r.text === m.text.t(m.cfg.strings, m.mem.lang, 'res.empty')) return vacio;
      if (r.card) pintar(r.card, { turno: api, nombre, args });
      const t = r.card?.type;
      if (t === 'saved' || t === 'updated' || t === 'similar' || t === 'negated') bloque = await pedir().catch(() => bloque);
      return r.text;
    },
    async fin() {
      // Solo en los turnos del usuario: no en tareas programadas ni en el cerebro.
      if (!typed || incognito) return;
      if (pintorUsados && bloque.facts?.length) { try { pintorUsados(bloque, M); } catch { /* — */ } }
      const p = await m.memory.maybePropose(m.mem, query, { lang: uiLang(), conv, model, state: estadoPropuestas(conv), incognito }).catch(() => null);
      if (p) pintar(p, { turno: api });
    },
  };
  return api;
}

// Cuántas propuestas lleva cada conversación (el motor limita por turno y por
// conversación según la puesta a punto del modelo).
const propuestas = new Map();
function estadoPropuestas(conv) {
  if (!propuestas.has(conv)) propuestas.set(conv, {});
  return propuestas.get(conv);
}

// Modelo para el bloque: el id y el contexto salen del REGISTRO del motor
// (MODELS[id].ctx), nunca de una lista de aquí. Para cerebros que no están en
// el registro (LiteRT, ONNX, WebLLM, API) no hay ctx: el motor usa su
// presupuesto por defecto.
export async function modeloDelCerebro(idActivo) {
  const id = String(idActivo || '');
  if (!id.startsWith('engine:')) return { id: null, ctx: null };
  const clave = id.slice(7);
  try {
    const reg = await import('./engine/registro.js');
    const e = reg.MODELS?.[clave];
    return e ? { id: clave, ctx: Number.isFinite(e.ctx) ? e.ctx : null } : { id: null, ctx: null };
  } catch { return { id: null, ctx: null }; }
}
