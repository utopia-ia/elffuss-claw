// Memoria de Elffuss: hechos sobre el usuario guardados en SU navegador.
//
// Desde la memoria v2 es UNA memoria compartida por todas las apps de Elffuss
// (ver memory-wire.js): las herramientas memory.save / memory.list /
// memory.forget son las del motor (runMemoryTool), con sus reglas: solo se
// guarda lo que el usuario pidió y dijo con sus palabras, olvidar siempre pasa
// por una tarjeta que el usuario confirma, y lo demás queda como propuesta.
//
// Si la memoria v2 no carga (un módulo que no llega, IndexedDB que falla), las
// herramientas FALLAN CERRADAS: contestan «no disponible» y no escriben nada. No
// se vuelve a la memoria de antes (el almacén 'memory' de Claw): eso guardaba
// sin la puerta (sin disparador, sin evidencia, sin turno contaminado), borraba
// sin tarjeta, y la migración lo copiaba después como hecho activo compartido.
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
  return (await v2('memory.save', args, ctx)) ?? t('memOff');
}
export async function listFacts(args = {}, ctx = {}) {
  return (await v2('memory.list', args, ctx)) ?? t('memOff');
}
export async function forget(args = {}, ctx = {}) {
  return (await v2('memory.forget', args, ctx)) ?? t('memOff');
}

// Lo que entraba en el CONTEXTO AHORA con la memoria v1 (los 8 más recientes).
// Con la memoria v2 el bloque lo arma el almacén (memory-wire.js): aquí ya no
// entra nada, cargue o no la memoria.
export async function recent() { return []; }
