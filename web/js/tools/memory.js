// Memoria de Elffuss: hechos sobre el usuario guardados en SU navegador.
//
// Desde la memoria v2 es UNA memoria compartida por todas las apps de Elffuss
// (ver memory-wire.js): las herramientas memory.save / memory.list /
// memory.forget son las del motor (runMemoryTool), con sus reglas: solo se
// guarda lo que el usuario pidió y dijo con sus palabras, olvidar siempre pasa
// por una tarjeta que el usuario confirma, y lo demás queda como propuesta.
//
// Lo de abajo del todo (modo v1) es la memoria de antes, en el almacén 'memory'
// de Claw. Solo se usa si el motor servido no trae los módulos de memoria; en
// cuanto los trae, la migración copia esos hechos a la memoria compartida.
import * as db from '../db.js';
import { require as requirePerm } from '../permissions.js';
import { t } from '../i18n.js';
import * as memoria from '../memory-wire.js';

// `ctx.memoria` lo pone el agente: el turno de memoria (memory-wire.js
// empezarTurno). Sin él (una llamada fuera de un turno), se abre uno de paso
// sin evidencia: no puede guardar nada activo, como debe ser.
async function v2(nombre, args, ctx = {}) {
  const m = await memoria.cargar();
  if (!m) return null;
  const turno = ctx.memoria || await memoria.empezarTurno({ history: [] });
  return turno ? turno.correr(nombre, args, { vacio: t('memNone') }) : null;
}

export async function save(args = {}, ctx = {}) {
  const r = await v2('memory.save', args, ctx);
  return r ?? saveV1(args);
}
export async function listFacts(args = {}, ctx = {}) {
  const r = await v2('memory.list', args, ctx);
  return r ?? listFactsV1();
}
export async function forget(args = {}, ctx = {}) {
  const r = await v2('memory.forget', args, ctx);
  return r ?? forgetV1(args);
}

// ── Modo v1 (sin módulos de memoria en el motor servido) ────────────────────

async function saveV1({ fact } = {}) {
  if (!fact) throw new Error(t('toolMissing', { arg: 'fact' }));
  await requirePerm('memory', fact);
  const id = 'm' + Math.random().toString(36).slice(2, 8);
  await db.set('memory', id, { id, fact: String(fact).slice(0, 300), at: Date.now() });
  return t('memSaved', { fact, id });
}

async function listFactsV1() {
  const all = (await db.all('memory')).sort((a, b) => a.at - b.at);
  return all.length
    ? all.map(f => `• [${f.id}] ${f.fact}`).join('\n')
    : t('memNone');
}

async function forgetV1({ id } = {}) {
  await db.del('memory', id);
  return t('memForgot', { id });
}

// Lo que entraba en el CONTEXTO AHORA con la memoria v1: los 8 más recientes.
// Con la memoria v2 el bloque lo arma el almacén (memory-wire.js) y esto solo
// lo usa el modo v1.
export async function recent(n = 8) {
  if (memoria.lista()) return [];
  return (await db.all('memory')).sort((a, b) => b.at - a.at).slice(0, n).reverse();
}
