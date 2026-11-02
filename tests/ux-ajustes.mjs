// Ajustes: proveedores externos, feedback y «Acerca de».
//   · «Servidor Elffuss (Ornith 9B)» ya no se ofrece (el servicio está parado y
//     elegirlo fallaba siempre), aunque estuviera activado de antes.
//   · La casilla de cada proveedor tiene nombre; al activarla el aviso lleva al
//     selector de modelo (no al 🧠).
//   · El feedback dice si llegó: si falla, lo dice y el texto se queda.
//   · «Acerca de» enlaza el código, la comunidad, las incidencias y la licencia;
//     el sello del build enlaza su commit solo si es un commit limpio.
//   · Con el teclado el foco no cae a <body>: «Enviar» lo conserva mientras
//     envía, y olvidar un hecho (o deshacerlo) lo lleva al ✕ que toca.
//
//   BASE=http://localhost:8743 node tests/ux-ajustes.mjs
import { navegador, contexto, pagina, ok, hasta, avisos, fin, BASE } from './ux-comun.mjs';

const b = await navegador();
const { ctx } = await contexto(b, {
  extraInit: { 'elffuss.providers': JSON.stringify({ server: { enabled: true, baseURL: 'https://claw.elffuss.com/v1', model: 'ornith-9b', apiKey: '' } }) },
});
const { p, errores } = await pagina(ctx);
const foco = () => p.evaluate(() => {
  const a = document.activeElement;
  return !a || a === document.body ? 'BODY' : (a.getAttribute('aria-label') || a.textContent || a.id).trim().slice(0, 80);
});
const abrirAjustes = async () => { await p.click('#tabs button[data-tab="ajustes"]'); await p.locator('#panel-ajustes .ext-block').waitFor(); };
await abrirAjustes();
await p.click('#panel-ajustes .ext-block > summary');
ok('el servidor Ornith 9B no se ofrece en Ajustes', !(await p.locator('#panel-ajustes').innerText()).includes('Ornith'));
ok('…ni en el selector aunque estuviera activado de antes', !(await p.evaluate(() =>
  [...document.querySelectorAll('#model-select option')].some(o => o.value === 'ext:server'))));

const casilla = p.locator('#prov-ollama');
ok('la casilla de cada proveedor tiene nombre', await casilla.getAttribute('aria-label') === 'Activar Ollama (local)'
  && await p.locator('label[for="prov-ollama"]').count() === 1);
await casilla.check();
const aviso = p.locator('#toasts .toast', { hasText: 'Ollama' });
ok('activarlo dice «elígelo en el selector de modelo», no «🧠»', await hasta(async () => /selector de modelo/.test(await aviso.innerText().catch(() => '')))
  && !/🧠/.test(await aviso.innerText()));
ok('…y aparece en el selector', await p.evaluate(() => [...document.querySelectorAll('#model-select option')].some(o => o.value === 'ext:ollama')));
await aviso.locator('.toast-accion').click();
ok('su botón lleva al selector de modelo', await p.evaluate(() => document.activeElement?.id === 'model-select'
  && !document.getElementById('model-pop').hidden));
// El selector vive en el desplegable de la pastilla del cerebro: Escape lo cierra.
await p.keyboard.press('Escape');

// ── feedback ────────────────────────────────────────────────────────────────
let estado = 500, recibido = null;
await p.route('**/proxy/report', async route => { recibido = route.request().postDataJSON(); await route.fulfill({ status: estado, body: estado === 200 ? '{"ok":true}' : 'caído' }); });
await abrirAjustes();
await p.fill('#tel-feedback', 'el botón X no hace nada');
await p.locator('#panel-ajustes button:has-text("Enviar")').focus();
await p.keyboard.press('Enter');
ok('si el envío falla, lo dice y el texto se queda', await hasta(async () => (await avisos(p)).some(t => /No ha llegado/.test(t)))
  && (await p.inputValue('#tel-feedback')) === 'el botón X no hace nada' && !(await avisos(p)).some(t => /gracias/.test(t)));
ok('…y con el teclado el foco sigue en «Enviar» (no cae a <body>)', (await foco()) === 'Enviar', await foco());
ok('…y ofrece el sitio público de incidencias', await p.locator('#toasts .toast', { hasText: 'No ha llegado' }).locator('.toast-accion').innerText() === 'Abrir incidencias');
estado = 200;
await p.click('#panel-ajustes button:has-text("Enviar")');
ok('si llega, da las gracias y vacía el texto', await hasta(async () => (await avisos(p)).some(t => /gracias/.test(t)))
  && (await p.inputValue('#tel-feedback')) === '' && recibido?.kind === 'feedback');
ok('enviar feedback a mano no deja encendido el envío automático', !(await p.evaluate(async () => (await import('/js/telemetry.js')).isEnabled())));

// ── acerca de ───────────────────────────────────────────────────────────────
const acerca = p.locator('#panel-ajustes [data-ruta="acerca"]');
const hrefs = await acerca.locator('a').evaluateAll(as => as.map(a => [a.getAttribute('href'), a.getAttribute('rel')]));
ok('«Acerca de» enlaza el código, la comunidad y las incidencias (sin referrer)',
  hrefs.some(([h]) => h === 'https://github.com/KikoCis/elffuss-claw') && hrefs.some(([h]) => h === 'https://git.elffuss.com/elffuss/claw')
  && hrefs.some(([h]) => h === 'https://git.elffuss.com/elffuss/claw/issues') && hrefs.every(([, r]) => r === 'noopener noreferrer'), JSON.stringify(hrefs));
ok('…dice la licencia y, en desarrollo, que no hay sello', /Apache-2\.0/.test(await acerca.innerText()) && /de desarrollo/.test(await acerca.innerText()));
const sellos = await p.evaluate(async () => {
  const ui = await import('/js/ui.js');
  const limpio = ui.enlaceBuild('7b2385c'), sucio = ui.enlaceBuild('7b2385c-dirty');
  return { limpio: limpio.tagName + ' ' + limpio.getAttribute('href'), sucio: sucio.tagName + ' ' + (sucio.getAttribute('href') || '') };
});
ok('un sello limpio enlaza su commit en GitHub; uno «-dirty» no enlaza', sellos.limpio === 'A https://github.com/KikoCis/elffuss-claw/commit/7b2385c' && sellos.sucio === 'SPAN ', JSON.stringify(sellos));
await p.goto(BASE + '/#/ajustes/acerca', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.elffuss?.agent);
ok('#/ajustes/acerca lleva a esa tarjeta', await hasta(() => p.evaluate(() =>
  document.querySelector('#panel-ajustes [data-ruta="acerca"]')?.classList.contains('resaltado'))));

// ── memoria: se ve y se olvida hecho a hecho ────────────────────────────────
await p.evaluate(async () => {
  const db = await import('/js/db.js');
  await db.set('memory', 'mprueba', { id: 'mprueba', fact: 'le gusta el té verde', at: Date.now() });
  await db.set('memory', 'mprueba2', { id: 'mprueba2', fact: 'vive en Madrid', at: Date.now() + 1 });
});
await p.goto(BASE + '/#/memoria/mprueba', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.elffuss?.agent);
const hecho = p.locator('#panel-ajustes [data-ruta="mprueba"]');
ok('#/memoria/<id> abre Ajustes y señala ese hecho (sin el texto en la URL)', await hasta(async () =>
  await hecho.evaluate(e => e.classList.contains('resaltado')).catch(() => false)) && !/t%C3%A9|té/.test(await p.evaluate(() => location.href)));
await hecho.locator('button[aria-label="Olvidar «le gusta el té verde»"]').focus();
await p.keyboard.press('Enter');
ok('✕ lo olvida…', await hasta(async () => await hecho.count() === 0)
  && !(await p.evaluate(async () => (await (await import('/js/db.js')).get('memory', 'mprueba')))));
ok('…con el teclado, el foco va al ✕ del hecho que queda en su sitio', await hasta(async () => (await foco()) === 'Olvidar «vive en Madrid»'), await foco());
await p.locator('#toasts .toast', { hasText: 'Olvidado' }).locator('.toast-accion').focus();
await p.keyboard.press('Enter');
ok('…y «Deshacer» lo devuelve', await hasta(async () => await hecho.count() === 1));
ok('…con el foco en su ✕', await hasta(async () => (await foco()) === 'Olvidar «le gusta el té verde»'), await foco());
ok('el lema de la cabecera sale en español', (await p.locator('.brand .claim').first().innerText()) === 'las apps no existen: se crean');

// ── el modo básico señala el selector de modelo, no el 🧠 ───────────────────
await p.fill('#prompt', 'hola');
await p.press('#prompt', 'Enter');
const enlace = p.locator('#log .msg.assistant a[href="#/modelo"]').last();
ok('la ayuda del modo básico enlaza al «selector de modelo»', await hasta(async () => await enlace.count() === 1)
  && !/selector 🧠/.test(await p.locator('#log').innerText()));
await enlace.click();
ok('…y el enlace lo enfoca (y la URL vuelve a decir dónde estás)', await hasta(() => p.evaluate(() =>
  document.activeElement?.id === 'model-select' && location.hash !== '#/modelo')));

{
  const { ctx: c2 } = await contexto(b, { locale: 'en-US' });
  const { p: e } = await pagina(c2);
  ok('en inglés el lema de la cabecera sale en inglés', (await e.locator('.brand .claim').first().innerText()) === 'apps don’t exist: they get created');
  await c2.close();
}

ok('sin errores de página', errores.length === 0, errores.slice(0, 3).join(' | '));
await fin(b, 'AJUSTES: sin Ornith roto, casillas con nombre, feedback honesto y «Acerca de» con enlaces');
