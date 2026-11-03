// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// La memoria compartida, sin navegador: la configuración de Elffuss, las
// cabeceras de la página almacén y lo que la página y el puente dejan hacer.
//
//   node tests/memoria-v2-config.mjs
//
// Necesita el motor copiado en web/js/engine/ (con los módulos de memoria). Si
// no está, FALLA: un saltado en silencio sería un verde que no comprueba nada.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const W = (p) => join(RAIZ, 'web', p);
let fallos = 0;
const ok = (n, c, e = '') => { console.log((c ? '✅' : '❌') + ' ' + n + (e ? '  — ' + e : '')); if (!c) fallos++; };

ok('el motor copiado trae los módulos de memoria (web/js/engine/memory*.js)',
  ['memory.js', 'memory-store.js', 'memory-ui.js', 'memory-cards.js', 'memory-config.js', 'tuning.js'].every((f) => existsSync(W('js/engine/' + f))));
if (fallos) { console.log('Sin el motor con memoria no se puede comprobar el resto.'); process.exit(1); }

const cfg = (await import(pathToFileURL(W('memory/memory.config.js')).href)).default;
const { defineMemoryConfig } = await import(pathToFileURL(W('js/engine/memory-config.js')).href);

// ── La configuración ─────────────────────────────────────────────────────────
ok('la config pasa la validación del motor y queda congelada', cfg.__valid === true && Object.isFrozen(cfg));
ok('espacio de nombres «elffuss-memory», marca «Elffuss»', cfg.namespace === 'elffuss-memory' && cfg.brand.name === 'Elffuss');
ok('la página almacén vive en Claw: https://claw.elffuss.com/memory/', cfg.storeUrl === 'https://claw.elffuss.com/memory/');
const origenes = cfg.apps.map((a) => a.origin);
ok('exactamente tres apps: el chat, Claw y Code, con sus orígenes de producción',
  JSON.stringify(cfg.apps.map((a) => [a.id, a.origin])) === JSON.stringify([['chat', 'https://elffuss.com'], ['claw', 'https://claw.elffuss.com'], ['code', 'https://code.elffuss.com']]));
ok('ningún origen de pruebas en la config (localhost, 127.0.0.1, http:)', !origenes.some((o) => /localhost|127\.0\.0\.1|^http:/.test(o)));
ok('cada app con su nombre en español y en inglés', cfg.apps.every((a) => a.label.es && a.label.en));
ok('la memoria vieja de Claw se migra desde IndexedDB «elffuss», almacén «memory»',
  cfg.legacy && cfg.legacy.db === 'elffuss' && cfg.legacy.store === 'memory' && cfg.legacy.app === 'claw');
ok('el ámbito «este proyecto» es solo de Code', JSON.stringify(cfg.features.projectScope) === '["code"]');
ok('colores solo como fichas --mem-* (claro: el chat; oscuro: Claw)',
  Object.keys(cfg.theme.light).every((k) => k.startsWith('--mem-')) && cfg.theme.dark['--mem-bg'] === '#303752');
// La config no puede abrir la puerta a otro sitio: el motor lo rechaza.
let rechazo = '';
try { defineMemoryConfig({ brand: { name: 'Elffuss' }, namespace: 'elffuss-memory', storeUrl: 'https://claw.elffuss.com/memory/', apps: [{ id: 'x', origin: 'https://evil.test', label: { es: 'x' } }] }); }
catch (e) { rechazo = e.message; }
ok('una app de otro sitio en la config se rechaza (cross-site)', /cross-site/.test(rechazo), rechazo.slice(0, 80));

// ── Las cabeceras que se despliegan ──────────────────────────────────────────
const conf = readFileSync(join(RAIZ, 'server', 'memory', 'headers.conf'), 'utf8');
const csp = (/add_header Content-Security-Policy "([^"]+)" always;/.exec(conf) || [])[1] || '';
const fa = (/frame-ancestors ([^;"]+)/.exec(csp) || [])[1]?.trim().split(/\s+/) || [];
ok('headers.conf es para la ruta de la página almacén', new RegExp(`location \\^~ ${new URL(cfg.storeUrl).pathname} \\{`).test(conf));
ok('frame-ancestors son EXACTAMENTE los orígenes de la config', JSON.stringify(fa) === JSON.stringify(origenes), fa.join(' '));
ok("connect-src 'none' (la página no puede mandar la memoria a ninguna parte)", /connect-src 'none'/.test(csp));
ok("default-src 'none', script-src 'self', base-uri y form-action cerrados",
  /default-src 'none'/.test(csp) && /script-src 'self'/.test(csp) && /base-uri 'none'/.test(csp) && /form-action 'none'/.test(csp));
ok('sin referrer, recursos solo del mismo sitio, nosniff, no-cache',
  /Referrer-Policy "no-referrer"/.test(conf) && /Cross-Origin-Resource-Policy "same-site"/.test(conf) && /nosniff/.test(conf) && /Cache-Control "no-cache"/.test(conf));
ok('sin registro de accesos en esa ruta', /access_log off;/.test(conf));

// ── La página almacén ────────────────────────────────────────────────────────
const html = readFileSync(W('memory/index.html'), 'utf8');
const metaCsp = (/http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html) || [])[1] || '';
ok("la página lleva su propia CSP sin red aunque falten las cabeceras", /connect-src 'none'/.test(metaCsp) && /default-src 'none'/.test(metaCsp));
ok('sin script en línea: solo ./page.js como módulo', !/<script(?![^>]*src=)/.test(html) && /<script type="module" src="\.\/page\.js"><\/script>/.test(html));
const page = readFileSync(W('memory/page.js'), 'utf8');
ok('page.js solo monta la página del motor con la config de Elffuss',
  /import \{ mountStorePage \} from '\.\.\/js\/engine\/memory-ui\.js';/.test(page) && /mountStorePage\(cfg\);/.test(page) && !/fetch|XMLHttpRequest|WebSocket/.test(page));

// ── El puente v1 (bridge.js) ─────────────────────────────────────────────────
const bridge = readFileSync(W('js/bridge.js'), 'utf8');
const codigo = bridge.replace(/^\s*\/\/.*$/gm, '');
ok('el puente sigue permitiendo SOLO https://elffuss.com', /const ALLOWED = \['https:\/\/elffuss\.com'\];/.test(codigo) && !/localhost|127\.0\.0\.1/.test(codigo));
ok('el puente ya no escribe ni borra el almacén «memory» viejo de Claw', !/db\.(set|del)\('memory'/.test(codigo));
ok('memory.save del puente no guarda: propone, etiquetado «no sale de tus palabras»', /llama\('propose', \{ fact, label: 'from-content' \}\)/.test(codigo));
ok('memory.forget del puente se rechaza siempre', /'memory\.forget'[\s\S]{0,200}throw new Rechazo\(MEMORIA_V1\.olvidaEnMemoria\)/.test(codigo));
ok('las apps del puente siguen igual (apps.list/get/save/remove)', ['apps.list', 'apps.get', 'apps.save', 'apps.remove'].every((o) => codigo.includes(`'${o}'`)));

if (fallos) { console.log(`\n${fallos} fallo(s)`); process.exit(1); }
console.log('\n✅ memoria compartida: config, cabeceras, página almacén y puente');
