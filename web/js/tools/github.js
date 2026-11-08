// GitHub, para que Elffuss se mejore a sí mismo: un fork del chat en la cuenta del usuario, el cambio escrito
// fichero a fichero por la API REST (admite CORS con token: no hace falta git en el navegador), GitHub Pages y la PR.
//
// El fork es siempre de UPSTREAM y se llama siempre FORK_NAME: la skill elffuss-improve no puede escribir en ningún
// otro repo, ni del usuario ni ajeno. El token vive en este navegador (kv 'github.token') y solo viaja a
// api.github.com.
import * as db from '../db.js';

const API = 'https://api.github.com';
export const UPSTREAM = 'utopia-ia/utopia-ia.github.io';
export const FORK_NAME = 'elffuss-chat';
// El relevo del login: cambia el código OAuth por el token y lo devuelve por postMessage a la app que lo abrió.
const AUTH = 'https://auth.elffuss.com';
const KEY = 'github.token';
// El login necesita la GitHub App (instalada solo en el fork) y su relevo: hasta que existan, se dice claro.
const LOGIN_READY = false;

let token = null;
let login = null;

async function getToken() {
  if (token) return token;
  try { token = (await db.get('kv', KEY)) || null; } catch { token = null; }
  return token;
}

async function api(path, { method = 'GET', body, ok = [] } = {}) {
  const tk = await getToken();
  if (!tk) throw new Error('GitHub: no has conectado tu cuenta (github.login)');
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${tk}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { token = null; await db.del('kv', KEY).catch(() => {}); throw new Error('GitHub: la sesión ha caducado; vuelve a conectar tu cuenta'); }
  if (!r.ok && !ok.includes(r.status)) {
    let msg = ''; try { msg = (await r.json()).message || ''; } catch { /* — */ }
    throw new Error(`GitHub ${method} ${path}: ${r.status} ${msg}`.trim());
  }
  if (r.status === 204) return { status: 204 };
  const j = await r.json().catch(() => ({}));
  return Object.assign(j, { status: r.status });
}

const espera = (ms) => new Promise((res) => setTimeout(res, ms));

// UTF-8 ⇄ base64 sin romper tildes ni emojis (btoa solo entiende latin-1).
function aBase64(texto) {
  const b = new TextEncoder().encode(texto);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
function deBase64(b64) {
  const s = atob(b64.replace(/\n/g, ''));
  return new TextDecoder().decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
}

// Una ruta del fork, limpia: relativa, sin «..», sin la carpeta .git ni los ficheros de Actions (un workflow
// escrito por el modelo correría con permisos en la cuenta del usuario).
function ruta(p) {
  const r = String(p || '').replace(/^\/+/, '');
  if (!r || r.split('/').some((x) => x === '..' || x === '.git') || /^\.github\//.test(r)) throw new Error(`ruta no permitida: ${p}`);
  return r;
}

export async function connected() { return !!(await getToken()); }

// Conectar la cuenta. Con `token`, se usa ese (pruebas, o quien prefiera un token personal); sin él, se abre el
// relevo de login y se espera su respuesta, solo de ese origen y solo de esa ventana.
export async function connect({ token: dado } = {}) {
  let tk = dado ? String(dado).trim() : null;
  if (!tk && !LOGIN_READY) throw new Error('Connecting GitHub is not available yet in Elffuss: the look of the chat can still be changed with elffuss.theme_set');
  if (!tk) {
    const w = open(`${AUTH}/github/start?app=${encodeURIComponent(location.origin)}`, 'elffuss-github', 'width=520,height=720');
    if (!w) throw new Error('el navegador ha bloqueado la ventana de GitHub: permite ventanas emergentes y vuelve a probar');
    tk = await new Promise((resolve, reject) => {
      const fin = setTimeout(() => { removeEventListener('message', oye); reject(new Error('GitHub: no se completó el inicio de sesión')); }, 5 * 60_000);
      function oye(e) {
        if (e.origin !== AUTH || e.source !== w || e.data?.type !== 'elffuss-github-token') return;
        clearTimeout(fin); removeEventListener('message', oye);
        e.data.token ? resolve(e.data.token) : reject(new Error('GitHub: ' + (e.data.error || 'inicio de sesión cancelado')));
      }
      addEventListener('message', oye);
    });
  }
  token = tk; login = null;
  const yo = await api('/user');
  await db.set('kv', KEY, tk);
  login = yo.login;
  return `Cuenta de GitHub conectada: ${yo.login}`;
}

export async function disconnect() {
  token = null; login = null;
  await db.del('kv', KEY);
  return 'Cuenta de GitHub desconectada de este navegador';
}

async function me() {
  if (!login) login = (await api('/user')).login;
  return login;
}
const repo = async () => `${await me()}/${FORK_NAME}`;
export async function pagesUrl() { return `https://${(await me()).toLowerCase()}.github.io/${FORK_NAME}/`; }

// El fork del chat: lo crea si no existe y, si existe, lo pone al día con la versión oficial. Comprueba siempre
// que el repo que se va a tocar es de verdad un fork de UPSTREAM.
export async function fork() {
  const r = await repo();
  let info = await api(`/repos/${r}`, { ok: [404] });
  if (info.status === 404) {
    await api(`/repos/${UPSTREAM}/forks`, { method: 'POST', body: { name: FORK_NAME, default_branch_only: true } });
    for (let i = 0; i < 30; i++) {
      await espera(2000);
      info = await api(`/repos/${r}`, { ok: [404] });
      if (info.status !== 404) break;
    }
    if (info.status === 404) throw new Error('GitHub no ha terminado de crear el fork; vuelve a probar en un minuto');
  }
  if (!info.fork || info.parent?.full_name !== UPSTREAM) throw new Error(`${r} existe pero no es un fork de ${UPSTREAM}: renómbralo y vuelve a probar`);
  const sync = await api(`/repos/${r}/merge-upstream`, { method: 'POST', body: { branch: info.default_branch || 'main' }, ok: [409] });
  return sync.status === 409
    ? `Fork ${r} listo, pero tiene cambios que chocan con la versión oficial: no se ha actualizado`
    : `Fork ${r} listo y al día con la versión oficial`;
}

export async function read({ path }) {
  const f = await api(`/repos/${await repo()}/contents/${encodeURI(ruta(path))}`);
  if (Array.isArray(f)) return f.map((x) => `${x.type === 'dir' ? '[dir] ' : ''}${x.path}`).join('\n');
  return deBase64(f.content || '');
}

// Escribe un fichero en el fork: un commit por cambio, con el mensaje que diga la skill.
export async function write({ path, content, message }) {
  const r = await repo();
  const p = ruta(path);
  const prev = await api(`/repos/${r}/contents/${encodeURI(p)}`, { ok: [404] });
  await api(`/repos/${r}/contents/${encodeURI(p)}`, {
    method: 'PUT',
    body: { message: String(message || `Elffuss: update ${p}`).slice(0, 200), content: aBase64(String(content ?? '')), ...(prev.sha ? { sha: prev.sha } : {}) },
  });
  return `Guardado ${p} en ${r}`;
}

// GitHub Pages en el fork, desde la raíz de main, y espera a que la versión nueva esté publicada.
export async function pages() {
  const r = await repo();
  const cur = await api(`/repos/${r}/pages`, { ok: [404] });
  if (cur.status === 404) await api(`/repos/${r}/pages`, { method: 'POST', body: { source: { branch: 'main', path: '/' } }, ok: [409] });
  for (let i = 0; i < 60; i++) {
    const b = await api(`/repos/${r}/pages/builds/latest`, { ok: [404] });
    if (b.status === 'built') return `Publicado en ${await pagesUrl()}`;
    if (b.status === 'errored') throw new Error('GitHub Pages no ha podido publicar el fork: ' + (b.error?.message || ''));
    await espera(5000);
  }
  return `GitHub Pages sigue publicando; estará en ${await pagesUrl()} en unos minutos`;
}

// La propuesta a la versión oficial: una PR desde main del fork.
export async function pr({ title, body }) {
  const pull = await api(`/repos/${UPSTREAM}/pulls`, {
    method: 'POST',
    body: { title: String(title || 'Mejora propuesta desde Elffuss').slice(0, 120), body: String(body || ''), head: `${await me()}:main`, base: 'main' },
  });
  return `Propuesta abierta: ${pull.html_url}`;
}
