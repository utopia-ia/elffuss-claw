// En inglés (en-US), lo que se rehízo en la auditoría de UX habla inglés:
//   · los avisos del selector de modelo (Básico, un cerebro que no carga);
//   · la respuesta del modo básico, con su enlace al selector de modelo;
//   · «What's stored» en Ajustes;
//   · el error de la bóveda al guardar sin nombre;
//   · el velocímetro (chip, panel y su nombre accesible), con un motor de prueba;
//   · lo que devuelven las herramientas (y se ve en el chat), lo que cuenta el
//     cerebro (ceo.js) y los textos de skills.js;
//   · el tablero del copiloto (lo que enseña; la skill y su contrato con el
//     modelo no cambian);
//   · las fuentes de serie de Skills, la ayuda de los modelos externos en
//     Ajustes, y los perfiles y la misión de serie de la Mente.
// Antes todo eso salía en español con la página en inglés.
//
//   BASE=http://localhost:8743 node tests/ux-ingles.mjs
import { navegador, contexto, pagina, ok, hasta, escribir, reposo, avisos, fin } from './ux-comun.mjs';

const b = await navegador();
const ESPANOL = /\b(sin modelo|No se pudo|Estoy en modo|selector de modelo|Generadas|Conversación|Bóveda|Faltan|Velocidad|leyendo|escribiendo|Pulsa)\b/;

const { ctx } = await contexto(b, {
  locale: 'en-US', grants: [],
  extraInit: { 'elffuss.providers': JSON.stringify({ openai: { enabled: true, baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' } }) },
});
const { p, errores } = await pagina(ctx);
const elegir = id => p.evaluate(id => { const s = document.getElementById('model-select'); s.value = id; s.dispatchEvent(new Event('change')); }, id);

// ── selector de modelo ──────────────────────────────────────────────────────
await elegir('rules');
ok('choosing Basic says so in English', await hasta(async () => (await avisos(p)).some(t => t === 'Basic mode: no model, direct commands.')),
  (await avisos(p)).join(' | '));
await hasta(() => p.evaluate(() => !document.getElementById('model-select').disabled));
await elegir('ext:openai');           // sin clave: no carga, y no había otro cerebro
ok('a brain that does not load says why in English', await hasta(async () =>
  (await avisos(p)).some(t => /^⚠️ Could not load OpenAI: the API key is missing \(advanced settings\)$/.test(t))), (await avisos(p)).join(' | '));

// ── modo básico ─────────────────────────────────────────────────────────────
await hasta(() => p.evaluate(() => document.getElementById('model-select').value === 'rules' && !document.getElementById('model-select').disabled));
await escribir(p, 'hola');
await reposo(p);
const respuesta = await p.locator('#log .msg.assistant').last();
const texto = await respuesta.innerText();
ok('the Basic-mode reply is in English and says the commands are in Spanish', /I am in Basic mode/.test(texto) && /written in Spanish/.test(texto) && !/Estoy en modo/.test(texto), texto.slice(0, 160));
ok('…and links to the model picker', await respuesta.locator('a[href="#/modelo"]').innerText().catch(() => '') === 'model picker');

// ── Settings › What's stored ────────────────────────────────────────────────
await p.click('#tabs button[data-tab="ajustes"]');
const tarjeta = p.locator('#panel-ajustes .card', { hasText: 'Wipe browser data' });
ok('“What’s stored” names the stores in English', await hasta(async () => {
  const t = await tarjeta.innerText().catch(() => '');
  return /Generated apps/.test(t) && /Conversation/.test(t) && /Vault \(encrypted\)/.test(t) && !/Apps generadas|Bóveda/.test(t);
}), await tarjeta.innerText().catch(() => ''));

// ── Skills: las fuentes de serie ────────────────────────────────────────────
await p.click('#tabs button[data-tab="skills"]');
const etiquetasFuentes = () => p.$$eval('#panel-skills .skills-fuentes .card > .row > b', bs => bs.map(b => b.textContent));
await hasta(async () => (await etiquetasFuentes()).length === 6);
const fuentes = await etiquetasFuentes();
ok('the six built-in Skills sources are labelled in English', fuentes.length === 6 && fuentes.includes('Community · Mega collection (1000+ skills)')
  && fuentes.includes('3D in the browser · Three.js (works in Claw)') && !fuentes.some(f => /Comunidad|navegador|funciona|oficial|solo referencia/.test(f)),
  JSON.stringify(fuentes));

// ── Settings › External models: la ayuda de cada proveedor ─────────────────
await p.click('#tabs button[data-tab="ajustes"]');
await p.locator('#panel-ajustes .ext-block > summary').click();
const ext = await p.locator('#panel-ajustes .ext-block').innerText();
ok('Settings › External models: the provider help texts are in English', /Your sk-… key\. It stays in your browser/.test(ext)
  && /Ollama on your machine/.test(ext) && /The header for direct browser access/.test(ext)
  && !/Tu clave|Se queda|Arráncalo|Se envía/.test(ext), ext.slice(0, 400));

// ── la Mente: perfiles y misión de serie ────────────────────────────────────
const mente = await p.evaluate(async () => {
  const ceo = await import('/js/ceo.js');
  return { perfiles: ceo.getProfiles().map(x => [x.name, x.focus]), mision: ceo.getMission() };
});
ok('the Mind’s default departments, their focus and the mission are in English', mente.perfiles.map(x => x[0]).join() === 'Organization,Productivity,Memory'
  && /authorized files and folders/.test(mente.perfiles[0][1]) && /^Review your space/.test(mente.mision)
  && !JSON.stringify(mente).match(/Organización|Productividad|carpetas|Revisar/), JSON.stringify(mente).slice(0, 300));

// ── Vault: guardar sin nombre ───────────────────────────────────────────────
await p.click('#tabs button[data-tab="vault"]');
await p.fill('#vault-master', 'test-password-1');
await p.press('#vault-master', 'Enter');
await hasta(() => p.evaluate(() => !!document.getElementById('vault-name')));
await p.fill('#panel-vault input[type=password]', 'secret-without-name');
await p.press('#panel-vault input[type=password]', 'Enter');
ok('saving a secret without a name says so in English', await hasta(async () => (await avisos(p)).some(t => /The name or the secret is missing/.test(t))),
  (await avisos(p)).join(' | '));

// ── velocímetro ─────────────────────────────────────────────────────────────
await p.evaluate(async () => {
  const vm = await import('/js/velocimetro.js');
  vm.usarTraductor((await import('/js/i18n.js')).t);   // lo que hace el kernel al montarlo
  vm.montar({
    alMedir: () => () => {},
    ultimaMedida: () => ({ prefillTokS: 300, genTokS: 20, ttftMs: 900, genTokens: 50, procesados: 400, reusados: 3, enCurso: false }),
  });
});
const chip = p.locator('#speed-chip');
ok('speed chip title in English', /^Writing at 20\.0 tok\/s · the prompt was read at 300 tok\/s · first letter after 900 ms\. Click to see the chart\.$/.test(await chip.getAttribute('title') || ''),
  await chip.getAttribute('title'));
await chip.click();
const panel = await p.evaluate(() => ({ text: document.getElementById('speed-panel').innerText, label: document.getElementById('speed-panel').getAttribute('aria-label') }));
ok('speed panel and its accessible name in English', panel.label === 'Speed of this machine' && /tok\/s reading the prompt/.test(panel.text)
  && /3 reused/.test(panel.text) && !ESPANOL.test(panel.text), JSON.stringify(panel).slice(0, 300));

// ── herramientas, cerebro y skills ──────────────────────────────────────────
const herramientas = await p.evaluate(async () => {
  const { runTool } = await import('/js/tools/index.js');
  const r = async (n, a) => { try { return await runTool(n, a); } catch (e) { return 'ERROR ' + e.message; } };
  return {
    memoria: await r('memory.list', {}), tareas: await r('tasks.list', {}),
    automatizaciones: await r('fs.watch_list', {}), boveda: await r('vault.list', {}), app: await r('app.open', { name: 'nada' }),
    desconocida: await r('no.existe', {}), skill: await r('skill.get', { name: 'nada' }),
  };
});
ok('tool results and errors are in English', /I do not remember anything yet/.test(herramientas.memoria) && herramientas.tareas === 'No scheduled tasks.'
  && /^No automations\./.test(herramientas.automatizaciones)
  && /There is no app “nada”/.test(herramientas.app) && /Unknown tool: no\.existe/.test(herramientas.desconocida)
  && /There is no skill “nada”/.test(herramientas.skill) && !Object.values(herramientas).some(v => ESPANOL.test(v) || /No hay|No existe|Falta/.test(v)),
  JSON.stringify(herramientas).slice(0, 400));
const skillTxt = await p.evaluate(async () => (await import('/js/skills.js')).usageMessage({ name: 'demo', description: '' }));
ok('the “how to use it” message of a skill is in English', /Skill “demo” installed/.test(skillTxt) && /To use it, ask me/.test(skillTxt), skillTxt);
const cerebro = await p.evaluate(async () => {
  const ceo = await import('/js/ceo.js');
  const vistos = [];
  const { onEvent } = { onEvent: (ch, ev) => vistos.push(ev.text) };
  ceo.init({ onEvent });
  ceo.enable(); ceo.disable();
  return vistos;
});
ok('what the brain says (on watch, paused) is in English', cerebro.includes('CEO on watch — I will work while you are idle') && cerebro.includes('CEO paused'),
  JSON.stringify(cerebro));

ok('no page errors', errores.length === 0, errores.slice(0, 3).join(' | '));

// ── tablero del copiloto, con un Translator de mentira (en inglés) ──────────
{
  const TRANSLATOR = 'https://translator.elffuss.com';
  const STUB = '<!doctype html><html><body>stub<script>window.__msgs=[];addEventListener("message",e=>window.__msgs.push({origin:e.origin,data:e.data}));</script></body></html>';
  const { ctx: c2 } = await contexto(b, { locale: 'en-US', grants: ['apps'],
    rutas: async (url, route) => { if (!url.startsWith(TRANSLATOR + '/')) return false; await route.fulfill({ status: 200, contentType: 'text/html', body: STUB }); return true; } });
  const stub = await c2.newPage();
  await stub.goto(TRANSLATOR + '/copilot-test.html');
  const { BASE } = await import('./ux-comun.mjs');
  const [claw] = await Promise.all([c2.waitForEvent('page'), stub.evaluate(u => { window.__claw = window.open(u, 'claw'); }, BASE + '/?copilot=1&skill=ficha')]);
  await claw.waitForFunction(() => !!window.elffuss?.agent, null, { timeout: 15000 });
  await hasta(() => stub.evaluate(() => window.__msgs.some(m => m.data?.kind === 'copilot-ready')));
  await stub.evaluate(o => window.__claw.postMessage({ kind: 'copilot-init', skill: 'ficha', sellerLangName: 'English' }, o), new URL(BASE).origin);
  const tablero = () => claw.frames().find(f => f !== claw.mainFrame() && /\/sandbox\/run\.html\?n=/.test(f.url()));
  ok('the copilot board is in English (title, labels, live box, export)', await hasta(async () => {
    const f = tablero(); if (!f) return false;
    // textContent y no innerText: la hoja del tablero pasa a MAYÚSCULAS algunas
    // etiquetas, e innerText devuelve el texto ya transformado.
    const t = await f.evaluate(() => ['h1', '.sub', '#slots', '.advice', '#exp'].map(s => document.querySelector(s)?.textContent || '').join(' | ')).catch(() => '');
    return /Client record/.test(t) && /Captured data/.test(t) && /Company/.test(t) && /Waiting for the conversation to start/.test(t)
      && /Export to Excel/.test(t) && !/Ficha de cliente|Datos capturados|Empresa|Esperando/.test(t);
  }), await tablero()?.evaluate(() => document.body.textContent.slice(0, 300)).catch(() => '?'));
  const proyectado = await stub.evaluate(() => window.__msgs.find(m => m.data?.kind === 'surface')?.data?.title || '');
  ok('…and so is the board projected to the Translator', /Client record/.test(proyectado), proyectado);
  await c2.close();
}

await fin(b, 'INGLÉS: lo rehecho en la auditoría habla inglés con la página en inglés');
