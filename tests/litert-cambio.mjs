// Cambiar de cerebro con Gemma (LiteRT) cargado, sin GPU: la librería de LiteRT
// (@litert-lm/core, la copia fijada de web/vendor/third-party/) es un doble que cuenta los motores que se crean y
// los que se sueltan, y etiqueta cada conversación con su motor; el adaptador
// WebGPU y los ficheros del modelo también son de mentira. Nada sale de la
// máquina. Como en @litert-lm/core 0.15.0, el motor se suelta con delete() y no
// tiene close().
//   · Un cambio que falla (OpenAI sin clave) vuelve a Gemma SIN crear otro
//     motor: el mismo motor, ninguno soltado, y el turno siguiente sigue en la
//     misma conversación. Antes cada vuelta creaba un segundo Gemma encima del
//     primero, que ya no se podía soltar.
//   · E4B → E2B suelta el E4B ANTES de crear el E2B (los dos no caben).
//   · Si el nuevo no se puede crear, se vuelve al anterior: queda UN motor.
//   · «Liberar el modelo» (Ajustes) suelta el motor de verdad (delete()).
//
//   BASE=http://localhost:8743 node tests/litert-cambio.mjs
import { navegador, contexto, pagina, ok, hasta, escribir, reposo, avisos, fin, BASE } from './ux-comun.mjs';
import { sinIntegridad } from './lib/sin-integridad.mjs';

const MOTOR_FALSO = `
let n = 0;
export const hasGlobalLiteRtLm = () => true;
export const getGlobalLiteRtLmPromise = () => null;
export const loadLiteRtLm = async () => ({});
const L = () => (globalThis.__lit ||= { creados: [], intentos: 0, soltados: [], eventos: [], convs: [] });
export const Engine = {
  async create(opts) {
    L().intentos++;
    const tam = opts?.model?.size ?? -1;
    if (globalThis.__litFalla === tam) throw new Error('out of memory (prueba)');
    const id = ++n;
    L().creados.push(id); L().eventos.push('crea ' + id + ' (' + tam + ' B)');
    return {
      async createConversation() {
        const cid = 'm' + id + '.c' + (L().convs.length + 1);
        L().convs.push(cid);
        return {
          async *sendMessageStreaming() { yield { content: [{ type: 'text', text: 'respuesta de ' + cid }] }; },
          async getTokenCount() { return 50; },
          cancel() {},
          async delete() {},
        };
      },
      async delete() { L().soltados.push(id); L().eventos.push('suelta ' + id); },
    };
  },
};`;
// Cada build pesa distinto, para que el doble sepa cuál le llega.
const E4B = 4096, E2B = 2048;

const b = await navegador();
const { ctx } = await contexto(b, {
  model: 'litert:gemma-e4b', grants: [],
  extraInit: { 'elffuss.providers': JSON.stringify({ openai: { enabled: true, baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' } }) },
  rutas: async (url, route) => {
    const u = new URL(url);
    if (u.hostname === 'huggingface.co' && u.pathname.endsWith('.litertlm')) {
      await route.fulfill({ contentType: 'application/octet-stream', body: Buffer.alloc(/E4B/.test(u.pathname) ? E4B : E2B, 7) }); return true;
    }
    return false;
  },
});
// La librería es de este origen (web/vendor/third-party/): la ruta se pone después de la de contexto(), que deja
// pasar todo lo del servidor de pruebas; en Playwright gana la última ruta registrada.
await ctx.route('**/vendor/third-party/@litert-lm/core@*/dist/index.js', (route) => route.fulfill({ contentType: 'text/javascript', body: MOTOR_FALSO }));
// …y su hash fuera del import map: si no, el navegador rechaza el doble (es lo que hace la integridad).
await sinIntegridad(ctx, BASE, /@litert-lm\/core@/);
await ctx.addInitScript(() => {
  try { sessionStorage.setItem('elffuss.broker.down', '1'); } catch { /* — */ }   // sin almacén compartido en la prueba
  const adaptador = { limits: { maxBufferSize: 2 ** 32, maxStorageBufferBindingSize: 2 ** 31 }, features: new Set(), info: {},
    async requestDevice() { throw new Error('sin GPU en la prueba'); } };
  if (navigator.gpu) { try { navigator.gpu.requestAdapter = async () => adaptador; } catch { /* — */ } }
  else Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: async () => adaptador }, configurable: true });
});
const { p, errores } = await pagina(ctx);
const lit = () => p.evaluate(() => JSON.parse(JSON.stringify(globalThis.__lit || null)));
const vivos = l => l.creados.filter(id => !l.soltados.includes(id));
const listo = id => p.evaluate(id => document.getElementById('model-select').value === id
  && /gpu|on/.test(document.getElementById('model-status').className) && !document.getElementById('model-select').disabled, id);
const elegir = id => p.evaluate(id => { const s = document.getElementById('model-select'); s.value = id; s.dispatchEvent(new Event('change')); }, id);
const ultimaRespuesta = () => p.evaluate(() => [...document.querySelectorAll('#log .msg.assistant')].at(-1)?.textContent.trim() || '');
const turno = async texto => { await escribir(p, texto); await reposo(p); return ultimaRespuesta(); };

ok('arranca con Gemma E4B (un motor)', await hasta(() => listo('litert:gemma-e4b'), { veces: 300 })
  && (await lit())?.creados.length === 1, JSON.stringify(await lit()));
const r1 = await turno('hola');
ok('el primer turno lo contesta ese motor', /^respuesta de m1\.c\d+$/.test(r1), r1);
const conv1 = r1.replace('respuesta de ', '');

// ── un cambio que falla vuelve a Gemma sin crear otro motor ─────────────────
await elegir('ext:openai');
ok('OpenAI sin clave no carga y vuelve a Gemma', await hasta(async () => (await avisos(p)).some(t => /Sigo con Gemma-4 E4B/.test(t)) && await listo('litert:gemma-e4b')),
  (await avisos(p)).join(' | '));
{
  const l = await lit();
  ok('…con el MISMO motor: ninguno nuevo y ninguno soltado', l.creados.length === 1 && l.soltados.length === 0 && l.intentos === 1, JSON.stringify(l));
}
const r2 = await turno('y ahora otra cosa');
ok('…y el turno siguiente sigue en la misma conversación de ese motor', r2 === 'respuesta de ' + conv1, r2);

// ── E4B → E2B: el E4B se suelta antes de crear el E2B ───────────────────────
await elegir('litert:gemma-e2b');
ok('E2B carga', await hasta(() => listo('litert:gemma-e2b'), { veces: 300 }));
{
  const l = await lit();
  ok('…soltando el E4B ANTES de crear el E2B: queda un solo motor', l.soltados.join() === '1' && vivos(l).join() === '2'
    && l.eventos.indexOf('suelta 1') < l.eventos.findIndex(e => e.startsWith('crea 2')), JSON.stringify(l.eventos));
}
const r3 = await turno('¿sigues ahí?');
ok('…y el turno siguiente lo contesta el E2B', /^respuesta de m2\.c\d+$/.test(r3), r3);

// ── un build que no se puede crear: se vuelve al anterior, con un motor ─────
await p.evaluate(t => { globalThis.__litFalla = t; }, E4B);
await elegir('litert:gemma-e4b');
ok('si el E4B no se puede crear, vuelve al E2B', await hasta(async () => (await avisos(p)).some(t => /No se pudo cargar Gemma-4 E4B.*Sigo con Gemma-4 E2B/.test(t))
  && await listo('litert:gemma-e2b'), { veces: 300 }), (await avisos(p)).join(' | '));
{
  const l = await lit();
  ok('…y queda UN motor vivo (el E2B, recreado)', vivos(l).length === 1 && l.creados.length === 3, JSON.stringify(l.eventos));
}
const r4 = await turno('una más');
ok('…que es el que contesta', r4.startsWith('respuesta de m' + vivos(await lit())[0] + '.'), r4);

// ── «Liberar el modelo» suelta el motor de verdad ───────────────────────────
await p.click('#tabs button[data-tab="ajustes"]');
const liberar = p.locator('#panel-ajustes button', { hasText: 'Liberar el modelo' });
await liberar.click();
ok('«Liberar el modelo» suelta el motor (delete) y no queda ninguno', await hasta(async () => vivos(await lit()).length === 0),
  JSON.stringify((await lit()).eventos));

ok('sin errores de página', errores.length === 0, errores.slice(0, 3).join(' | '));
await fin(b, 'LITERT: un solo motor al volver, al cambiar de build y al liberarlo');
