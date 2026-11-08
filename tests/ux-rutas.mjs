// Direcciones y enlaces: las pestañas son pestañas (tablist) con dirección en la
// URL (#/apps, #/tareas…), se recorren con «Atrás» y con las flechas, una app se
// abre por su dirección, y el chat enlaza: URL de fuera con noopener/noreferrer,
// rutas de Claw en la misma pestaña, nada de javascript:. El informe de errores
// no lleva el fragmento.
//
//   BASE=http://localhost:8743 node tests/ux-rutas.mjs
import { navegador, contexto, pagina, ok, hasta, espera, escribir, avisos, fin, BASE } from './ux-comun.mjs';

const b = await navegador();
const { ctx } = await contexto(b, { grants: ['apps'] });
const { p, errores } = await pagina(ctx);
const activa = () => p.evaluate(() => {
  const t = document.querySelector('#tabs [aria-selected="true"]');
  return t ? { tab: t.dataset.tab, tabindex: t.tabIndex, panel: document.querySelector('.panel.active')?.id, hash: location.hash } : null;
});

const sem = await p.evaluate(() => ({
  lista: document.getElementById('tabs').getAttribute('role'),
  tabs: [...document.querySelectorAll('#tabs button')].every(b => b.getAttribute('role') === 'tab' && b.getAttribute('aria-controls') === 'panel-' + b.dataset.tab),
  paneles: [...document.querySelectorAll('.panel')].every(p => p.getAttribute('role') === 'tabpanel'),
}));
ok('pestañas con semántica de tablist / tab / tabpanel', sem.lista === 'tablist' && sem.tabs && sem.paneles, JSON.stringify(sem));

await p.click('#tabs button[data-tab="apps"]');
let a = await activa();
ok('clic en Apps: aria-selected, tabindex 0 y la URL dice #/apps', a.tab === 'apps' && a.tabindex === 0 && a.hash === '#/apps', JSON.stringify(a));
await p.click('#tabs button[data-tab="tareas"]');
await p.goBack();
ok('«Atrás» vuelve a Apps', await hasta(async () => (await activa()).tab === 'apps'), JSON.stringify(await activa()));
await p.goBack();
ok('y otra vez «Atrás», a la Vista', await hasta(async () => (await activa()).tab === 'vista'), JSON.stringify(await activa()));

await p.focus('#tabs button[data-tab="vista"]');
await p.keyboard.press('ArrowRight');
a = await activa();
ok('→ en las pestañas pasa a la siguiente y le da el foco', a.tab === 'apps' && await p.evaluate(() => document.activeElement?.dataset.tab) === 'apps', JSON.stringify(a));
await p.keyboard.press('End');
ok('Fin va a la última (Ajustes)', (await activa()).tab === 'ajustes');

// ── abrir por dirección ─────────────────────────────────────────────────────
await p.goto(BASE + '/#/ajustes', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.elffuss?.agent);
ok('abrir la página en #/ajustes abre Ajustes', await hasta(async () => (await activa())?.tab === 'ajustes'));

await escribir(p, 'hazme un reloj');
ok('el modo básico crea la app «reloj» y la URL la nombra (#/apps/reloj)', await hasta(() => p.evaluate(() =>
  !document.getElementById('appframe').hidden && location.hash === '#/apps/reloj')), await p.evaluate(() => location.hash));
const enlaceTool = p.locator('#log .msg.tool a.tool-link').last();
ok('la línea «🔧 app.create» enlaza a la app', await enlaceTool.getAttribute('href') === '#/apps/reloj');
await p.click('#tabs button[data-tab="permisos"]');
await enlaceTool.click();
ok('y pulsarlo la vuelve a abrir en la Vista', await hasta(async () => (await activa()).tab === 'vista'
  && await p.evaluate(async () => /toLocaleTimeString/.test((await import('/js/sandbox-frame.js')).frameHtml(document.getElementById('appframe'))))));

await p.goto(BASE + '/#/apps/reloj', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.elffuss?.agent);
ok('cargar #/apps/reloj abre esa app', await hasta(() => p.evaluate(async () =>
  !document.getElementById('appframe').hidden && /toLocaleTimeString/.test((await import('/js/sandbox-frame.js')).frameHtml(document.getElementById('appframe'))))));
ok('el visor lleva el nombre de la app como título', /reloj/.test(await p.getAttribute('#appframe', 'title')));
await p.goto(BASE + '/#/apps/no-existe', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.elffuss?.agent);
ok('una app que no existe lo dice y abre el panel de Apps', await hasta(async () =>
  (await avisos(p)).some(t => /no-existe/.test(t)) && (await activa()).tab === 'apps'));

// ── enlaces en el chat ──────────────────────────────────────────────────────
const html = await p.evaluate(async () => {
  const ui = await import('/js/ui.js');
  const m = ui.addMsg('assistant', 'Mira https://example.com/x?a=1&b=2. Y [esto](javascript:alert(1)) y [Apps](#/apps).');
  ui.addToolResult('web.fetch', '[https://example.org/pagina]\nTexto de la página <script>x</script>');
  const r = document.querySelector('#log details.tool-result:last-of-type pre');
  return { m: m.innerHTML, r: r.innerHTML };
});
ok('una URL en la respuesta es un enlace a pestaña nueva, sin referrer', /<a href="https:\/\/example\.com\/x\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">/.test(html.m), html.m);
ok('javascript: NO se convierte en enlace', !/href="javascript/.test(html.m) && /\[esto\]\(javascript:alert\(1\)\)/.test(html.m));
ok('una ruta de Claw es un enlace en la misma pestaña', /<a href="#\/apps">Apps<\/a>/.test(html.m));
ok('en los resultados de herramientas las URL también se abren, y el HTML sigue escapado',
  /<a href="https:\/\/example\.org\/pagina" target="_blank" rel="noopener noreferrer">/.test(html.r) && /&lt;script&gt;/.test(html.r), html.r);

// ── el informe de errores no lleva el fragmento ─────────────────────────────
let cuerpo = null;
await p.route('**/proxy/report', async route => { cuerpo = route.request().postData(); await route.fulfill({ status: 200, body: '{"ok":true}' }); });
await p.evaluate(async () => {
  location.hash = '#/apps/reloj';
  const tel = await import('/js/telemetry.js');
  tel.setEnabled(true);
  await tel.reportError('prueba de ruta');
  tel.setEnabled(false);
});
await hasta(() => !!cuerpo);
const url = cuerpo ? JSON.parse(cuerpo).url : '';
ok('el informe lleva la página pero no #/apps/reloj', !!url && !url.includes('#') && url.startsWith(BASE), url);

ok('sin errores de página', errores.length === 0, errores.slice(0, 3).join(' | '));
await fin(b, 'RUTAS: pestañas con dirección, «Atrás», flechas, apps por URL y enlaces seguros en el chat');
