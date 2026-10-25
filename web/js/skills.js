// Skills de Elffuss Code: instrucciones en markdown (formato SKILL.md de
// agente) que el modelo sigue cuando aplican. Se instalan desde el
// catálogo grande OFICIAL (github.com/anthropics/skills), desde los plugins
// oficiales, o desde CUALQUIER repo público (marketplaces de la comunidad
// tipo OpenClaude/openclaw). Todo transparente: se ve el repo, la lista y el
// SKILL.md que se inyecta. Se guardan en IndexedDB (nada sale del navegador).
import * as db from './db.js';

const KEY = 'skills';          // skills instaladas
const SRC_KEY = 'skills.sources'; // repos personalizados añadidos por el usuario
const MAX_SKILL = 12_000;      // caracteres del cuerpo que se inyectan al modelo

// Textos que ve el usuario (en el chat y en la pestaña Skills). Este módulo lo
// comparten Claw y Code, y cada una tiene su i18n: la app pasa su traductor con
// usarTraductor(t) (t(clave, vars) → texto, o la propia clave si no la tiene).
// Sin traductor, o sin la clave, va en español, como hasta ahora. (El bloque que
// se le da al MODELO en el prompt no pasa por aquí.)
const ES = {
  skLoadFailed: 'No pude leer tus skills guardadas; no instalo para no perderlas. Recarga la página e inténtalo otra vez.',
  skInstalledMsg: '✳ **Skill «{name}» instalada.**', skUseIt: 'Ya la sigo en cada conversación. Para usarla, pídeme por ejemplo:',
  skExampleFallback: 'algo relacionado con «{name}»', skBadRepo: 'Usa owner/repo (o la URL de GitHub)',
  skRateLimited: 'GitHub limitó las peticiones (60/h sin login). Reintenta en unos minutos.',
  skRepoUnreadable: 'No pude leer el repo (¿existe y es público?)', skMdFailed: 'No pude descargar el SKILL.md',
  skMissingNameInstr: 'Faltan name o instructions', skMissingName: 'Falta name',
  skCreated: 'Skill «{name}» creada e instalada. Ya la sigo en cada conversación (mírala en la pestaña Skills).',
  skNoSuch: 'No hay ninguna skill «{name}». Créala primero con skill.create.',
  skUpdated: 'Skill «{name}» actualizada. Ya sigo la nueva versión.',
  skUrlBad: 'Esa URL no es de una skill que sepa leer: dame la de GitHub (el repo o su SKILL.md), skills.sh o ui-skills.com.',
  skUrlChoose: 'El repo {repo} trae varias skills: {lista}. Dime cuál y la instalo (skill.install con url y name).',
  skUrlBuscar: 'no inventes la URL: búscala con web.search y usa una que salga en los resultados.',
};
let traductor = null;
export function usarTraductor(fn) { traductor = typeof fn === 'function' ? fn : null; }
function tx(clave, vars) {
  let s = null;
  try { s = traductor?.(clave, vars); } catch { /* traductor roto: español */ }
  if (typeof s === 'string' && s && s !== clave) return s;
  const base = ES[clave] ?? clave;
  return vars ? base.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '')) : base;
}

export const CATALOG_REPO = 'anthropics/skills';
// `clave`: el texto de la etiqueta en el i18n de la app (ver etiquetaO); `label`
// es el español, el de siempre si la app no tiene esa clave.
export const DEFAULT_SOURCES = [
  { repo: 'KikoCis/elffuss-claw-skills', clave: 'skSrc_elffuss', label: 'Elffuss · Skills que funcionan en Claw (3D·Excel·web·juegos)', official: true },
  { repo: 'bbgnsurftech/claude-skills-collection', clave: 'skSrc_comunidad', label: 'Comunidad · Mega-colección (1000+ skills)', official: true },
  { repo: 'anthropics/skills', clave: 'skSrc_anthropic', label: 'Anthropic · Agent Skills (oficial)', official: true },
  { repo: 'anthropics/claude-plugins-official', clave: 'skSrc_plugins', label: 'Anthropic · Plugins oficiales', official: true },
  { repo: 'earthtojake/text-to-cad', clave: 'skSrc_cad', label: 'Text-to-CAD · CAD/STEP/DXF (Python, solo referencia)', official: true },
  { repo: 'scottstts/Threejs-Awesome-Graphics-Agent-Skills', clave: 'skSrc_threejs', label: '3D en el navegador · Three.js (funciona en Claw)', official: true },
];
// La etiqueta de una fuente de serie en el idioma de la página, si la app la
// tiene (en inglés salían las seis en español); si no, la de siempre.
function etiquetaO(clave, porDefecto) {
  let s = null;
  try { s = clave ? traductor?.(clave) : null; } catch { /* traductor roto */ }
  return typeof s === 'string' && s && s !== clave ? s : porDefecto;
}

let cache = []; // instaladas, en memoria (para que el systemPrompt sea síncrono)

// `loaded` distingue «no hay skills» de «no se pudo leer»: si la lectura
// falla, cache queda vacío pero loaded=false, y install() se niega a persistir
// (antes, un fallo transitorio de IndexedDB borraba TODAS las skills al
// guardar la siguiente).
let loaded = false;
export async function initSkills() {
  try {
    const stored = await db.get('kv', KEY);
    cache = Array.isArray(stored) ? stored : [];
    loaded = true;
  } catch (e) {
    cache = [];
    loaded = false;
    console.warn('[elffuss] no se pudieron leer las skills; no las sobrescribiré', e);
  }
  return cache;
}
export function skillsLoaded() { return loaded; }

export async function all() { return cache; }
export function installed() { return cache; }
export function isInstalled(repo, path) { return cache.some(s => s.repo === repo && s.path === path); }

export async function install(skill) {
  // Si la carga inicial falló, cache no representa lo instalado: reintentar
  // leer antes de escribir. Sin esto, guardar aquí borraría las skills reales.
  if (!loaded) {
    await initSkills();
    if (!loaded) throw new Error(tx('skLoadFailed'));
  }
  cache = cache.filter(s => !(s.repo === skill.repo && s.path === skill.path) && s.name !== skill.name);
  const entry = { ...skill, content: (skill.content || '').slice(0, MAX_SKILL) };
  cache.push(entry);
  await db.set('kv', KEY, cache);
  return entry;                       // devuelve la skill completa (name, description…)
}

// Mensaje «cómo usarla» tras instalar: qué hace + un ejemplo de qué pedir.
export function usageMessage(skill) {
  const desc = (skill.description || '').trim();
  const ejemplo = firstExample(skill) || tx('skExampleFallback', { name: skill.name });
  return tx('skInstalledMsg', { name: skill.name }) + '\n\n' +
    (desc ? desc + '\n\n' : '') +
    tx('skUseIt') + `\n\n> ${ejemplo}`;
}

// Intenta sacar un ejemplo de uso del cuerpo del SKILL.md (líneas de ejemplo/uso).
function firstExample(skill) {
  const body = skill.content || '';
  const m = body.match(/(?:ejemplo|example|uso|usage|prueba|try)[^\n:]*[:：]\s*["“]?([^\n"”]{6,90})/i)
    || body.match(/^[-*]\s+([A-ZÁÉÍÓÚ][^\n]{10,80})/m);
  return m ? m[1].trim().replace(/[.*_`]+$/, '') : null;
}

export async function remove(nameOrPath) {
  cache = cache.filter(s => s.name !== nameOrPath && s.path !== nameOrPath);
  await db.set('kv', KEY, cache);
}

export async function get(name) {
  return cache.find(s => s.name.toLowerCase() === String(name).toLowerCase()) || null;
}

// ---- fuentes (repos) ----
export async function sources() {
  const custom = (await db.get('kv', SRC_KEY).catch(() => null)) || [];
  return [...DEFAULT_SOURCES.map(s => ({ ...s, label: etiquetaO(s.clave, s.label) })), ...custom];
}
export async function addSource(repoOrUrl, label) {
  const repo = repoOrUrl.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(tx('skBadRepo'));
  const custom = (await db.get('kv', SRC_KEY).catch(() => null)) || [];
  if (!custom.some(s => s.repo === repo) && !DEFAULT_SOURCES.some(s => s.repo === repo))
    custom.push({ repo, label: label || repo });
  await db.set('kv', SRC_KEY, custom);
  return repo;
}
export async function removeSource(repo) {
  const custom = (await db.get('kv', SRC_KEY).catch(() => null)) || [];
  await db.set('kv', SRC_KEY, custom.filter(s => s.repo !== repo));
}

// ---- catálogo desde GitHub ----
// Una sola llamada al árbol git del repo → todos los SKILL.md.
export async function listFromRepo(repo) {
  let tree, branch;
  for (const b of ['main', 'master']) {
    const r = await fetch(`https://api.github.com/repos/${repo}/git/trees/${b}?recursive=1`);
    if (r.ok) { tree = await r.json(); branch = b; break; }
    if (r.status === 403) throw new Error(tx('skRateLimited'));
  }
  if (!tree) throw new Error(tx('skRepoUnreadable'));
  return (tree.tree || [])
    .filter(n => /(^|\/)SKILL\.md$/i.test(n.path))
    .map(n => ({ repo, branch, path: n.path, dir: n.path.replace(/\/SKILL\.md$/i, ''), name: n.path.replace(/\/SKILL\.md$/i, '').split('/').pop() || repo }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

// Descarga el SKILL.md y lo instala (frontmatter YAML simple).
export async function installFromRepo(entry) {
  let md = null;
  for (const b of [entry.branch, 'main', 'master'].filter(Boolean)) {
    const r = await fetch(`https://raw.githubusercontent.com/${entry.repo}/${b}/${entry.path}`);
    if (r.ok) { md = await r.text(); break; }
  }
  if (md == null) throw new Error(tx('skMdFailed'));
  const skill = parseSkill(md, entry.name);
  return install({ ...skill, repo: entry.repo, path: entry.path });
}

// Instalar una skill que YA existe, a partir de su URL. Sin esto el modelo solo
// tenía skill.create, y cuando el usuario pedía una skill concreta de internet
// («instala impeccable») escribía de memoria una imitación —lenta, porque redacta
// las instrucciones enteras, y peor que la original— o decía que no podía.
//
// Vale GitHub (el repo, una carpeta, el SKILL.md o su versión raw) y los
// catálogos que enlazan a un repo de GitHub (skills.sh, ui-skills.com).
// Devuelve { repo, branch?, path?, name? } o null si no sabe leerla.
export function resolverUrlSkill(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return null; }
  const p = u.pathname.split('/').filter(Boolean);
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'raw.githubusercontent.com' && p.length >= 4 && /SKILL\.md$/i.test(p.at(-1)))
    return { repo: `${p[0]}/${p[1]}`, branch: p[2], path: p.slice(3).join('/') };
  if (host === 'github.com' && p.length >= 2) {
    const repo = `${p[0]}/${p[1].replace(/\.git$/, '')}`;
    if ((p[2] === 'blob' || p[2] === 'tree') && p.length >= 5) {
      let path = p.slice(4).join('/');
      if (!/SKILL\.md$/i.test(path)) path += '/SKILL.md';
      return { repo, branch: p[3], path };
    }
    return { repo };
  }
  if (host === 'skills.sh' && p.length >= 2) return { repo: `${p[0]}/${p[1]}`, name: p[2] || null };
  if (host === 'ui-skills.com' && p[0] === 'skills' && p.length >= 3) return { repo: `${p[1]}/${p[2]}`, name: p[3] || null };
  return null;
}

export async function installFromUrl({ url, name } = {}) {
  const r = resolverUrlSkill(url);
  if (!r) throw new Error(tx('skUrlBad'));
  let entry;
  if (r.path) {
    entry = { repo: r.repo, branch: r.branch, path: r.path,
      name: r.path.replace(/\/?SKILL\.md$/i, '').split('/').pop() || r.repo.split('/')[1] };
  } else {
    // Un repo que no existe suele ser una URL inventada: el error le dice al
    // modelo qué hacer en vez de dejarle probar otra inventada (E4B lo hacía).
    const lista = await listFromRepo(r.repo).catch(e => {
      throw new Error(`${e.message} — ${tx('skUrlBuscar', { repo: r.repo })}`);
    });
    if (!lista.length) throw new Error(tx('skMdFailed'));
    const quiere = String(name || r.name || r.repo.split('/')[1]).toLowerCase();
    // Un repo suele traer la misma skill copiada para varios agentes
    // (.claude/, .cursor/, .agents/…): cualquiera de ellas vale.
    entry = lista.length === 1 ? lista[0] : lista.find(e => e.name.toLowerCase() === quiere);
    if (!entry) {
      const nombres = [...new Set(lista.map(e => e.name))];
      return tx('skUrlChoose', { repo: r.repo, lista: nombres.slice(0, 30).join(', ') });
    }
  }
  return usageMessage(await installFromRepo(entry));
}

// SKILL.md → { name, description, content }
export function parseSkill(md, fallbackName = 'skill') {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  const meta = fm?.[1] || '';
  const name = meta.match(/^name:\s*(.+)$/m)?.[1]?.trim() || fallbackName;
  const description = (meta.match(/^description:\s*([\s\S]+?)(?:\n\w+:|$)/m)?.[1] || '').replace(/\s+/g, ' ').trim();
  const content = md.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  return { name, description, content };
}

// Creador de skills: Elffuss fabrica una skill propia (SKILL.md) a partir de
// lo que el usuario quiere, y la instala al instante. Aparece en la pestaña
// Skills y se inyecta en el prompt de los siguientes turnos.
export async function createSkill({ name, description, instructions } = {}) {
  if (!name || !instructions) throw new Error(tx('skMissingNameInstr'));
  const skill = {
    name: String(name).slice(0, 48),
    description: (description || '').slice(0, 240),
    content: String(instructions).slice(0, MAX_SKILL),
    repo: 'creada por Elffuss',
    path: 'local/' + Date.now(),
  };
  await install(skill);
  return tx('skCreated', { name: skill.name });
}

// Editar una skill YA instalada: reemplaza sus instrucciones (o las añade con append),
// conservando su origen. Para ajustar el script/argumentos de una skill existente.
export async function editSkill({ name, description, instructions, append } = {}) {
  if (!name) throw new Error(tx('skMissingName'));
  const s = cache.find(x => x.name.toLowerCase() === String(name).toLowerCase());
  if (!s) throw new Error(tx('skNoSuch', { name }));
  let content = s.content || '';
  if (instructions != null) content = append ? (content + '\n' + instructions) : String(instructions);
  const updated = { ...s, description: description != null ? String(description).slice(0, 240) : s.description, content: content.slice(0, MAX_SKILL) };
  await install(updated);
  return tx('skUpdated', { name: s.name });
}

// Bloque para el systemPrompt (síncrono, desde la caché).
export function skillsPromptBlock() {
  if (!cache.length) return '';
  const nombres = cache.map(s => `«${s.name}»`).join(', ');
  const parts = cache.map(s =>
    `### Skill «${s.name}»${s.repo ? ` (de ${s.repo})` : ''}\n${s.description || ''}\n${(s.content || '').slice(0, MAX_SKILL)}`);
  // Framing DIRECTIVO: un modelo pequeño con el framing pasivo de antes negaba
  // tener la skill aunque estuviera inyectada («I don't have that skill»). Aquí
  // se le dice explícitamente que ES una capacidad suya AHORA, que no la niegue,
  // que empareje por tema aunque el usuario use otro nombre, y que si la skill
  // trae una plantilla de app la cree con app.create copiándola.
  return `\n\nSKILLS INSTALADAS — son capacidades que TIENES AHORA MISMO: ${nombres}.\n` +
    `REGLAS con las skills:\n` +
    `- Si la petición encaja con una skill (aunque el usuario la nombre con otras palabras o un nombre parecido, empareja por el TEMA de su descripción), ÚSALA siguiendo sus instrucciones al pie de la letra.\n` +
    `- NUNCA digas que no tienes esa skill o esa capacidad: la tienes, está aquí abajo.\n` +
    `- Si la skill incluye una plantilla de app (HTML), créala con la herramienta app.create COPIANDO esa plantilla y adaptando solo lo que la skill indique — no inventes una app genérica distinta.\n\n` +
    parts.join('\n\n');
}
