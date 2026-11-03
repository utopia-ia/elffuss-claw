// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// ¿Las cabeceras de server/memory/headers.conf llegan DE VERDAD a la página
// almacén con el server de claw.elffuss.com tal como está?
//
//   node tests/memoria-v2-nginx.mjs
//
// Antes no llegaban: el fragmento era un `location /memory/` de prefijo y el
// server tiene un `location ~* \.(js|mjs|html|css|json)$`. nginx prefiere una
// regex que case antes que un prefijo sin `^~`; `/memory/` hace una redirección
// interna a `/memory/index.html` (index) y esa la servía la regex, solo con
// Cache-Control: sin CSP (ni frame-ancestors ni connect-src 'none') y con
// registro de accesos. La prueba con el servidor local de memoria-v2.mjs no lo
// veía porque no es nginx.
//
// Aquí se resuelve qué `location` sirve cada petición con las reglas de nginx
// (exacta «=», el prefijo más largo, «^~» corta las regex, si no la primera
// regex que case en orden, si no el prefijo) más la redirección interna de
// `index`, sobre el fragmento que se despliega metido en la forma del server de
// claw.elffuss.com. Si hay un `nginx` en el PATH, además se valida la sintaxis
// del conjunto con `nginx -t`.
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const conf = readFileSync(join(AQUI, '..', 'server', 'memory', 'headers.conf'), 'utf8');
let fallos = 0;
const ok = (n, c, e = '') => { console.log((c ? '✅' : '❌') + ' ' + n + (e ? '  — ' + e : '')); if (!c) fallos++; };

// La forma del server de claw.elffuss.com (solo lo que decide la ruta: sin
// certificados ni rutas privadas). El fragmento se incluye donde se desplegará.
const SERVER = `
server {
    index index.html;
    location ~ \\.mjs$ { default_type text/javascript; add_header Cache-Control "no-cache" always; }
    location = /proxy/report { return 204; }
    location = /proxy { return 204; }
    location ~* \\.(js|mjs|html|css|json)$ { add_header Cache-Control "no-cache" always; }
    location / { try_files $uri $uri/ =404; }
    access_log /dev/null;
    #MEMORY#
}`;

// Lee los `location` de un texto de nginx (un nivel, llaves equilibradas).
function locations(texto) {
  const out = [];
  const re = /location\s+(=|\^~|~\*|~)?\s*(\S+)\s*\{/g;
  let m;
  while ((m = re.exec(texto))) {
    let i = re.lastIndex, prof = 1;
    while (i < texto.length && prof) { if (texto[i] === '{') prof++; else if (texto[i] === '}') prof--; i++; }
    out.push({ mod: m[1] || '', patron: m[2], cuerpo: texto.slice(re.lastIndex, i - 1) });
    re.lastIndex = i;
  }
  return out;
}
// Qué location sirve una URI, con las reglas de nginx.
function elige(locs, uri) {
  const exacta = locs.find((l) => l.mod === '=' && l.patron === uri);
  if (exacta) return exacta;
  const prefijos = locs.filter((l) => (l.mod === '' || l.mod === '^~') && uri.startsWith(l.patron)).sort((a, b) => b.patron.length - a.patron.length);
  const largo = prefijos[0];
  if (largo?.mod === '^~') return largo;
  for (const l of locs) {
    if (l.mod !== '~' && l.mod !== '~*') continue;
    if (new RegExp(l.patron, l.mod === '~*' ? 'i' : '').test(uri)) return l;
  }
  return largo || null;
}
// Con `index`, una URI que acaba en «/» se redirige por dentro a «…/index.html»
// y se vuelve a elegir location: la que cuenta es la que sirve el fichero.
const sirve = (locs, uri) => elige(locs, uri.endsWith('/') ? uri + 'index.html' : uri);

const ruta = new URL('https://claw.elffuss.com/memory/').pathname;
const locs = locations(SERVER.replace('#MEMORY#', conf));
const mem = locations(conf)[0];
ok('headers.conf trae un location para la ruta de la página almacén', !!mem && mem.patron === ruta, mem && `${mem.mod} ${mem.patron}`);
for (const uri of [ruta, ruta + 'index.html', ruta + 'page.js', ruta + 'memory.config.js']) {
  const l = sirve(locs, uri);
  ok(`${uri} lo sirve el location de la memoria (no la regex de .js/.html del server)`, l === locs.find((x) => x.cuerpo === mem.cuerpo), l ? `${l.mod} ${l.patron}` : 'ninguno');
}
const l = sirve(locs, ruta);
ok("…así que la página lleva frame-ancestors y connect-src 'none'", !!l && /frame-ancestors /.test(l.cuerpo) && /connect-src 'none'/.test(l.cuerpo));
ok('…y sin registro de accesos', !!l && /access_log off;/.test(l.cuerpo));
ok('el resto de Claw sigue igual: /js/app.js y / (su index.html) por la regex, /apps/x por el prefijo',
  sirve(locs, '/js/app.js')?.mod === '~*' && sirve(locs, '/')?.mod === '~*' && sirve(locs, '/apps/x')?.patron === '/');

// Con nginx a mano, que el conjunto también sea válido para nginx.
let nginx = null;
try { nginx = execFileSync('sh', ['-c', 'command -v nginx'], { encoding: 'utf8' }).trim(); } catch { /* sin nginx */ }
if (nginx) {
  const dir = mkdtempSync(join(tmpdir(), 'memoria-nginx-'));
  mkdirSync(join(dir, 'logs'));
  writeFileSync(join(dir, 'nginx.conf'), `pid ${dir}/nginx.pid; error_log ${dir}/logs/error.log; events {}\nhttp {\n${SERVER.replace('#MEMORY#', conf).replace('server {', `server { listen 127.0.0.1:1; root ${dir};`)}\n}\n`);
  let salida = '';
  try { salida = execFileSync(nginx, ['-t', '-p', dir, '-c', join(dir, 'nginx.conf')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); ok('nginx -t acepta el server con el fragmento', true); }
  catch (e) { ok('nginx -t acepta el server con el fragmento', false, String(e.stderr || e.message || salida).slice(0, 200)); }
} else {
  console.log('· sin nginx en el PATH: solo se comprueban las reglas de elección');
}

if (fallos) { console.log(`\n❌ ${fallos} fallo(s)`); process.exit(1); }
console.log('\n✅ las cabeceras de la memoria llegan a la página almacén con el server de Claw');
