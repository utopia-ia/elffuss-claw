// Registro de herramientas: lo único que el agente puede tocar del mundo.
import * as fs from './fs.js';
import * as apps from './apps.js';
import * as vault from './vault.js';
import * as tasks from './tasks.js';
import * as web from './web.js';
import * as memory from './memory.js';
import * as watch from './watch.js';
import * as skills from '../skills.js';
import { t } from '../i18n.js';

export { fs, apps, vault, tasks, web, memory, watch };

export const TOOLS = {
  'fs.pick_folder': { desc: 'Pedir al usuario que autorice una carpeta de su ordenador', params: {}, run: () => fs.pickFolder() },
  'fs.list':  { desc: 'Listar archivos de una ruta relativa dentro de la carpeta autorizada', params: { path: 'ruta relativa (opcional)' }, run: a => fs.list(a) },
  'fs.read':  { desc: 'Leer un archivo de texto', params: { path: 'ruta relativa' }, run: a => fs.read(a) },
  'fs.write': { desc: 'Escribir o crear un archivo de texto', params: { path: 'ruta', content: 'contenido' }, run: a => fs.write(a) },
  'fs.copy':  { desc: 'Copiar archivos entre dos carpetas autorizadas (una vez)', params: { pattern: '*.txt', from: 'carpeta origen', to: 'carpeta destino' }, run: a => fs.copy(a) },
  'fs.watch': { desc: 'AUTOMATIZACIÓN: vigilar una carpeta — lo que se deje ahí se procesa (Excel→CSV, resto copia) y se deja en otra', params: { from: 'carpeta origen', to: 'carpeta destino', pattern: 'opcional, p.ej. *.xlsx' }, run: a => watch.add(a) },
  'fs.watch_list':   { desc: 'Ver las automatizaciones de carpetas', params: {}, run: () => watch.listWatches() },
  'fs.watch_remove': { desc: 'Quitar una automatización', params: { id: 'id' }, run: a => watch.removeWatch(a) },
  'app.create': { desc: 'Crear una app: documento HTML completo y autocontenido que se muestra al instante en el visualizador', params: { name: 'nombre corto', html: 'HTML completo' }, run: a => apps.create(a) },
  'app.open':   { desc: 'Abrir una app ya creada', params: { name: 'nombre' }, run: a => apps.open(a) },
  'app.list':   { desc: 'Listar las apps creadas', params: {}, run: () => apps.listApps() },
  'vault.set':  { desc: 'Guardar un secreto cifrado (requiere vault desbloqueado)', params: { name: 'nombre', secret: 'valor' }, run: a => vault.setSecret(a) },
  'vault.get':  { desc: 'Leer un secreto del vault', params: { name: 'nombre' }, run: a => vault.getSecret(a) },
  'vault.list': { desc: 'Listar los nombres de los secretos', params: {}, run: () => vault.listSecrets() },
  'tasks.add':    { desc: 'Programar una tarea futura (Elffuss se enviará ese prompt)', params: { inMinutes: 'minutos desde ahora', at: 'fecha ISO (alternativa)', prompt: 'qué hacer' }, run: a => tasks.add(a) },
  'tasks.list':   { desc: 'Ver las tareas programadas', params: {}, run: () => tasks.listTasks() },
  'tasks.remove': { desc: 'Borrar una tarea programada', params: { id: 'id de la tarea' }, run: a => tasks.removeTask(a) },
  'web.search': { desc: 'Buscar en internet (texto): devuelve títulos, enlaces y fragmentos', params: { query: 'qué buscar' }, run: (a, ctx) => web.search(a, ctx) },
  'web.images': { desc: 'Buscar imágenes en internet y mostrarlas en una galería', params: { query: 'qué imágenes' }, run: (a, ctx) => imagesGallery(a, ctx) },
  'web.fetch': { desc: 'Visitar una URL concreta y devolver su texto', params: { url: 'https://…' }, run: (a, ctx) => web.fetchUrl(a, ctx) },
  'skill.create': { desc: 'CREAR una skill propia: instrucciones especializadas que seguirás siempre (para automatizar/optimizar lo que el usuario pida)', params: { name: 'nombre corto', description: 'para qué sirve', instructions: 'instrucciones detalladas en markdown' }, run: a => skills.createSkill(a) },
  'skill.install': { desc: 'INSTALAR una skill que ya existe en internet, a partir de su URL (GitHub, skills.sh, ui-skills.com). Si el usuario quiere una skill concreta, esta y no skill.create', params: { url: 'URL de la skill o de su repo', name: 'opcional: cuál, si el repo trae varias' }, run: a => skills.installFromUrl(a) },
  'skill.list':   { desc: 'Ver las skills instaladas', params: {}, run: async () => { const s = skills.installed(); return s.length ? s.map(x => `• ${x.name}: ${x.description || ''}`).join('\n') : t('skNoneTool'); } },
  'skill.get':    { desc: 'Leer el contenido completo de una skill instalada (útil antes de editarla)', params: { name: 'nombre de la skill' }, run: async a => { const s = await skills.get(a.name); return s ? `# ${s.name}\n${s.description || ''}\n\n${s.content || ''}` : t('skNoSuchTool', { name: a.name }); } },
  'skill.edit':   { desc: 'EDITAR una skill ya instalada: cambia sus instrucciones (o añade con append:true). Úsalo para ajustar el guion/argumentos de una skill que ya existe, p. ej. el copiloto de ventas', params: { name: 'nombre de la skill', instructions: 'nuevas instrucciones en markdown', description: 'opcional, nueva descripción', append: 'true para añadir al final en vez de reemplazar' }, run: a => skills.editSkill(a) },
  'memory.save':   { desc: 'Recordar un hecho sobre el usuario PARA SIEMPRE (memoria persistente)', params: { fact: 'el hecho' }, run: a => memory.save(a) },
  'memory.list':   { desc: 'Ver todo lo recordado', params: {}, run: () => memory.listFacts() },
  'memory.forget': { desc: 'Olvidar un hecho por id', params: { id: 'id del hecho' }, run: a => memory.forget(a) },
};

// Cómo llega el valor de un <param> cuando el modelo usa etiquetas.
// ─────────────────────────────────────────────────────────────────────────────
// Por defecto se RECORTA: el modelo escribe el valor en su propia línea y ese
// espacio es formato suyo. Tres excepciones, y las tres venían mal desde
// b7d7db0, cuando el parser recortaba Y pasaba por `JSON.parse` todo valor:
//
//   · EXACTO: el valor ES el contenido. Recortarlo deja un fichero sin su
//     sangría inicial ni su salto final, y a un HTML de `app.create` le quita la
//     primera indentación. El caso que más duele es `vault.set.secret`: un
//     secreto recortado —o parseado, si parece JSON— se corrompe de una forma
//     que el usuario no puede depurar.
//   · NÚMERO: `inMinutes` se usa como número, no como la cadena "30".
//   · BOOLEANO: `append` venía funcionando por ACCIDENTE, porque `JSON.parse`
//     convertía "true"/"false". Sin ese parseo, la cadena "false" sería
//     verdadera y `skill.edit` añadiría en vez de reemplazar. Se convierte
//     explícitamente.
//
// Nada se pasa por `JSON.parse`: un contenido que parezca JSON es texto, y un
// valor entrecomillado conserva sus comillas.
// `tests/funciontags.mjs` comprueba que cada nombre de aquí existe de verdad.
export const PARAM_EXACTO = {
  'fs.write': ['content'],
  'app.create': ['html'],
  'skill.create': ['instructions'],
  'skill.edit': ['instructions'],
  'vault.set': ['secret'],
};
export const PARAM_NUMERO = { 'tasks.add': ['inMinutes'] };
export const PARAM_BOOLEANO = { 'skill.edit': ['append'] };

export function toolHelp() {
  return Object.entries(TOOLS).map(([n, t]) =>
    `- ${n}(${Object.keys(t.params).join(', ')}): ${t.desc}`).join('\n');
}

// web.images → galería HTML mostrada al instante en el visualizador.
async function imagesGallery({ query } = {}, ctx = {}) {
  const res = await web.images({ query }, ctx);
  let data;
  try { data = JSON.parse(res); } catch { return res; } // era «sin imágenes»
  const cards = data.images.map(i =>
    `<a href="${i.url}" target="_blank" rel="noopener"><img src="${i.thumb}" loading="lazy" alt="${(i.title || '').replace(/"/g, '')}"><span>${i.by ? '© ' + i.by : ''}</span></a>`).join('');
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${query}</title><style>
body{margin:0;background:#0d1117;color:#e6edf3;font-family:system-ui;padding:14px}
h2{font-weight:600;margin:4px 0 14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
a{display:block;border-radius:10px;overflow:hidden;background:#161b22;border:1px solid #30363d;position:relative}
img{width:100%;height:140px;object-fit:cover;display:block}
span{position:absolute;bottom:0;left:0;right:0;font-size:.6rem;color:#c9d1d9;background:linear-gradient(transparent,#000a);padding:8px 6px 4px}
</style></head><body><h2>🔎 ${query}</h2><div class="grid">${cards}</div></body></html>`;
  await apps.create({ name: 'imágenes ' + query, html });
  return t('webGallery', { n: data.images.length, q: query });
}

// `ctx` lo pone el agente: la señal de parada de su turno ({ signal }). Las
// herramientas que hablan con la red (web.*) se la pasan a fetch, así que ■ corta
// la descarga en curso; el resto la ignora. Antes ninguna la recibía: el turno
// dejaba de esperar (agent.js, hastaQueParen) pero la descarga seguía por
// detrás hasta el final. (Elffuss Code hace lo mismo con terminal.run.)
export async function runTool(name, args, ctx = {}) {
  const tool = TOOLS[name];
  if (!tool) throw new Error(t('toolUnknown', { name }));
  return tool.run(args || {}, ctx);
}

// Estado real del sistema, inyectado al modelo en cada turno (CONTEXTO AHORA).
// La hora en punto: estable entre turnos, para que el prefijo del prompt se
// pueda reutilizar. Ver el comentario de abajo, donde se usa.
const horaEstable = (loc) => {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  return d.toLocaleString(loc, { dateStyle: 'short', timeStyle: 'short' });
};

export async function snapshot() {
  const [appList, pendingTasks, folderList, facts, watches] = await Promise.all([
    apps.allApps(), tasks.pending(), fs.folders(), memory.recent(8), watch.allWatches(),
  ]);
  const next = pendingTasks.sort((a, b) => a.when - b.when)[0];
  return [
    'Memoria (hechos que recuerdas del usuario): ' +
      (facts.length ? facts.map(f => f.fact).join(' · ') : 'nada aún'),
    // TRUNCADA A LA HORA EN PUNTO, y no es estético: esto llevaba SEGUNDOS y va
    // en la cabeza del prompt de sistema. El motor reutiliza el prefijo solo si
    // los tokens del turno empiezan EXACTAMENTE por los ya ingeridos, así que un
    // reloj con segundos lo hacía diverger en CADA turno — la caché de prefijo
    // existía, estaba encendida y medida (sin ella la espera hasta la primera
    // letra crece ×3,2 del turno 1 al 6; con ella se queda plana) y no saltaba
    // nunca porque este prompt la invalidaba sola. Truncar a la hora la deja
    // estable toda la sesión; cruzar una hora cuesta UN re-prefill, no uno por
    // turno. Los segundos no los usaba nadie: «ayer» se resuelve con el `ts` del
    // turno en que se dijo (annotateDates en acer-core.js), no con este reloj.
    'Fecha y hora: ' + horaEstable('es-ES'),
    'Apps ya creadas: ' + (appList.length ? appList.map(a => a.name).join(', ') : 'ninguna'),
    'App abierta en el visualizador: ' + (apps.currentApp() || 'ninguna'),
    'Carpetas autorizadas: ' + (folderList.length ? folderList.join(', ') : 'ninguna (usa fs.pick_folder)'),
    `Tareas pendientes: ${pendingTasks.length}` +
      (next ? ` (próxima ${new Date(next.when).toLocaleTimeString('es-ES')}: «${next.prompt}»)` : ''),
    'Automatizaciones de carpetas: ' +
      (watches.length ? watches.map(w => `${w.from}→${w.to}`).join(', ') : 'ninguna'),
    'Vault: ' + (vault.isUnlocked() ? 'desbloqueado' : 'bloqueado'),
  ].join('\n');
}
