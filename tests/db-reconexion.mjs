// La conexión IndexedDB de web/js/db.js (la de Claw y la de su puente, que usa el
// chat de elffuss.com) sobrevive a que el navegador la cierre. Safari la cierra
// por su cuenta (pestaña dormida, falta de memoria, almacenamiento desalojado) y
// cada db.transaction() siguiente lanzaba «The database connection is closing».
// Sobre un IndexedDB falso (tests/lib/fake-idb.mjs) que cierra la conexión entre
// llamadas o debajo de una transacción: lecturas y escrituras reabren y se
// repiten UNA vez, una escritura nunca se aplica dos veces, y lo que falla por
// sí mismo no se repite. Solo Node:
//   node tests/db-reconexion.mjs
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fakeIndexedDB } from './lib/fake-idb.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
let fallos = 0, n = 0;
const ok = (nombre, c, e = '') => { n++; console.log((c ? '✅' : '❌') + ' ' + nombre + (e && !c ? '  — ' + e : '')); if (!c) fallos++; };
const falla = async p => { try { await p; return null; } catch (e) { return e || new Error('rechazada sin error'); } };

const idb = fakeIndexedDB();
globalThis.indexedDB = idb;
const db = await import(pathToFileURL(resolve(process.env.DB_JS || join(AQUI, '..', 'web', 'js', 'db.js'))).href);

await db.set('apps', 'reloj', { html: '<p>1</p>' });
ok('una escritura sin cierres se guarda una vez', idb.stats.writes === 1);

idb.closeAll();
ok('tras cerrar el navegador la conexión, leer reabre y lee', (await db.get('apps', 'reloj'))?.html === '<p>1</p>');
ok('… con UNA apertura nueva', idb.stats.opens === 2, String(idb.stats.opens));

idb.closeAll();
await db.set('apps', 'nota', { html: 'n' });
ok('tras un cierre, escribir guarda exactamente una vez', idb.stats.writes === 2, String(idb.stats.writes));

idb.abortNext();
let w = idb.stats.writes;
await db.set('apps', 'tres', { html: '3' });
ok('una escritura que el navegador abortó se repite y se aplica una vez', idb.stats.writes - w === 1, String(idb.stats.writes - w));

idb.abortNext();
ok('una lectura abortada se repite', (await db.keys('apps')).sort().join() === 'nota,reloj,tres');

idb.abortNext(2);
w = idb.stats.writes;
const t = idb.stats.transactions;
const e = await falla(db.set('apps', 'cuatro', { html: '4' }));
ok('abortada dos veces seguidas: el error llega a quien llama (un solo reintento)', e?.name === 'AbortError', String(e?.name));
ok('… tras exactamente dos intentos y sin escribir nada', idb.stats.transactions - t === 2 && idb.stats.writes === w);

// update: leer-modificar-escribir. Si se repite, `fn` vuelve a ver lo guardado y el cambio se aplica una vez.
await db.set('kv', 'cuenta', 0);
idb.abortNext();
let llamadas = 0;
const nuevo = await db.update('kv', 'cuenta', v => { llamadas++; return v + 1; });
ok('update abortado se repite entero: cuenta 1, no 2', nuevo === 1 && (await db.get('kv', 'cuenta')) === 1, `nuevo ${nuevo}, guardado ${await db.get('kv', 'cuenta')}`);
idb.closeAll();
const e2 = await falla(db.update('kv', 'cuenta', () => { throw Object.assign(new Error('no'), { name: 'TypeError' }); }));
ok('update cuyo fn falla no se repite (el error es suyo)', e2?.name === 'TypeError');

idb.versionChangeAll();
ok('otra pestaña pide versión nueva: la conexión se aparta', idb.liveConnections === 0);
ok('… y la siguiente llamada reabre', (await db.all('apps')).length === 3);

console.log(`\n${n - fallos}/${n} ${fallos ? '❌' : '✅'}`);
process.exit(fallos ? 1 : 0);
