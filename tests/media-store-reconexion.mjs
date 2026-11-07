// El almacén de medios (IndexedDB «elffuss-media» de web/js/tools/media-tools.js) sobrevive a que el navegador cierre
// la conexión: Safari lo hace solo (pestaña dormida, falta de memoria, almacenamiento desalojado) y cada transacción
// siguiente lanzaba «The database connection is closing». Sobre un IndexedDB falso (tests/lib/fake-idb.mjs): guardar y
// leer tras un cierre reabren, un guardado abortado se repite y se aplica una vez, y sin IndexedDB (ventana privada)
// los medios viven en memoria. Solo Node:
//   node tests/media-store-reconexion.mjs
import { fakeIndexedDB } from './lib/fake-idb.mjs';

let fallos = 0, n = 0;
const ok = (nombre, c, e = '') => { n++; console.log((c ? '✅' : '❌') + ' ' + nombre + (e && !c ? '  — ' + e : '')); if (!c) fallos++; };

const idb = fakeIndexedDB();
globalThis.indexedDB = idb;
const m = await import('../web/js/tools/media-tools.js');

const a = await m.putMedia({ kind: 'image', mime: 'image/png', blob: null, chat: 'c1' });
idb.closeAll();
ok('tras cerrar el navegador la conexión, leer un medio reabre y lo lee', (await m.getMedia(a.id))?.id === a.id);
idb.closeAll();
idb.abortNext();
const w = idb.stats.writes;
const b = await m.putMedia({ kind: 'audio', mime: 'audio/wav', blob: null, chat: 'c1' });
ok('un guardado tras un cierre y un aborto se aplica una vez', idb.stats.writes - w === 1 && (await m.getMedia(b.id))?.id === b.id, String(idb.stats.writes - w));
idb.versionChangeAll();
ok('versionchange aparta la conexión y la siguiente lectura reabre', idb.liveConnections === 0 && (await m.getMedia(a.id))?.id === a.id);

globalThis.indexedDB = { open() { throw Object.assign(new Error('denied'), { name: 'SecurityError' }); } };
const priv = await import('../web/js/tools/media-tools.js?privada');
ok('sin IndexedDB, un id desconocido es null (antes, el envoltorio {result})', (await priv.getMedia('img-nada')) === null);
const c = await priv.putMedia({ kind: 'image', mime: 'image/png', blob: null });
ok('sin IndexedDB, lo guardado se lee en la visita', (await priv.getMedia(c.id))?.id === c.id);

console.log(`\n${n - fallos}/${n} ${fallos ? '❌' : '✅'}`);
process.exit(fallos ? 1 : 0);
