// El plan del agente con el modelo REAL (Gemma 4 E4B por LiteRT, voraz): la sesión
// del 25-oct-2026 en la que Claw «usa poco el historial y no conecta el contexto».
// ─────────────────────────────────────────────────────────────────────────────
// Se siembra el historial de esa conversación (plan de comidas para 4 y la skill
// «impeccable») y se mide qué hace el agente de verdad en cada petición:
//   1. «busca una skill… creo que se llama impecable» → busca; no crea una
//      imitación (skill.create) ni rehace la app de antes.
//   2. «búscala en internet primero» → su PRIMER paso es web.search.
//   3. con los resultados delante, «esa, instálala» → skill.install con la URL.
//   4. «haz la lista de la compra de la semana» → no vuelve a preguntar para
//      cuántos es (ya lo dijo).
// Las herramientas son las de verdad (web.search por el proxy, skill.install
// contra GitHub) en un perfil de pruebas.
//
// Prueba de GPU, fuera de la suite. Igual que tests/litert-stop-real.mjs:
//   ln -s ~/modelos/gemma-4-E4B-it-web.litertlm web/models/__e4b.litertlm
//   python3 server/serve.py 8753 &
//   BASE=http://localhost:8753 node tests/plan-real.mjs
import { chromium } from 'playwright';
import { CHROME_ARGS } from './chrome-args.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BASE || 'http://localhost:8753';
const E4B_URL = process.env.E4B_URL || (BASE + '/models/__e4b.litertlm');
const PROFILE = process.env.PROFILE || join(tmpdir(), 'elffuss-claw-plan-prof');
mkdirSync(PROFILE, { recursive: true });

let fails = 0;
const ok = (n, c, e = '') => { console.log((c ? '✅' : '❌') + ' ' + n + (e ? '  — ' + e : '')); if (!c) fails++; };
const log = (...a) => console.log('· ' + a.join(' '));

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: process.env.CHANNEL || 'chrome',
  args: ['--enable-unsafe-webgpu', ...CHROME_ARGS],
  timeout: 120000,
});
await ctx.addInitScript(() => { try { localStorage.setItem('elffuss.model', 'rules'); localStorage.setItem('elffuss.welcomed', '1');
  // Los permisos, concedidos de antemano: sin esto web.search espera un clic en el diálogo y el turno se cuelga.
  localStorage.setItem('elffuss.grants', JSON.stringify(['fs', 'apps', 'vault', 'tasks', 'web', 'memory'])); } catch {} });
const p = await ctx.newPage();
p.on('pageerror', e => log('PAGEERROR:', e.message.slice(0, 160)));
await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1500);

log('cargando E4B en la GPU…');
const load = await p.evaluate(async (url) => {
  const m = await import('/js/providers/litert.js');
  m.MODELS['gemma-e4b'].url = url;
  m.configure('gemma-e4b');
  let err = null;
  try { await m.load(() => {}); } catch (e) { err = e.message; }
  return { err, ctx: m.ctxTokens };
}, E4B_URL);
ok('E4B carga sin error', !load.err, load.err || `contexto ${load.ctx}`);
if (load.err) { await ctx.close(); process.exit(1); }

const APP = '```tool\n{"tool":"app.create","args":{"name":"plan_comidas_mercadona","html":"<!doctype html><html lang=\\"es\\"><head><title>Plan de comidas</title></head><body><h1>Plan semanal para 4</h1></body></html>"}}\n```';
const BUSQUEDA = `[resultado web.search]
Resultados para «skill impecable interface design»:

• GitHub - pbakaus/impeccable: The design language that makes your AI ...
  https://github.com/pbakaus/impeccable
• impeccable Skill - pbakaus | UI Skills
  https://www.ui-skills.com/skills/pbakaus/impeccable
• Impeccable: The missing design vocabulary for agents
  https://impeccable.style/
• impeccable/.claude/skills/impeccable/SKILL.md at main · pbakaus ...
  https://github.com/pbakaus/impeccable/blob/main/.claude/skills/impeccable/SKILL.md`;
const BASE_H = [
  { role: 'user', content: 'quiero que me de recomendaciones y me ponga un calendario con lo que debo de comer cada dia, y la lista de cosas que comprar en mercadona' },
  { role: 'assistant', content: 'Para personalizarlo: ¿alguna restricción? ¿Para cuántas personas cocinas?' },
  { role: 'user', content: 'normal diet and for 4: mi chica, yo y nuestros dos hijos' },
  { role: 'assistant', content: APP },
  { role: 'user', content: '[resultado app.create]\n✓ App «plan_comidas_mercadona» creada y abierta en el visualizador.' },
];

const casos = await p.evaluate(async ({ BASE_H, BUSQUEDA }) => {
  const { Agent } = await import('/js/agent.js');
  const prov = await import('/js/providers/litert.js');
  const { initSkills, remove } = await import('/js/skills.js');
  await initSkills();
  await remove('impeccable').catch(() => {});
  const turno = async (historial, texto) => {
    const a = new Agent(prov);
    a.history = historial.map(m => ({ ...m }));
    const herramientas = [], resultados = [];
    let textoFinal = '';
    const tope = setTimeout(() => a.stop(), 240000);   // un turno colgado no tumba la prueba entera
    await a.handle(texto, ev => {
      if (ev.type === 'tool') herramientas.push({ tool: ev.call.tool, args: JSON.stringify(ev.call.args).slice(0, 160) });
      if (ev.type === 'tool_result') resultados.push(ev.result.slice(0, 160));
      if (ev.type === 'text') textoFinal = ev.text;
    });
    clearTimeout(tope);
    return { herramientas, resultados, texto: textoFinal.slice(0, 300) };
  };
  const r = {};
  r.busca = await turno(BASE_H, 'mejora la interfaz, busca una skill que ayude a hacer interfaces, hay una que creo que se llama impecable');
  r.primero = await turno([...BASE_H,
    { role: 'user', content: 'mejora la interfaz, busca una skill que ayude a hacer interfaces, hay una que creo que se llama impecable' },
    { role: 'assistant', content: '```tool\n{"tool":"skill.list","args":{}}\n```' },
    { role: 'user', content: '[resultado skill.list]\nNo hay skills.' }], 'búscala en internet primero');
  r.instala = await turno([...BASE_H,
    { role: 'user', content: 'busca la skill de impecable en internet' },
    { role: 'assistant', content: '```tool\n{"tool":"web.search","args":{"query":"skill impecable interface design"}}\n```' },
    { role: 'user', content: BUSQUEDA },
    { role: 'assistant', content: 'He encontrado varias referencias a «Impeccable», un lenguaje de diseño para agentes.' }], 'is this one, nice, install it');
  r.lista = await turno(BASE_H, 'hazme la lista de la compra de toda la semana');
  return r;
}, { BASE_H, BUSQUEDA });
for (const [k, v] of Object.entries(casos)) log(k, JSON.stringify(v));

const tools = c => c.herramientas.map(h => h.tool);
ok('1 · «busca una skill… impecable»: busca (web.search)', tools(casos.busca).includes('web.search'), tools(casos.busca).join(' → ') || casos.busca.texto);
ok('  …sin imitarla con skill.create', !tools(casos.busca).includes('skill.create'), tools(casos.busca).join(' → '));
ok('  …sin rehacer la app de antes', !tools(casos.busca).includes('app.create'), tools(casos.busca).join(' → '));
ok('2 · «búscala en internet primero»: el primer paso es web.search', tools(casos.primero)[0] === 'web.search', tools(casos.primero).join(' → ') || casos.primero.texto);
ok('3 · «esa, instálala»: skill.install', tools(casos.instala).includes('skill.install'), tools(casos.instala).join(' → ') || casos.instala.texto);
ok('  …y queda instalada', casos.instala.resultados.some(x => /instalad|installed/i.test(x)), casos.instala.resultados.join(' | '));
ok('4 · la lista de la compra no vuelve a preguntar para cuántos', !/cu[aá]ntas personas|how many people|para cu[aá]ntos/i.test(casos.lista.texto), tools(casos.lista).join(' → ') + ' · ' + casos.lista.texto.slice(0, 120));

console.log(fails ? `\n❌ ${fails} FALLO(S)` : '\n✅ PLAN REAL: busca, sigue el orden, instala y usa lo ya dicho');
await ctx.close();
process.exit(fails ? 1 : 0);
