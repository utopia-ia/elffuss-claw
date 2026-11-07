// Navegación: fetch directo si el sitio lo permite (CORS); si no, cae al
// proxy del servidor (/proxy?url=…) que sirve server/serve.py o el nginx
// de producción.
//
// Cada herramienta recibe la señal de parada del turno ({ signal }, ver
// tools/index.js): con ■, la descarga en curso se corta en vez de seguir por
// detrás hasta el final.
import { require as requirePerm } from '../permissions.js';
import { t, uiLang } from '../i18n.js';
import { terms, buildBM25 } from '../acer-core.js';
import { createResearch, decodeBody, parseSearx, WORDS, renderSearch, renderPage } from './web-research.js';

const PROXY_MB = 2; // el tope del proxy: MAX_PROXY_BYTES de server/serve.py


const parado = (e, signal) => signal?.aborted || e?.name === 'AbortError';
const hostDe = url => { try { return new URL(url).host; } catch { return url; } };
const motivo = async r => { try { return (await r.text()).replace(/\s+/g, ' ').trim().slice(0, 300); } catch { return ''; } };

// Lee una URL: directa si el sitio permite CORS y, si no, por el proxy del
// servidor. Cuando las dos fallan, el error dice POR QUÉ. En especial si el
// proxy no existe en este servidor (404): antes salía «HTTP 404» a secas, que
// se lee como «esa página no existe», y la búsqueda lo convertía en «Sin
// resultados», como si internet no tuviera nada que decir. Así estuvo
// producción semanas sin que nadie lo notara.
//
// Y sin decir más de lo que se sabe. Si el sitio contestó al fetch directo (con
// CORS el navegador deja ver su estado), lo que importa es lo que dijo: su 404
// es que la página no existe, haya proxy o no. Si el fetch directo falló sin
// respuesta, desde el navegador no se distingue un sitio sin CORS de uno que no
// existe o no resuelve: se dicen las dos cosas y no se afirma que la página
// exista. (Lo mismo que la copia de Elffuss Code.)
//
// El proxy endurecido dice en cabeceras qué ha pasado, y eso es lo que llega al
// agente (antes, un destino prohibido y el 403 de la propia web eran los dos
// «HTTP 403», y un fallo TLS o de DNS, «HTTP 502»):
//  · X-Proxy-Error: <código> → el proxy no la trajo (puerto o destino
//    prohibido, TLS, DNS, plazo, límites…), y el cuerpo es el motivo;
//  · X-Proxy-Upstream-Status → el estado es de la web, que el proxy pasa tal
//    cual: su 404 es que la página no existe, NO que falte el proxy;
//  · X-Proxy-Truncated: 1 → el proxy cortó la página en su tope.
// Sin ninguna de las dos primeras no ha contestado el proxy: un 404/405/501 es
// un servidor sin la ruta /proxy (o el proxy viejo), y lo demás (el 429 del
// límite de nginx, un 502/504 con el backend caído), un fallo sin más detalle.
async function proxyGet(url, { signal } = {}) {
  let directo, estado = 0;
  try {
    const r = await fetch(url, { signal });
    if (r.ok) return { text: await r.text(), status: r.status, truncated: false };
    estado = r.status; directo = new Error('HTTP ' + r.status);
  } catch (e) {
    if (parado(e, signal)) throw e;   // ■: no se prueba el proxy
    directo = e;
  }
  if (estado === 404 || estado === 410) throw new Error(t('webGone', { url, status: estado }));
  let r;
  try { r = await fetch('/proxy?url=' + encodeURIComponent(url), { signal }); }
  catch (e) {
    if (parado(e, signal)) throw e;
    throw new Error(t('webBoth', { host: hostDe(url), direct: directo?.message || t('webNoAnswer'), proxy: e?.message || t('webNoAnswer') }));
  }
  const codigo = r.headers.get('X-Proxy-Error');
  const deLaWeb = Number(r.headers.get('X-Proxy-Upstream-Status')) || 0;
  if (r.ok) return { text: await r.text(), status: deLaWeb || r.status, truncated: r.headers.get('X-Proxy-Truncated') === '1' };
  if (codigo) {
    throw new Error(t('webProxyRefused', { host: hostDe(url), status: r.status, code: codigo, why: (await motivo(r)) || codigo }));
  }
  if (deLaWeb) {
    if (deLaWeb === 404 || deLaWeb === 410) throw new Error(t('webGone', { url, status: deLaWeb }));
    throw new Error(t('webSiteStatus', { host: hostDe(url), status: deLaWeb }));
  }
  if (r.status === 404 || r.status === 405 || r.status === 501) {
    const e = new Error(estado
      ? t('webNoProxyStatus', { host: hostDe(url), status: estado, proxy: r.status })
      : t('webNoProxy', { host: hostDe(url), proxy: r.status }));
    e.sinProxy = true;
    throw e;
  }
  throw new Error(t('webBoth', { host: hostDe(url), direct: directo?.message || t('webNoAnswer'), proxy: 'HTTP ' + r.status }));
}

// ---------------------------------------------------------------- web.fetch y web.search
// Sobre el módulo compartido de Elffuss (web-research.js, copia exacta del de elffuss.com, rama web-avanzada de
// elffuss-home, donde se prueba contra páginas reales guardadas: cambiarlo allí y copiarlo). web.search pregunta
// primero al buscador propio (/websearch, SearXNG en este mismo origen; site: pasa tal cual) y, si falla, responde
// 429 o no encuentra nada, a DuckDuckGo lite por el proxy; lee por su cuenta las dos primeras páginas (las que su
// robots.txt deja) y añade sus párrafos para la pregunta. Una búsqueda site: vacía sigue: las palabras del
// usuario, la búsqueda dentro del sitio, una vez sin site:. web.fetch devuelve los párrafos de la página que
// responden a lo que escribió el usuario; las páginas hechas con JavaScript se leen por sus datos (JSON-LD,
// noscript, feed, AMP, la API pública de Mastodon o Bluesky). La pregunta del usuario no sale: solo ordena aquí.

const TIMEOUT_MS = 25000;
const lengua = () => (uiLang() === 'es' ? 'es' : 'en');
const palabras = () => WORDS[lengua()];

function parseWithBase(html, url) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  if (!doc.querySelector('base[href]') && doc.head) {
    const b = doc.createElement('base');
    b.setAttribute('href', url);
    doc.head.prepend(b);
  }
  return doc;
}

async function conPlazo(signal, fn) {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, TIMEOUT_MS);
  try { return await fn(ctl.signal); } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
}

// Un GET para el módulo de investigación, con las mismas reglas y los mismos mensajes que proxyGet (arriba):
// directo si el sitio deja (CORS), si no por el proxy; el texto en el juego de caracteres de la página. Nunca lanza
// por un estado HTTP: devuelve { ok:false, status, code, message } con el mensaje de siempre, porque el módulo
// necesita ver, por ejemplo, el 404 de un robots.txt (= no hay reglas).
async function respuesta(r, url, viaProxy) {
  const type = r.headers.get('Content-Type') || '';
  const deLaWeb = viaProxy ? Number(r.headers.get('X-Proxy-Upstream-Status')) || 0 : 0;
  return {
    ok: true, status: deLaWeb || r.status, code: '', type,
    url: (viaProxy ? r.headers.get('X-Proxy-Final-Url') : r.url) || url,
    text: decodeBody(await r.arrayBuffer(), type),
    truncated: viaProxy && r.headers.get('X-Proxy-Truncated') === '1',
  };
}
const fallo = (status, code, message) => ({ ok: false, status, code, message, type: '', url: '', text: '', truncated: false });

async function get(url, { signal } = {}) {
  return conPlazo(signal, async (sig) => {
    let directo, estado = 0;
    try {
      const d = await fetch(url, { signal: sig });
      if (d.ok) return respuesta(d, url, false);
      estado = d.status; directo = new Error('HTTP ' + d.status);
    } catch (e) {
      if (parado(e, signal)) throw e;
      directo = e;
    }
    if (estado === 404 || estado === 410) return fallo(estado, '', t('webGone', { url, status: estado }));
    let r;
    try { r = await fetch('/proxy?url=' + encodeURIComponent(url), { signal: sig }); }
    catch (e) {
      if (parado(e, signal)) throw e;
      return fallo(0, 'network', t('webBoth', { host: hostDe(url), direct: directo?.message || t('webNoAnswer'), proxy: e?.message || t('webNoAnswer') }));
    }
    const codigo = r.headers.get('X-Proxy-Error');
    const deLaWeb = Number(r.headers.get('X-Proxy-Upstream-Status')) || 0;
    if (r.ok) return respuesta(r, url, true);
    if (codigo) return fallo(r.status, codigo, t('webProxyRefused', { host: hostDe(url), status: r.status, code: codigo, why: (await motivo(r)) || codigo }));
    if (deLaWeb) return fallo(deLaWeb, '', deLaWeb === 404 || deLaWeb === 410 ? t('webGone', { url, status: deLaWeb }) : t('webSiteStatus', { host: hostDe(url), status: deLaWeb }));
    if (r.status === 404 || r.status === 405 || r.status === 501) {
      return fallo(r.status, 'no-proxy', estado ? t('webNoProxyStatus', { host: hostDe(url), status: estado, proxy: r.status }) : t('webNoProxy', { host: hostDe(url), proxy: r.status }));
    }
    return fallo(r.status, '', t('webBoth', { host: hostDe(url), direct: directo?.message || t('webNoAnswer'), proxy: 'HTTP ' + r.status }));
  });
}

const websearchUrl = (q) => `/websearch?q=${encodeURIComponent(q)}&format=json&language=${lengua()}`;
const searchEngine = {
  url: (q) => new URL(websearchUrl(q), location.origin).href,
  run: (q, { signal } = {}) => conPlazo(signal, async (sig) => {
    const r = await fetch(websearchUrl(q), { signal: sig, headers: { Accept: 'application/json' } });
    if (!r.ok) throw Object.assign(new Error('websearch ' + r.status), { code: r.status === 429 ? 'rate-limited' : 'down' });
    if (!/json/i.test(r.headers.get('Content-Type') || '')) throw Object.assign(new Error('websearch not json'), { code: 'down' });
    return parseSearx(await r.text());
  }),
};

let research = null;
async function lab() {
  if (research) return research;
  const Readability = await import('../../vendor/readability/readability.js').then((m) => m.default, () => null);
  research = createResearch({ get, parseHTML: parseWithBase, terms, buildBM25, Readability, searchEngine });
  return research;
}

const recorta = (text, n) => (text.length > n ? text.slice(0, n) + '\n' + palabras().cut : text);
const sitio = (u) => { try { const x = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u); return x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, ''); } catch { return String(u || '').trim(); } };

export async function fetchUrl({ url } = {}, { signal, question = '' } = {}) {
  if (!/^https?:\/\//.test(url || '')) throw new Error(t('webBadUrl'));
  await requirePerm('web', url);
  const R = await lab();
  const r = await R.fetch(url, { question, signal });
  if (r.error) throw new Error(r.error.message || renderPage(r, palabras(), ''));
  return recorta(renderPage(r, palabras(), question), R.limits.fetchChars + 600) + (r.truncated ? '\n' + t('webProxyCut', { mb: PROXY_MB }) : '');
}

// Un modelo que pide buscar dentro de una web ({ url | site, query }) recibe una búsqueda con site:.
export async function search({ query, url, site } = {}, { signal, question = '' } = {}) {
  let q = String(query || '').trim();
  const donde = String(url || site || '').trim();
  if (donde && !/(^|\s)site:/i.test(q)) q = `site:${sitio(donde)} ${q}`.trim();
  if (!q) throw new Error(t('webNoQuery'));
  await requirePerm('web', t('pdWebSearch', { q }));
  const R = await lab();
  const r = await R.search(q, { question, read: 2, signal });
  if (!r.items.length) {
    // Nadie quiso buscar: si el proxy rechazó la petición a DuckDuckGo, su motivo (límite, ocupado…); si
    // DuckDuckGo pidió la verificación anti-bot, eso. Un «Sin resultados» es solo cuando alguien buscó.
    const rechazo = (r.notes || []).find((n) => n.ddg && n.message);
    if (rechazo) throw new Error(rechazo.message);
    if (r.blocked) throw new Error(t('webSearchBlocked', { q }));
  }
  return recorta(renderSearch(r, palabras()), R.limits.searchChars + 1200);
}

// Búsqueda de IMÁGENES (Openverse, CC) → URLs para montar una galería.
export async function images({ query } = {}, { signal } = {}) {
  if (!query) throw new Error(t('webNoQuery'));
  await requirePerm('web', t('pdWebImages', { q: query }));
  const { text: raw } = await proxyGet('https://api.openverse.org/v1/images/?q=' + encodeURIComponent(query) + '&page_size=12', { signal });
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(t('webImagesBad')); }
  const imgs = (data.results || []).map(r => ({ url: r.url, thumb: r.thumbnail || r.url, title: (r.title || '').slice(0, 60), by: r.creator || '' }))
    .filter(i => i.url);
  if (!imgs.length) return t('webNoImages', { q: query });
  return JSON.stringify({ query, images: imgs });
}
