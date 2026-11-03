// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Ganchos de la app de prueba (ver index.html). `cliente()` usa el cliente del
// motor como lo usará el chat; `crudo()` habla con la página almacén a mano, sin
// el cliente, para comprobar a quién contesta y a quién no; `puente()` habla con
// el puente v1 de Claw (bridge.html) como el chat que aún no tiene la memoria v2.
const STORE = 'https://claw.elffuss.com/memory/';
const NS = 'elffuss-memory';
const app = location.hostname === 'code.elffuss.com' ? 'code' : 'chat';

function marco(src) {
  const f = document.createElement('iframe');
  f.src = src;
  f.style.cssText = 'width:0;height:0;border:0';
  document.body.append(f);
  return f;
}

// Manda un sobre a la página almacén desde ESTA ventana y espera respuesta.
async function crudo(op, args = {}, { espera = 2500, sobre = null } = {}) {
  const f = marco(STORE);
  await new Promise((r) => { f.onload = r; setTimeout(r, 3000); });
  const rid = 'r' + Math.random().toString(36).slice(2, 12);
  return new Promise((resolve) => {
    const on = (e) => { if (e.source === f.contentWindow && e.data?.rid === rid) { removeEventListener('message', on); resolve(e.data); } };
    addEventListener('message', on);
    // Varios intentos: la página puede tardar en instalar su router.
    const msg = sobre || { ns: NS, v: 2, rid, op, args };
    let n = 0;
    const tick = () => { try { f.contentWindow.postMessage(msg, 'https://claw.elffuss.com'); } catch { /* — */ } if (++n < 8) setTimeout(tick, 250); };
    tick();
    setTimeout(() => { removeEventListener('message', on); resolve('SIN RESPUESTA'); }, espera);
  });
}

async function puente(op, args) {
  const f = window.__puente || (window.__puente = marco('https://claw.elffuss.com/bridge.html'));
  await new Promise((r) => { if (f.__listo) r(); else { f.addEventListener('load', () => { f.__listo = true; r(); }); setTimeout(r, 3000); } });
  const id = 'b' + Math.random().toString(36).slice(2, 10);
  return new Promise((resolve) => {
    const on = (e) => { if (e.source === f.contentWindow && e.data?.id === id) { removeEventListener('message', on); resolve(e.data); } };
    addEventListener('message', on);
    f.contentWindow.postMessage({ kind: 'elffuss-bridge', v: 1, id, op, ...(args ? { args } : {}) }, 'https://claw.elffuss.com');
    setTimeout(() => { removeEventListener('message', on); resolve('SIN RESPUESTA'); }, 4000);
  });
}

let mem = null;
async function cliente() {
  if (mem) return mem;
  const [{ default: cfg }, memory] = await Promise.all([import('/memory/memory.config.js'), import('/js/engine/memory.js')]);
  mem = memory.createMemory(cfg, { app, lang: 'es' });
  window.__memory = memory;
  return mem;
}

async function panel() {
  const m = await cliente();
  const { mountPanelFrame } = await import('/js/engine/memory-cards.js');
  return mountPanelFrame(document.getElementById('panel'), m, { lang: 'es', height: '20rem' }).src;
}

window.__t = { app, crudo, puente, cliente, panel, marco };
