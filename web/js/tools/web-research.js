// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
// Web research for a SMALL model in the browser: search, read a page, search inside a site, and a short bounded
// crawl, all answering with a few ranked passages and their addresses instead of whole pages. Shared by the chat,
// Claw and Code: this file imports nothing. The app hands it what differs (createResearch below):
//
//   get(url, { signal })   one GET through the app's proxy → { ok, status, type, url (final), text, truncated }
//                          (decodeBody turns the proxy's bytes into text with the page's own charset)
//   parseHTML(html, url)   a Document whose relative links resolve against `url` (the browser's DOMParser plus a
//                          <base>, see parseWithBase)
//   terms, buildBM25       acer-core.js's tokenizer and BM25: the same retrieval the memory and the history use
//   Readability            optional: vendor/readability.js (Mozilla, Apache-2.0); without it a simpler extractor runs
//
// What it never does: send a cookie, a header of the user or a form by POST; log in; run a page's JavaScript; follow
// a link to another site during a crawl; read what robots.txt closes to it when IT chose the address (crawl, site
// search, the pages a search reads by itself). An address the user or the model gave to web.fetch is read like a
// browser reads it, without asking robots.txt. Every address that leaves the device is in `sent`, for the card.

export const LIMITS = {
  requests: 8,        // proxy requests per tool call, robots.txt included (the proxy allows 30 a minute per visitor)
  crawlPages: 4,      // pages a crawl reads, the first one included
  crawlDepth: 2,      // links followed from the first page
  sitemaps: 3,        // sitemap files read (an index counts)
  readTop: 2,         // result pages a search or a site search reads by itself
  fetchChars: 3600,   // what web.fetch hands the model (~900 tokens)
  searchChars: 2600,  // web.search with its read pages
  siteChars: 3000,    // web.site
  perPage: 900,       // passages of each page a search read by itself
  chunk: 700,         // target size of a passage
  thinBelow: 400,     // characters of content under which a page counts as a shell and its data is read instead
};
export const AGENT = 'elffuss';   // the robots.txt product token; the proxy's User-Agent is «Mozilla/5.0 (Elffuss)»

// ---------------------------------------------------------------- bytes and text

// The charset: the Content-Type's, else the page's own <meta charset> / http-equiv / <?xml encoding?>, else UTF-8.
// response.text() would always read UTF-8, and a Latin-1 page (AEMET serves ISO-8859-15) came out full of �.
export function charsetOf(type, head = '') {
  const m = /charset\s*=\s*["']?([\w.:-]+)/i.exec(type || '')
    || /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)
    || /<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)/i.exec(head);
  return m ? m[1].toLowerCase() : 'utf-8';
}

export function decodeBody(bytes, type) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const head = new TextDecoder('latin1').decode(u8.subarray(0, 4096));
  let cs = charsetOf(type, head);
  try { return new TextDecoder(cs).decode(u8); } catch { cs = 'utf-8'; }
  return new TextDecoder('utf-8').decode(u8);
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decodeEntities = (s) => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : all; }
  return ENT[e.toLowerCase()] ?? all;
});

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const TEXTUAL = /^(text\/|application\/(xhtml\+xml|xml|json|[\w.+-]*\+(xml|json)|x-suggestions\+json|opensearchdescription\+xml|javascript)|$)/i;
export const isTextual = (type) => TEXTUAL.test(String(type || '').split(';')[0].trim());
const ASSET = /\.(jpe?g|png|gif|svg|webp|avif|ico|css|js|mjs|zip|gz|tgz|rar|7z|mp[34]|m4a|webm|mov|avi|woff2?|ttf|exe|dmg|apk|iso)(\?|#|$)/i;

// ---------------------------------------------------------------- robots.txt (RFC 9309)

export function parseRobots(text) {
  const groups = [], sitemaps = [];
  let cur = null, agentLine = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !agentLine) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      agentLine = true;
      continue;
    }
    agentLine = false;
    if (key === 'sitemap') { if (/^https?:\/\//i.test(val)) sitemaps.push(val); continue; }
    if (cur && (key === 'allow' || key === 'disallow') && val) cur.rules.push({ allow: key === 'allow', path: val });
  }
  return { groups, sitemaps };
}

const ruleRe = (p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\$$/, '$').replace(/\*/g, '.*'));
// The groups that name this agent, else every «*» group (groups for the same agent are merged, §2.2.1); the longest
// matching rule wins and, at the same length, Allow wins. No rules or no robots.txt: allowed.
export function robotsAllows(robots, url, agent = AGENT) {
  if (!robots) return true;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.pathname === '/robots.txt') return true;
  const path = u.pathname + u.search;
  const a = agent.toLowerCase();
  let gs = robots.groups.filter((g) => g.agents.includes(a));
  if (!gs.length) gs = robots.groups.filter((g) => g.agents.includes('*'));
  let best = null;
  for (const r of gs.flatMap((g) => g.rules)) {
    let re;
    try { re = ruleRe(r.path); } catch { continue; }
    if (!re.test(path)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}

// ---------------------------------------------------------------- sitemaps, OpenSearch, suggestions

export function parseSitemap(xml) {
  const text = String(xml || '');
  const index = /<sitemapindex[\s>]/i.test(text);
  const locs = [];
  for (const m of text.matchAll(/<(url|sitemap)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const loc = /<loc>\s*(?:<!\[CDATA\[)?\s*([\s\S]*?)\s*(?:\]\]>)?\s*<\/loc>/i.exec(m[2]);
    if (!loc) continue;
    const lastmod = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i.exec(m[2])?.[1] || '';
    locs.push({ loc: decodeEntities(loc[1]).trim(), lastmod });
  }
  if (!locs.length && !/<\w/.test(text)) {   // a plain-text sitemap: one address per line
    for (const l of text.split(/\r?\n/)) if (/^https?:\/\//.test(l.trim())) locs.push({ loc: l.trim(), lastmod: '' });
  }
  return { index, locs };
}

// → { html, suggest }: the GET templates of an OpenSearch description (the one the browser's search box uses).
export function parseOpenSearch(xml) {
  const out = { html: null, suggest: null, name: '' };
  const text = String(xml || '');
  out.name = squash(decodeEntities(/<ShortName>([\s\S]*?)<\/ShortName>/i.exec(text)?.[1] || ''));
  for (const m of text.matchAll(/<Url\b([^>]*)\/?>/gi)) {
    const attr = (n) => decodeEntities(new RegExp('\\b' + n + '\\s*=\\s*"([^"]*)"', 'i').exec(m[1])?.[1] ?? new RegExp('\\b' + n + "\\s*=\\s*'([^']*)'", 'i').exec(m[1])?.[1] ?? '');
    const type = attr('type').toLowerCase(), method = (attr('method') || 'get').toLowerCase(), tpl = attr('template');
    if (!tpl || method !== 'get' || attr('rel') === 'self') continue;
    if (type === 'text/html' && !out.html) out.html = tpl;
    if (type === 'application/x-suggestions+json' && !out.suggest) out.suggest = tpl;
  }
  return out;
}

// {searchTerms} gets the words; the optional parameters ({count?} …) are dropped; a required one we do not know
// makes the template unusable (null).
export function fillTemplate(tpl, query, base) {
  let s = String(tpl || '').replace(/\{searchTerms\}/g, encodeURIComponent(query))
    .replace(/\{(?:inputEncoding|outputEncoding)\??\}/g, 'UTF-8')
    .replace(/\{[\w:]+\?\}/g, '');
  if (/\{[\w:]+\}/.test(s)) return null;
  try { return new URL(s, base).href; } catch { return null; }
}

// The OpenSearch suggestions answer: [query, [titles], [descriptions], [urls]]. Without urls it says nothing usable.
export function parseSuggestions(json) {
  let a = json;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return []; } }
  if (!Array.isArray(a) || !Array.isArray(a[1])) return [];
  const urls = Array.isArray(a[3]) ? a[3] : [];
  return a[1].map((t, i) => ({ title: squash(t), url: urls[i] || '', snippet: squash(Array.isArray(a[2]) ? a[2][i] : '') }))
    .filter((x) => x.title && /^https?:\/\//.test(x.url));
}

// WordPress's REST search (/wp-json/wp/v2/search): [{ title, url, subtype }].
export function parseWpSearch(json) {
  let a = json;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return []; } }
  if (!Array.isArray(a)) return [];
  return a.map((x) => ({ title: squash(decodeEntities(typeof x?.title === 'string' ? x.title : x?.title?.rendered || '')), url: String(x?.url || ''), snippet: '' }))
    .filter((x) => x.title && /^https?:\/\//.test(x.url));
}

// ---------------------------------------------------------------- Elffuss's own search (SearXNG)
// /websearch on each Elffuss origin is a SearXNG that asks several engines: { results: [{ url, title, content,
// engines }], answers, unresponsive_engines }. The app does the request (same origin, no proxy); this reads it.
export function parseSearx(json) {
  let d = json;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return { items: [], answers: [], unresponsive: [] }; } }
  const seen = new Set();
  const items = [];
  for (const r of Array.isArray(d?.results) ? d.results : []) {
    const url = String(r?.url || '');
    if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    items.push({ title: squash(r.title) || url, url, snippet: squash(r.content).slice(0, 220), engines: Array.isArray(r.engines) ? r.engines : [] });
  }
  const answers = (Array.isArray(d?.answers) ? d.answers : []).map((a) => squash(typeof a === 'string' ? a : a?.answer || '')).filter(Boolean).slice(0, 2);
  const unresponsive = (Array.isArray(d?.unresponsive_engines) ? d.unresponsive_engines : []).map((x) => (Array.isArray(x) ? x[0] : String(x)));
  return { items, answers, unresponsive };
}

// ---------------------------------------------------------------- DuckDuckGo (html and lite)

export const DDG = ['https://html.duckduckgo.com/html/?q=', 'https://lite.duckduckgo.com/lite/?q='];
const DDG_BLOCKED = /anomaly|unusual traffic|are you a human|bots use duckduckgo/i;

export function parseDuckDuckGo(html, parseHTML, status = 200) {
  if (!String(html).includes('uddg=')) return { blocked: status === 202 || DDG_BLOCKED.test(html), items: [] };
  const doc = parseHTML(html, DDG[0]);
  const seen = new Set(), items = [];
  for (const a of doc.querySelectorAll('a[href*="uddg="]')) {
    const m = a.getAttribute('href').match(/uddg=([^&]+)/);
    if (!m) continue;
    let url;
    try { url = decodeURIComponent(m[1]); } catch { continue; }
    const title = squash(a.textContent);
    if (!title || title.length < 3 || seen.has(url) || !/^https?:/.test(url)) continue;
    seen.add(url);
    const row = a.closest('tr');
    const block = a.closest('.result, .web-result, article') || a.closest('div') || a.parentElement;
    const snipEl = block?.querySelector?.('.result__snippet') || row?.nextElementSibling || block;
    const snippet = squash((snipEl?.textContent || '').replace(title, '')).slice(0, 220);
    items.push({ title, url, snippet });
  }
  return { blocked: false, items };
}

// ---------------------------------------------------------------- reading a page

const CHROME_SEL = 'nav, header, footer, aside, form, dialog, [role="navigation"], [role="banner"], [role="contentinfo"], [role="search"], [aria-hidden="true"], [hidden], .menu, .nav, .navbar, .sidebar, .breadcrumb, .breadcrumbs, .cookie, .cookies, #cookies, .skip-link, .mw-jump-link, .noprint, .mw-editsection, .reference, .reflist, .navbox, .metadata, :not(html):not(body):is([id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i])';
// Reference lists, tables of contents and boxes of links: never the answer, and they fill the budget (Wikipedia).
const REFS_SEL = '#toc, .toc, .vector-toc, .mw-references-wrap, ol.references, .references, .reflist, .catlinks, .printfooter, .mw-authority-control, .sistersitebox, .hatnote, .navbox, .mw-editsection, .mw-cite-backlink';
const JUNK_SEL = 'script, style, noscript, template, svg, canvas, iframe, object, embed, button, input, select, textarea, link, meta';
const BLOCK_SEL = 'p, h1, h2, h3, h4, h5, h6, ul, ol, li, pre, table, blockquote, dl, dt, dd, figcaption, section, article, div, header, footer, details, summary';
// Sections that are lists of sources or links, in the languages the products speak; and cookie banners.
const SKIP_SECTION = /^(referencias|notas|bibliograf[ií]a|enlaces externos|v[ée]ase tambi[ée]n|fuentes|references|notes|bibliography|external links|see also|further reading|sources|citations|notes and references)$/i;
const COOKIE = /\bcookies?\b[\s\S]*\b(utiliza|usamos|usa|acept|consent|polític|we use|uses|accept|policy)/i;
const CITE = /\[(?:\d+|[a-z]|nota \d+|cita requerida|citation needed|editar|edit|editar código)\]/gi;

// The page as structured text: title, language, description, the main content as passages under their headings,
// every link (marked `chrome` when it sits in a menu, header or footer), and what the page says about searching it.
export function extractPage(html, url, { parseHTML, Readability = null, thinBelow = LIMITS.thinBelow } = {}) {
  const doc = parseHTML(html, url);
  // The page's own <base href>, when it has one, is what its relative links mean.
  const base = (() => { try { return new URL(doc.querySelector('base[href]')?.getAttribute('href') || url, url).href; } catch { return url; } })();
  const abs = (h) => { try { return new URL(h, base).href; } catch { return ''; } };
  const meta = (sel) => squash(doc.querySelector(sel)?.getAttribute('content') || '');
  const page = {
    url,
    title: squash(doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || doc.title || ''),
    lang: (doc.documentElement?.getAttribute('lang') || '').toLowerCase(),
    description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
    site: meta('meta[property="og:site_name"]'),
    published: meta('meta[property="article:published_time"]') || (doc.querySelector('time[datetime]')?.getAttribute('datetime') || ''),
    canonical: abs(doc.querySelector('link[rel="canonical"]')?.getAttribute('href') || ''),
    hints: { opensearch: '', wpApi: '', forms: [], amp: '', feeds: [] },
    links: [], chunks: [], textLength: 0, jsOnly: false, via: 'basic',
  };
  const os = doc.querySelector('link[rel~="search"][type="application/opensearchdescription+xml"]');
  if (os) page.hints.opensearch = abs(os.getAttribute('href'));
  const amp = doc.querySelector('link[rel~="amphtml" i]');
  if (amp) page.hints.amp = abs(amp.getAttribute('href') || '');
  page.hints.feeds = [...doc.querySelectorAll('link[rel~="alternate"][type="application/rss+xml"], link[rel~="alternate"][type="application/atom+xml"], link[rel~="alternate"][type="application/feed+json"]')]
    .map((l) => abs(l.getAttribute('href') || '')).filter((u) => /^https?:/.test(u)).slice(0, 3);
  const wp = doc.querySelector('link[rel="https://api.w.org/"]');
  if (wp) page.hints.wpApi = abs(wp.getAttribute('href'));
  page.hints.forms = findSearchForms(doc, base);
  const seen = new Set();
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = abs(a.getAttribute('href'));
    if (!/^https?:/.test(href)) continue;
    const key = href.replace(/#.*$/, '');
    const text = squash(a.textContent || a.getAttribute('title') || a.getAttribute('aria-label') || '');
    if (!text || seen.has(key + '\n' + text)) continue;
    seen.add(key + '\n' + text);
    const heading = !!a.closest('h1, h2, h3, h4, h5, h6');
    page.links.push({ url: key, text: text.slice(0, 160), chrome: !!a.closest(CHROME_SEL), heading });
  }

  // The visible text without scripts: almost nothing while the page has scripts is a page built by JavaScript.
  const bodyText = squash((() => {
    const b = doc.body?.cloneNode(true);
    if (!b) return '';
    b.querySelectorAll(JUNK_SEL).forEach((n) => n.remove());
    return b.textContent || '';
  })());
  page.jsOnly = bodyText.length < 200 && doc.querySelectorAll('script').length > 0;

  // Two extractors, and the one that kept more of the page wins. The page's own <main>/<article> (what it declares
  // as its content, minus menus, references and boxes) keeps every heading; Readability (Mozilla) is better where
  // there is no such container or it is full of rails and comments. Readability alone dropped most section headings
  // of a Wikipedia article (10 of 51 survived), so it is used only when it keeps at least 60 % of the container's
  // text and half of its headings.
  let root = null;
  const b = doc.body?.cloneNode(true);
  let semantic = null;
  if (b) {
    b.querySelectorAll(JUNK_SEL + ', ' + CHROME_SEL + ', ' + REFS_SEL).forEach((n) => n.remove());
    semantic = [...b.querySelectorAll('main, article, [role="main"]')].sort((x, y) => (y.textContent || '').length - (x.textContent || '').length)[0] || null;
  }
  const semLen = semantic ? squash(semantic.textContent).length : 0;
  const semHeads = semantic ? semantic.querySelectorAll('h2, h3, h4, h5, h6').length : 0;
  if (Readability) {
    try {
      const art = new Readability(doc.cloneNode(true), { charThreshold: 250, keepClasses: false }).parse();
      const artLen = art ? squash(art.textContent).length : 0;
      if (art && artLen >= 250) {
        const r = parseHTML(`<body>${art.content}</body>`, url).body;
        if (semLen < 500 || (artLen >= semLen * 0.6 && r.querySelectorAll('h2, h3, h4, h5, h6').length >= semHeads * 0.5)) {
          root = r;
          page.via = 'readability';
        }
        if (art.title && !page.title) page.title = squash(art.title);
        if (art.excerpt && !page.description) page.description = squash(art.excerpt);
      }
    } catch { /* the page's own container below */ }
  }
  if (!root && b) {
    if (semLen >= 200) { root = semantic; page.via = 'main'; }
    else {
      const cands = [...b.querySelectorAll('#content, #main, .content, .post, .entry-content')];
      root = cands.sort((x, y) => (y.textContent || '').length - (x.textContent || '').length)[0] || b;
    }
  }
  page.chunks = root ? toChunks(root) : [];
  page.textLength = page.chunks.reduce((n, c) => n + c.text.length, 0);

  // What the page says about itself in data, read here without running anything. The facts of a product, a book,
  // a recipe, an event, a place, a profile or a post (price, dates, ingredients, address…) go first always: the
  // extraction rarely keeps them. When the page has little text (built by JavaScript, or a shell), the rest comes
  // in too, in this order: the article bodies of its JSON-LD, its embedded state (__NEXT_DATA__, __NUXT_DATA__,
  // window.__X__ = {…}), its <noscript>, and its og/twitter description.
  const ld = jsonLdObjects(doc);
  page.ld = ld.map((o) => typeName(o)).filter(Boolean);
  const facts = ldChunks(ld, { bodies: false });
  page.thin = page.textLength < thinBelow;
  page.fallbacks = [];
  let extra = [];
  if (page.thin) {
    const add = (name, list) => { if (list.length) { page.fallbacks.push(name); extra.push(...list); } };
    add('json-ld', ldChunks(ld, { bodies: true, factsToo: false }));
    add('noscript', noscriptChunks(doc));
    // The embedded state is the noisiest source (an app's whole configuration rides along: feature flags, A/B
    // test names): only when the page had almost nothing better.
    const better = facts.concat(extra).reduce((n, c) => n + c.text.length, 0);
    if (better < 150) add('state', stateChunks(embeddedState(doc)));
    const m = metaChunk(page);
    const known = (t) => { const k = squash(t).slice(0, 60); return k && facts.concat(extra).some((c) => squash(c.text).includes(k)); };
    if (m && !known(page.description || m.text)) add('meta', [m]);
  }
  page.ownText = page.textLength + extra.filter((c) => c.kind !== 'state').reduce((n, c) => n + c.text.length, 0);
  if (facts.length || extra.length) {
    const seen = new Set(page.chunks.map((c) => c.text.slice(0, 80)));
    const fresh = (c) => { const k = c.text.slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; };
    page.chunks = [...facts.filter(fresh), ...page.chunks, ...extra.filter(fresh)].map((c, i) => ({ ...c, i }));
    if (facts.length) page.fallbacks.unshift('facts');
    page.textLength = page.chunks.reduce((n, c) => n + c.text.length, 0);
  }
  return page;
}

// Blocks in reading order, each with the path of headings above it, merged into passages of about LIMITS.chunk
// characters that never cross a heading. Lists keep their dashes, tables become «a | b | c» rows, code keeps its lines.
export function toChunks(root, size = LIMITS.chunk) {
  const blocks = [];
  const path = [];
  const clean = (s) => squash(String(s || '').replace(CITE, ''));
  const emit = (kind, text) => {
    if (path.some((x) => SKIP_SECTION.test(x.text))) return;
    if (kind !== 'code' && (/^\s*[↑^]/.test(text) || (/\bcookies?\b/i.test(text) && (String(text).length < 100 || (COOKIE.test(text) && String(text).length < 600))))) return;
    text = kind === 'code' ? String(text || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1200) : clean(text);
    if (text.length < 2) return;
    blocks.push({ h: path.map((x) => x.text).join(' > '), kind, text });
  };
  const walk = (node) => {
    for (const el of node.children) {
      const tag = el.tagName.toLowerCase();
      if (el.matches(JUNK_SEL) || el.matches('.mw-editsection, .reference, sup.reference, .navbox, .noprint, [aria-hidden="true"], [hidden]')) continue;
      const hm = /^h([1-6])$/.exec(tag);
      if (hm) {
        const level = Number(hm[1]);
        while (path.length && path[path.length - 1].level >= level) path.pop();
        const t = clean(el.textContent);
        if (t) path.push({ level, text: t.slice(0, 80) });
        continue;
      }
      if (tag === 'pre') { emit('code', el.textContent); continue; }
      if (tag === 'table') {
        const rows = [...el.querySelectorAll('tr')].slice(0, 30).map((tr) => [...tr.children].map((td) => clean(td.textContent)).filter(Boolean).join(' | ')).filter(Boolean);
        if (rows.length) emit('table', rows.join(' ; '));
        continue;
      }
      if (tag === 'li' && !el.querySelector(BLOCK_SEL)) { emit('li', '- ' + el.textContent); continue; }
      if (['p', 'blockquote', 'dd', 'dt', 'figcaption', 'summary', 'address'].includes(tag) && !el.querySelector('p, ul, ol, table, pre, h1, h2, h3, h4, h5, h6')) { emit('p', el.textContent); continue; }
      if (!el.querySelector(BLOCK_SEL)) { if (clean(el.textContent).length > 1) emit('p', el.textContent); continue; }
      walk(el);
    }
  };
  walk(root);
  // Merge consecutive blocks under the same heading; split a long one at sentence ends.
  const chunks = [];
  let cur = null;
  const flush = () => { if (cur && cur.text) chunks.push(cur); cur = null; };
  for (const b of blocks) {
    const pieces = b.text.length > size * 1.3 && b.kind !== 'code' ? splitSentences(b.text, size) : [b.text];
    for (const t of pieces) {
      if (cur && cur.h === b.h && cur.text.length + t.length + 1 <= size) { cur.text += (b.kind === 'li' || b.kind === 'code' ? '\n' : ' ') + t; continue; }
      flush();
      cur = { h: b.h, text: t };
    }
  }
  flush();
  return chunks.map((c, i) => ({ ...c, i }));
}

function splitSentences(text, size) {
  const out = [];
  let cur = '';
  for (const s of text.split(/(?<=[.!?…])\s+/)) {
    if (cur && cur.length + s.length + 1 > size) { out.push(cur); cur = ''; }
    cur = cur ? cur + ' ' + s : s;
    while (cur.length > size * 1.5) { out.push(cur.slice(0, size)); cur = cur.slice(size); }
  }
  if (cur) out.push(cur);
  return out;
}

// ---------------------------------------------------------------- data a page carries besides its text

// Markup to text; feeds often carry it entity-encoded (&lt;p&gt;), so that is decoded first.
const stripTags = (s) => {
  let x = String(s ?? '');
  if (/&lt;\/?[a-z]/i.test(x)) x = decodeEntities(x);
  return squash(decodeEntities(x.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, ' ').replace(/<[^>]+>/g, ' ')));
};
// Keys in any case: «articlebody» and «articleBody» are both out there.
const pick = (o, ...keys) => {
  if (!o || typeof o !== 'object') return undefined;
  for (const k of keys) { if (o[k] != null) return o[k]; const f = Object.keys(o).find((x) => x.toLowerCase() === k.toLowerCase()); if (f && o[f] != null) return o[f]; }
  return undefined;
};
const typeName = (o) => { const t = pick(o, '@type'); return String(Array.isArray(t) ? t[0] : t || ''); };
const nameOf = (x) => (typeof x === 'string' ? x : Array.isArray(x) ? x.map(nameOf).filter(Boolean).join(', ') : x && typeof x === 'object' ? String(pick(x, 'name') || '') : '');
const textOf = (x) => (typeof x === 'string' ? stripTags(x) : '');

// Every JSON-LD object of the page, @graph and lists flattened, each at most once.
export function jsonLdObjects(doc) {
  const out = [];
  const visit = (x, depth = 0) => {
    if (!x || typeof x !== 'object' || depth > 4 || out.length > 40) return;
    if (Array.isArray(x)) { x.forEach((y) => visit(y, depth + 1)); return; }
    if (pick(x, '@graph')) { visit(pick(x, '@graph'), depth + 1); if (!pick(x, '@type')) return; }
    if (pick(x, '@type')) out.push(x);
  };
  for (const sc of doc.querySelectorAll('script[type="application/ld+json" i]')) {
    try { visit(JSON.parse(sc.textContent.trim().replace(/^<!--|-->$/g, ''))); } catch { /* broken JSON-LD is common: skip */ }
  }
  return out;
}

const FACT_TYPES = /^(Product|Book|Offer|Recipe|\w*Event|LocalBusiness|Restaurant|Store|Hotel|Organization|Person|ProfilePage|SocialMediaPosting|DiscussionForumPosting|FAQPage|Movie|TVSeries|SoftwareApplication|Course|JobPosting)$/;
const ARTICLE_TYPES = /^(Article|NewsArticle|BlogPosting|Report|ScholarlyArticle|TechArticle|AnalysisNewsArticle|ReportageNewsArticle|LiveBlogPosting)$/;

// JSON-LD as passages: one for the facts of each object worth it; with `bodies`, the text of articles and posts
// too, cut into passages under their headline.
export function ldChunks(objs, { bodies = false, factsToo = true } = {}) {
  const out = [];
  const offers = (o) => [].concat(pick(o, 'offers') || []).map((f) => {
    const price = pick(f, 'price') ?? pick(f, 'lowPrice');
    const cur = pick(f, 'priceCurrency') || '';
    const av = String(pick(f, 'availability') || '').replace(/^https?:\/\/schema\.org\//, '');
    return [price != null && price !== '' ? `${price} ${cur}`.trim() : '', av].filter(Boolean).join(', ');
  }).filter(Boolean).slice(0, 3).join(' / ');
  const place = (l) => [].concat(l || []).map((x) => (typeof x === 'string' ? x : [nameOf(x), addr(pick(x, 'address'))].filter(Boolean).join(', '))).filter(Boolean).join(' / ');
  const addr = (a) => (typeof a === 'string' ? a : a && typeof a === 'object' ? ['streetAddress', 'postalCode', 'addressLocality', 'addressRegion', 'addressCountry'].map((k) => nameOf(pick(a, k)) || pick(a, k)).filter((x) => typeof x === 'string' && x).join(', ') : '');
  const steps = (x) => [].concat(x || []).flatMap((s) => (typeof s === 'string' ? [stripTags(s)] : pick(s, 'itemListElement') ? steps(pick(s, 'itemListElement')) : [stripTags(pick(s, 'text') || pick(s, 'name') || '')])).filter(Boolean);
  const stat = (o) => [].concat(pick(o, 'interactionStatistic') || []).map((s) => `${String(pick(s, 'interactionType') || '').replace(/^.*\//, '')}: ${pick(s, 'userInteractionCount')}`).filter((x) => !/: undefined$/.test(x)).join(', ');
  for (const o of objs) {
    const t = typeName(o);
    const lines = [];
    const L = (label, v) => { const x = typeof v === 'string' ? squash(v) : v; if (x != null && x !== '' && !(Array.isArray(x) && !x.length)) lines.push(`${label}: ${Array.isArray(x) ? x.join('; ') : x}`); };
    if (FACT_TYPES.test(t) && factsToo) {
      const main = t === 'ProfilePage' ? pick(o, 'mainEntity') || o : o;
      L('name', nameOf(pick(main, 'name')) || textOf(pick(o, 'headline')));
      if (main !== o) L('handle', pick(main, 'alternateName'));
      L('author', nameOf(pick(o, 'author')));
      L('brand', nameOf(pick(o, 'brand')));
      // A book's edition (isbn, price, pages) often sits in its workExample, not in the Book.
      const ed = [].concat(pick(o, 'workExample') || [])[0] || {};
      L('isbn', pick(o, 'isbn') || pick(ed, 'isbn'));
      L('publisher', nameOf(pick(o, 'publisher')));
      L('pages', pick(o, 'numberOfPages') || pick(ed, 'numberOfPages'));
      L('price', offers(o) || offers(ed));
      const rating = pick(o, 'aggregateRating');
      if (rating) L('rating', `${pick(rating, 'ratingValue')}/${pick(rating, 'bestRating') || 5} (${pick(rating, 'reviewCount') || pick(rating, 'ratingCount') || '?'})`);
      L('start', pick(o, 'startDate')); L('end', pick(o, 'endDate'));
      L('status', String(pick(o, 'eventStatus') || '').replace(/^https?:\/\/schema\.org\//, ''));
      L('place', place(pick(o, 'location')));
      L('address', addr(pick(o, 'address')));
      L('phone', pick(o, 'telephone'));
      L('hours', [].concat(pick(o, 'openingHours') || []).join(', '));
      L('published', pick(o, 'datePublished'));
      L('time', pick(o, 'totalTime')); L('serves', pick(o, 'recipeYield'));
      L('ingredients', [].concat(pick(o, 'recipeIngredient') || []).map(stripTags).slice(0, 30));
      L('steps', steps(pick(o, 'recipeInstructions')).slice(0, 15));
      L('stats', stat(main));
      if (t === 'FAQPage') for (const q of [].concat(pick(o, 'mainEntity') || []).slice(0, 8)) L(textOf(pick(q, 'name')), textOf(pick(pick(q, 'acceptedAnswer'), 'text')));
      L('text', textOf(pick(o, 'text')).slice(0, 600));
      L('description', textOf(pick(main, 'description')).slice(0, 400));
      if (lines.length > 1) out.push({ h: t, text: lines.join('\n').slice(0, 1400), kind: 'facts' });
    }
    if (bodies && (ARTICLE_TYPES.test(t) || /Posting$/.test(t))) {
      const head = textOf(pick(o, 'headline') || pick(o, 'name'));
      const body = textOf(pick(o, 'articleBody') || pick(o, 'text') || pick(o, 'description'));
      for (const piece of body.length > LIMITS.chunk * 1.3 ? splitSentences(body, LIMITS.chunk) : body ? [body] : []) out.push({ h: head.slice(0, 80), text: piece, kind: 'ld-body' });
    }
  }
  return out;
}

// The state a JavaScript page ships to rebuild itself: __NEXT_DATA__, __NUXT_DATA__, any application/json script,
// and window.__X__ = {…} when it is plain JSON. Only its prose survives: strings with spaces, mostly letters, not
// addresses or code; titles (title, name, headline) from 12 characters. At most 60 strings, 6,000 characters.
export function embeddedState(doc) {
  const roots = [];
  for (const sc of doc.querySelectorAll('script')) {
    const type = (sc.getAttribute('type') || '').toLowerCase();
    const txt = sc.textContent || '';
    if (type === 'application/ld+json' || txt.length < 40) continue;
    if (type === 'application/json' || sc.id === '__NEXT_DATA__' || sc.id === '__NUXT_DATA__') {
      try { const j = JSON.parse(txt); roots.push(sc.id === '__NEXT_DATA__' ? (j?.props?.pageProps ?? j) : j); } catch { /* not JSON */ }
      continue;
    }
    const m = /^\s*(?:window\.|self\.)?(__[A-Z0-9_]+__)\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(txt);
    if (m) { try { roots.push(JSON.parse(m[2])); } catch { /* a JS object literal, not JSON: left alone */ } }
  }
  const out = [], seen = new Set();
  let total = 0;
  const prose = (s) => s.length >= 60 && /\s/.test(s) && !/^(https?:|data:|\/)/.test(s) && !/[{}<>]{2,}|function\s*\(|=>|\\u00/.test(s)
    && (s.match(/\p{L}/gu) || []).length / s.length > 0.6;
  const walk = (x, key, depth) => {
    if (out.length >= 60 || total > 6000 || depth > 14 || x == null) return;
    if (typeof x === 'string') {
      const s = stripTags(x);
      const titled = /^(title|name|headline|heading|summary)$/i.test(key || '') && s.length >= 12 && s.length <= 200 && /\s/.test(s);
      if ((titled || prose(s)) && !seen.has(s)) { seen.add(s); out.push(s.slice(0, 700)); total += Math.min(s.length, 700); }
      return;
    }
    if (Array.isArray(x)) { for (const y of x) walk(y, key, depth + 1); return; }
    if (typeof x === 'object') for (const [k, v] of Object.entries(x)) walk(v, k, depth + 1);
  };
  for (const r of roots) walk(r, '', 0);
  return out;
}

const stateChunks = (strings) => {
  const out = [];
  let cur = '';
  for (const s of strings) {
    if (cur && cur.length + s.length + 1 > LIMITS.chunk) { out.push({ h: '', text: cur, kind: 'state' }); cur = ''; }
    cur = cur ? cur + '\n' + s : s;
  }
  if (cur) out.push({ h: '', text: cur, kind: 'state' });
  return out;
};

// <noscript> as the page wrote it for browsers without JavaScript: in a parsed document (no scripting) it is markup.
// The «enable JavaScript» notices are not content.
const NOSCRIPT_NAG = /(enable|activa|habilita|activar|turn on|switch on)\s+(your\s+)?javascript|javascript (is|está) (disabled|desactivado)|requires javascript|necesita javascript|use the [\w ]+ web application/i;
export function noscriptChunks(doc) {
  const out = [];
  for (const n of doc.querySelectorAll('body noscript')) {
    const holder = doc.createElement('div');
    holder.innerHTML = n.innerHTML || n.textContent || '';
    holder.querySelectorAll('img, iframe, style, script').forEach((x) => x.remove());
    const parts = [...holder.querySelectorAll('p, li, h1, h2, h3, h4, div:not(:has(p, div))')].map((e) => squash(e.textContent)).filter(Boolean);
    for (const t of (parts.length ? parts : [squash(holder.textContent)])) if (t.length > 2 && !NOSCRIPT_NAG.test(t)) out.push(t);
  }
  const text = [...new Set(out)].join('\n');
  return text ? (text.length > LIMITS.chunk * 1.3 ? splitSentences(text, LIMITS.chunk) : [text]).map((t) => ({ h: '', text: t, kind: 'noscript' })) : [];
}

const metaChunk = (page) => {
  const t = [page.title, page.description].filter(Boolean).join(' · ');
  return t.length > 20 ? { h: '', text: t + (page.published ? ` (${page.published.slice(0, 10)})` : ''), kind: 'meta' } : null;
};

// RSS 2.0 and Atom: the feed's title and its newest items (title, date, summary, link).
export function parseFeed(xml) {
  const text = String(xml || '');
  const tag = (s, n) => { const m = new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)<\/${n}>`, 'i').exec(s); return m ? m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1') : ''; };
  const title = stripTags(tag(text.replace(/<(item|entry)\b[\s\S]*$/i, ''), 'title'));
  const items = [];
  for (const m of text.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const b = m[2];
    const link = stripTags(tag(b, 'link')) || (/<link\b[^>]*href="([^"]+)"/i.exec(b)?.[1] || '');
    items.push({
      title: stripTags(tag(b, 'title')),
      url: decodeEntities(link),
      date: stripTags(tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published') || tag(b, 'dc:date')),
      text: stripTags(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content') || tag(b, 'content:encoded')).slice(0, 600),
    });
    if (items.length >= 15) break;
  }
  return { title, items };
}

const feedChunks = (feed) => feed.items.map((it) => ({ h: feed.title.slice(0, 80), text: [it.title && it.title !== it.text ? it.title : '', it.date ? `(${it.date})` : '', it.text, it.url].filter(Boolean).join(' '), kind: 'feed' }));

// Public JSON a few JavaScript-only sites give for the same thing, one request: a Mastodon post, a Bluesky post.
export function knownApiFor(url, html = '') {
  let u;
  try { u = new URL(url); } catch { return null; }
  let m = /^\/@[\w.]+\/(\d{6,})\/?$/.exec(u.pathname);
  if (m && /mastodon/i.test(html)) {
    return { via: 'mastodon-api', url: `${u.origin}/api/v1/statuses/${m[1]}`, chunks: (j) => {
      const d = typeof j === 'string' ? JSON.parse(j) : j;
      const who = `${pick(d.account, 'display_name') || ''} (@${pick(d.account, 'acct') || ''})`;
      const text = [stripTags(d.content), ...[].concat(d.media_attachments || []).map((a) => a?.description).filter(Boolean)].join(' ');
      return [{ h: who, text: `${text}\n(${d.created_at}; replies ${d.replies_count}, boosts ${d.reblogs_count}, favourites ${d.favourites_count})`, kind: 'api' }];
    } };
  }
  m = /^\/profile\/([^/]+)\/post\/([\w]+)\/?$/.exec(u.pathname);
  if (m && /(^|\.)bsky\.app$/.test(u.hostname)) {
    return { via: 'bluesky-api', url: `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=at://${m[1]}/app.bsky.feed.post/${m[2]}&depth=0&parentHeight=0`, chunks: (j) => {
      const p = (typeof j === 'string' ? JSON.parse(j) : j)?.thread?.post;
      if (!p) return [];
      return [{ h: `${p.author?.displayName || ''} (@${p.author?.handle || ''})`, text: `${squash(p.record?.text)}\n(${p.record?.createdAt}; replies ${p.replyCount}, reposts ${p.repostCount}, likes ${p.likeCount})`, kind: 'api' }];
    } };
  }
  return null;
}

// ---------------------------------------------------------------- the site's own search box

const SEARCH_WORD = /search|busca|buscador|recherche|suche|cerca|pesquis|zoek|szuk|query/i;
const SEARCH_NAMES = ['q', 's', 'query', 'search', 'searchterm', 'search_query', 'keys', 'k', 'term', 'terms', 'keyword', 'keywords', 'text', 'texto', 'buscar', 'busqueda', 'str', 'w', 'p', 'qs', 'find'];
const NOT_SEARCH = /login|log-in|signin|sign-in|subscribe|newsletter|suscrib|registr|contact|password|mail|cart|carrito|checkout/i;

// GET forms that look like a search: a scored list of { score, field, build(query) → url }. POST forms are left out:
// the proxy only GETs, and submitting forms is not what this does.
export function findSearchForms(doc, base) {
  const out = [];
  for (const form of doc.querySelectorAll('form')) {
    if ((form.getAttribute('method') || 'get').toLowerCase() !== 'get') continue;
    if (form.querySelector('input[type="password"], input[type="email"], input[type="file"]')) continue;
    const action = form.getAttribute('action') || '';
    let target;
    try { target = new URL(action || base, base); } catch { continue; }
    if (!/^https?:$/.test(target.protocol)) continue;
    const texts = [...form.querySelectorAll('input')].filter((i) => ['', 'text', 'search'].includes((i.getAttribute('type') || '').toLowerCase()) && i.getAttribute('name'));
    if (!texts.length || texts.length > 2) continue;
    const label = (el) => [el.getAttribute('id'), el.getAttribute('class'), el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title')].filter(Boolean).join(' ');
    const scoreInput = (i) => ((i.getAttribute('type') || '').toLowerCase() === 'search' ? 3 : 0) + (SEARCH_NAMES.includes(i.getAttribute('name').toLowerCase()) ? 2 : 0) + (SEARCH_WORD.test(label(i)) ? 1 : 0);
    const field = texts.sort((x, y) => scoreInput(y) - scoreInput(x))[0];
    const formWords = [label(form), action, form.getAttribute('name') || ''].join(' ');
    if (NOT_SEARCH.test(formWords)) continue;
    let score = scoreInput(field);
    if (form.getAttribute('role') === 'search' || form.closest('[role="search"]')) score += 3;
    if (SEARCH_WORD.test(formWords)) score += 2;
    if (score < 3) continue;
    const fixed = [];
    for (const el of form.querySelectorAll('input[type="hidden"][name], select[name], input[type="checkbox"][name][checked], input[type="radio"][name][checked]')) {
      const value = el.tagName === 'SELECT' ? (el.querySelector('option[selected]') || el.querySelector('option'))?.getAttribute('value') ?? '' : el.getAttribute('value') ?? 'on';
      fixed.push([el.getAttribute('name'), value]);
    }
    const name = field.getAttribute('name');
    out.push({
      score, field: name, action: target.href.replace(/[?#].*$/, ''),
      build(query) {
        const u = new URL(target.href);
        const ps = new URLSearchParams();
        // The form's order: the text field where it sits among the fixed ones (servers rarely care, caches do).
        let placed = false;
        const order = [...form.querySelectorAll('input[name], select[name]')].map((el) => el.getAttribute('name'));
        for (const n of order) {
          if (n === name && !placed) { ps.append(name, query); placed = true; continue; }
          for (const [k, v] of fixed) if (k === n && !ps.has(k)) ps.append(k, v);
        }
        if (!placed) ps.append(name, query);
        u.search = ps.toString();
        u.hash = '';
        return u.href;
      },
    });
  }
  return out.sort((x, y) => y.score - x.score);
}

// ---------------------------------------------------------------- ranking

// Search operators are for the engine, not words of the question: «site:wordpress.org/news» matched every chunk.
const OPERATORS = /\b(site|inurl|intitle|filetype|ext|lang|region):\S+/gi;
// Words of the query that can pick a link: three letters or more. In a handful of link texts the BM25 of «de», «la»
// or «of» is not low enough, and «política de cookies» came out as a result for «ola de calor».
// The same for the function words of three letters or more of the languages the products speak most: they decide
// nothing about relevance, and in a menu or a short page they are enough to look like a match.
const STOP = new Set(('que qué por para con una uno unos unas los las del como cómo cuál cual cuáles cuando cuándo dónde donde '
  + 'hay hace son está están sobre entre pero más muy sus este esta esto ese esa eso tiene tienen puedo puede quiero dime '
  + 'the and for with what how why who which when where are was were does did can could would should will this that '
  + 'these those from into about have has had you your use using tell me').split(' '));
const contentTerms = (terms, q) => [...new Set(terms(String(q || '').replace(OPERATORS, ' ')))].filter((t) => [...t].length >= 3 && !STOP.has(t));
const slugWords = (url) => { try { const u = new URL(url); return decodeURIComponent(u.pathname).replace(/[/_\-.+]+/g, ' ').replace(/\b(html?|php|aspx?)\b/g, ''); } catch { return ''; } };

// Passages of one or more pages ranked against the question with BM25 (acer-core.js), kept within `budget`
// characters and handed back in reading order per page. With no word of the question in the page, the opening
// passages are what is returned, and `matched` says so.
export function rankPassages(pages, question, { terms, buildBM25, budget = LIMITS.fetchChars, lead = true, perPage = Infinity, embedRank = null } = {}) {
  const all = [];
  for (const p of [].concat(pages)) for (const c of p.chunks || []) all.push({ ...c, url: p.url, title: p.title, p });
  if (!all.length) return { passages: [], matched: false, total: 0 };
  // Content words decide; when the question has none («¿y eso?», «AI»), all its words.
  const q = contentTerms(terms, question).length ? contentTerms(terms, question) : [...new Set(terms(String(question || '').replace(OPERATORS, ' ')))];
  const bm = buildBM25(all.map((c) => (c.h ? c.h + ' \n' : '') + c.text));
  const scores = all.map((_, i) => (q.length ? bm.scoreDoc(i, q) : 0));
  // A passage far below the best (under a quarter of its score) matched by a word the whole site repeats: out.
  const top = Math.max(0, ...scores);
  let order = all.map((_, i) => i).filter((i) => scores[i] > 0 && scores[i] >= top * 0.25).sort((a, b) => scores[b] - scores[a] || a - b);
  // A second opinion, when the app has embeddings loaded (Code): reciprocal rank fusion of the two orders.
  if (embedRank && order.length) {
    const sem = embedRank(all.map((c) => c.text), question) || [];
    if (sem.length) {
      const fused = new Map();
      [order, sem].forEach((list) => list.forEach((id, r) => fused.set(id, (fused.get(id) || 0) + 1 / (60 + r + 1))));
      order = [...fused.keys()].sort((a, b) => fused.get(b) - fused.get(a));
    }
  }
  const matched = order.length > 0;
  if (!matched) order = all.map((_, i) => i);
  const picked = new Set();
  const perUsed = new Map();
  let used = 0;
  const take = (i) => {
    const c = all[i];
    const cost = c.text.length + (c.h ? c.h.length + 4 : 0) + 4;
    if (picked.has(i) || used + cost > budget || (perUsed.get(c.url) || 0) + cost > perPage) return false;
    picked.add(i); used += cost; perUsed.set(c.url, (perUsed.get(c.url) || 0) + cost);
    return true;
  };
  for (const i of order) take(i);
  // The page's opening passage, when it was not picked and there is room: often the definition the question needs.
  // Only for a page where something matched, and only a real paragraph, not a line of menu.
  if (lead && matched) {
    for (const p of [].concat(pages)) {
      const i = all.findIndex((c) => c.p === p);
      if (i >= 0 && all[i].text.length >= 150 && [...picked].some((k) => all[k].p === p) && budget - used > 350) take(i);
    }
  }
  const passages = [...picked].sort((a, b) => a - b).map((i) => ({ url: all[i].url, title: all[i].title, h: all[i].h, text: all[i].text, score: scores[i] }));
  return { passages, matched, total: all.length };
}

// Links of a results page (or any page) that look like results: same site, in the content (not in a menu), not the
// page itself, not files. Links in headings or that share words with the query come first; the site's own order
// is kept otherwise (it already ranked them).
export function resultLinks(page, query, { terms, buildBM25, site = null, exclude = [], max = 8 } = {}) {
  const host = (() => { try { return new URL(site || page.url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const self = new Set([page.url, page.canonical, ...exclude].filter(Boolean).map((u) => u.replace(/#.*$/, '')));
  const cands = [];
  const seen = new Set();
  for (const l of page.links) {
    if (l.chrome || ASSET.test(l.url) || self.has(l.url) || seen.has(l.url)) continue;
    let u;
    try { u = new URL(l.url); } catch { continue; }
    const h = u.hostname.replace(/^www\./, '');
    if (host && h !== host && !h.endsWith('.' + host)) continue;
    if (u.pathname === '/' && !u.search) continue;
    if (/[?&](s|q|query|search|str|page|paged|p)=/.test(u.search) && SEARCH_WORD.test(u.pathname + u.search)) continue;
    if (l.text.length < 3 || /^(next|siguiente|previous|anterior|more|más|leer más|read more|\d+)$/i.test(l.text)) continue;
    seen.add(l.url);
    cands.push(l);
  }
  if (!cands.length) return [];
  const q = contentTerms(terms, query);
  const bm = buildBM25(cands.map((l) => l.text + ' ' + slugWords(l.url)));
  const scored = cands.map((l, i) => ({ l, i, s: q.length ? bm.scoreDoc(i, q) : 0 }));
  const strong = scored.filter((x) => x.s > 0 || x.l.heading);
  const pick = (strong.length ? strong : []).sort((a, b) => (b.s > 0) - (a.s > 0) || (b.l.heading - a.l.heading) || a.i - b.i);
  return pick.slice(0, max).map((x) => ({ title: x.l.text, url: x.l.url, snippet: '' }));
}

// Sitemap entries ranked by the words of their address against the query; the newest first among equals.
export function rankUrls(locs, query, { terms, buildBM25, max = 8 } = {}) {
  if (!locs.length) return [];
  const q = contentTerms(terms, query);
  if (!q.length) return [];
  const bm = buildBM25(locs.map((x) => slugWords(x.loc)));
  return locs.map((x, i) => ({ x, s: bm.scoreDoc(i, q) }))
    .filter((y) => y.s > 0)
    .sort((a, b) => b.s - a.s || String(b.x.lastmod).localeCompare(String(a.x.lastmod)))
    .slice(0, max)
    .map((y) => ({ title: slugWords(y.x.loc).trim().split(/\s+/).slice(-8).join(' '), url: y.x.loc, snippet: y.x.lastmod ? y.x.lastmod.slice(0, 10) : '' }));
}

// ---------------------------------------------------------------- known public APIs
// Sites whose search API is documented for programs to use: their robots.txt closes /w/ to crawlers, not to the API.
export function knownSearch(site, query) {
  let u;
  try { u = new URL(site); } catch { return null; }
  const m = /^([a-z-]+)\.(?:m\.)?wikipedia\.org$/.exec(u.hostname);
  if (m) return { via: 'wikipedia', url: `https://${m[1]}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&namespace=100|104|0`, parse: parseSuggestions };
  return null;
}

// ---------------------------------------------------------------- the research session

// `searchEngine`, optional: { url(query) → the address the words go to (for the card), run(query, { signal }) →
// parseSearx's shape, throwing on 429 or failure }. Without it (or when it fails, says 429 or finds nothing) the
// search goes to DuckDuckGo through the proxy: html and lite without an engine, lite alone as the fallback.
export function createResearch({ get, parseHTML, terms, buildBM25, Readability = null, agent = AGENT, limits = {}, searchEngine = null }) {
  const L = { ...LIMITS, ...limits };
  const robotsCache = new Map();   // origin → parsed robots.txt (or null: none), for as long as the page lives
  const R = { terms, buildBM25 };

  function session(signal) {
    const s = { sent: [], signal, left: L.requests, notes: [] };
    s.fetch = async (url) => {
      if (s.left <= 0) { const e = new Error('budget'); e.code = 'budget'; throw e; }
      s.left--;
      s.sent.push(url);
      return get(url, { signal });
    };
    return s;
  }

  async function robotsFor(s, url) {
    const origin = new URL(url).origin;
    if (robotsCache.has(origin)) return robotsCache.get(origin);
    let parsed = null;
    try {
      const r = await s.fetch(origin + '/robots.txt');
      if (r.ok && r.status < 300 && /^text\/plain|^$/i.test(String(r.type || '').split(';')[0].trim())) parsed = parseRobots(r.text);
      // 4xx: no robots.txt, everything allowed (RFC 9309 §2.3.1.3). 5xx or no answer: treated as «no» for this visit.
      else if (r.status >= 500) parsed = { groups: [{ agents: ['*'], rules: [{ allow: false, path: '/' }] }], sitemaps: [], unreachable: true };
    } catch (e) {
      if (s.signal?.aborted || e.code === 'budget') throw e;
      parsed = { groups: [{ agents: ['*'], rules: [{ allow: false, path: '/' }] }], sitemaps: [], unreachable: true };
    }
    if (robotsCache.size > 50) robotsCache.delete(robotsCache.keys().next().value);
    robotsCache.set(origin, parsed);
    return parsed;
  }
  const allowed = async (s, url) => robotsAllows(await robotsFor(s, url), url, agent);

  // `alternates`: a page that is still a shell after reading its data tries, one request each and while the budget
  // lasts, the same content in another form: the public API of a known site (Mastodon, Bluesky), the AMP version it
  // links (rel=amphtml), its RSS/Atom feed, and, only when `guessAmp` (web.fetch) and it links no AMP, ?format=amp,
  // which counts only if the answer really is AMP. These are the page itself said another way, so robots.txt is not
  // asked for them, as it is not for the page.
  async function readPage(s, url, { alternates = true, guessAmp = false } = {}) {
    const r = await s.fetch(url);
    // `message`: the app's own words for what went wrong, when its get() gives them (Claw names each proxy refusal).
    if (!r.ok) return { url, error: { status: r.status, code: r.code || '', message: r.message || '' } };
    if (!isTextual(r.type)) return { url, error: { type: r.type } };
    const finalUrl = r.url || url;
    if (/json/i.test(r.type)) return { url: finalUrl, json: r.text };
    if (/^(application|text)\/(rss|atom)\+xml/i.test(r.type) || /^\s*<\?xml[^>]*>\s*<(rss|feed)\b/i.test(r.text.slice(0, 300))) {
      const feed = parseFeed(r.text);
      return { url: finalUrl, title: feed.title, chunks: feedChunks(feed).map((c, i) => ({ ...c, i })), links: feed.items.map((it) => ({ url: it.url, text: it.title || it.text.slice(0, 80), chrome: false, heading: true })), hints: {}, textLength: 1, via: 'feed', fallbacks: ['feed'] };
    }
    const page = extractPage(r.text, finalUrl, { parseHTML, Readability, thinBelow: L.thinBelow });
    page.truncated = !!r.truncated;
    // Facts (a profile's name and followers) do not make a page readable: its own text and bodies count.
    if (alternates && page.thin && page.ownText < L.thinBelow) await tryAlternates(s, page, r.text, { guessAmp });
    return page;
  }

  async function tryAlternates(s, page, html, { guessAmp }) {
    const tries = [];
    const api = knownApiFor(page.url, html);
    if (api) tries.push({ via: api.via, url: api.url, read: async (x) => (x.ok ? api.chunks(x.text) : []) });
    const html2chunks = (x, mustAmp) => {
      if (!x.ok || !isTextual(x.type) || (mustAmp && !/<html[^>]*\s(amp|⚡)(\s|=|>)/i.test(x.text.slice(0, 3000)))) return [];
      return extractPage(x.text, x.url, { parseHTML, Readability, thinBelow: 0 }).chunks;
    };
    if (page.hints.amp) tries.push({ via: 'amp', url: page.hints.amp, read: async (x) => html2chunks(x, false) });
    if (page.hints.feeds[0]) tries.push({ via: 'feed', url: page.hints.feeds[0], read: async (x) => (x.ok ? feedChunks(parseFeed(x.text)) : []) });
    if (guessAmp && !/[?#]/.test(page.url)) tries.push({ via: 'format=amp', url: page.url + '?format=amp', read: async (x) => html2chunks(x, true) });
    let ampOk = false;
    for (const t of tries) {
      if (s.left <= 0) break;
      if (t.via === 'format=amp' && ampOk) continue;   // the guess only when the linked AMP gave nothing
      let chunks = [];
      try { chunks = await t.read(await s.fetch(t.url)); } catch (e) { if (s.signal?.aborted) throw e; if (e.code === 'budget') break; continue; }
      const len = chunks.reduce((n, c) => n + c.text.length, 0);
      // A known site's public API is the post itself, with its date and counts: it is taken whenever it answers.
      const take = /-api$/.test(t.via) ? len > 0 : len > page.ownText;
      page.fallbacks.push(t.via + (take ? '' : ':empty'));
      if (take) {
        // The alternate's text goes after the facts the page itself gave (its JSON-LD, its noscript).
        page.chunks = [...page.chunks, ...chunks].map((c, i) => ({ ...c, i }));
        page.textLength += len;
        page.ownText += len;
        page.altUrl = t.url;
        if (t.via === 'amp') ampOk = true;
        if (page.ownText >= L.thinBelow || /-api$/.test(t.via)) break;
      }
    }
  }

  async function engineSearch(s, query) {
    if (searchEngine) {
      if (s.left <= 0) { const e = new Error('budget'); e.code = 'budget'; throw e; }
      s.left--;
      s.sent.push(searchEngine.url(query));
      try {
        const r = await searchEngine.run(query, { signal: s.signal });
        if (r.items.length) return { items: r.items, answers: r.answers || [], via: 'searxng' };
        s.notes.push({ engine: 'empty' });
      } catch (e) {
        if (s.signal?.aborted) throw e;
        s.notes.push({ engine: e.code || e.status || 'error' });
      }
      const d = await ddgSearch(s, query, [DDG[1]]);
      // Our search failed (429, down) and DuckDuckGo gave nothing either: nobody would search, which is not «no results».
      const engineFailed = s.notes.length && s.notes[s.notes.length - 1].engine !== 'empty';
      return { ...d, blocked: d.blocked || (!d.items.length && !!engineFailed), via: 'ddg', fallback: true };
    }
    return { ...(await ddgSearch(s, query)), via: 'ddg' };
  }

  async function ddgSearch(s, query, endpoints = DDG) {
    let blocked = false;
    for (const ep of endpoints) {
      let r;
      try { r = await s.fetch(ep + encodeURIComponent(query)); } catch (e) { if (s.signal?.aborted || e.code === 'budget') throw e; continue; }
      const p = parseDuckDuckGo(r.text || '', parseHTML, r.status);
      if (p.items.length) return { items: p.items };
      if (p.blocked) blocked = true;
      else if (r.ok) return { items: [] };
      else s.notes.push({ ddg: r.code || r.status, message: r.message || '' });
    }
    return { items: [], blocked };
  }

  // Reads the first results by itself (the ones robots.txt lets it), and ranks their passages for the question.
  async function readResults(s, items, question, { n = L.readTop, budget, perPage = L.perPage } = {}) {
    const pages = [];
    const tried = new Set();
    for (const it of items) {
      if (pages.length >= n || s.left < 2) break;
      if (ASSET.test(it.url) || /\.(pdf|docx?|xlsx?|pptx?|odt)(\?|#|$)/i.test(it.url)) continue;   // not text: a request for nothing
      const bare = it.url.replace(/[?#].*$/, '');
      if (tried.has(bare)) continue;   // the same page with ?output_format=md, ?amp… is not a second source
      tried.add(bare);
      try {
        if (!(await allowed(s, it.url))) { s.notes.push({ robots: it.url }); continue; }
        const p = await readPage(s, it.url);
        if (p.chunks?.length) pages.push(p);
      } catch (e) { if (s.signal?.aborted) throw e; if (e.code === 'budget') break; }
    }
    return { pages, ...rankPassages(pages, question, { ...R, budget, perPage }) };
  }

  return {
    limits: L,

    // web.search: the engine's results; with `read`, the first pages are read and their best passages added.
    //
    // A site: search that finds nothing goes on, in this order, as long as the budget lasts: the user's own words
    // (a domain they wrote, or a word close to the site's name: «AEMET» when the model wrote site:emet.gob.es), then
    // a search inside that site (its own search, its sitemap, a short crawl), then the same words once without
    // site:. `question` is what the user wrote; it only decides here, on the device.
    async search(query, { question = '', read = 0, signal } = {}) {
      const s = session(signal);
      let r = await engineSearch(s, query);
      let fixed = null;
      const firstBlocked = !!r.blocked;
      const op = /(^|\s)site:(\S+)/i.exec(query);
      if (!r.items.length && op) {
        const rest = query.replace(op[0], ' ').replace(/\s+/g, ' ').trim();
        // site:wordpress.org/news is a folder: /news/ (the trailing slash spares a redirect, and robots and the
        // search inside the site start from there).
        let target = op[2].replace(/^https?:\/\//i, '');
        if (/\/[^/.]+$/.test(target)) target += '/';
        const domain = target.replace(/\/.*$/, '').toLowerCase();
        const fix = closestDomain(domain, question);
        if (fix?.domain && s.left > 0) {
          r = await engineSearch(s, `site:${fix.domain} ${rest}`);
          if (r.items.length) fixed = { from: domain, to: fix.domain };
        } else if (fix?.word && s.left > 0) {
          const r2 = await engineSearch(s, `${rest} ${fix.word}`);
          const theirs = r2.items.filter((it) => hostName(it.url).includes(fix.word));
          if (theirs.length) { r = { ...r2, items: theirs }; fixed = { from: domain, to: fix.word }; }
        }
        if (!r.items.length && !fix && rest && s.left >= 3) {
          const st = await siteIn(s, target, rest, { question, skipEngine: true });
          if (st.items?.length || st.passages?.length) {
            return { query, items: (st.items || []).slice(0, 6), answers: [], via: 'site', siteVia: st.via, blocked: false, sent: s.sent, passages: st.passages || [], notes: s.notes };
          }
        }
        if (!r.items.length && rest && s.left > 0) {
          r = await engineSearch(s, rest);
          if (r.items.length) fixed = { from: domain, to: '' };
        }
      }
      const items = r.items.slice(0, 6);
      const out = { query, items, answers: r.answers || [], via: r.via, fixed, fallback: !!r.fallback, blocked: !!r.blocked || (!items.length && firstBlocked), sent: s.sent, passages: [], notes: s.notes };
      if (read && items.length) {
        const rr = await readResults(s, items, (question + ' ' + query).trim(), { n: read, budget: Math.max(600, L.searchChars - 1200) });
        out.passages = rr.passages;
        out.notes = s.notes;
      }
      return out;
    },

    // web.fetch: one page, its passages for the question. An address that was asked for is read without robots.txt.
    async fetch(url, { question = '', signal, budget = L.fetchChars } = {}) {
      const s = session(signal);
      const p = await readPage(s, url, { guessAmp: true });
      if (p.error) return { url, error: p.error, sent: s.sent };
      if (p.json) return { url: p.url, title: '', passages: [{ url: p.url, h: '', text: p.json.slice(0, budget) }], matched: true, total: 1, sent: s.sent, page: { title: '', chunks: [] } };
      const rk = rankPassages(p, question, { ...R, budget });
      return { url: p.url, title: p.title, description: p.description, published: p.published, jsOnly: p.jsOnly, truncated: p.truncated, via: p.via, fallbacks: p.fallbacks || [], altUrl: p.altUrl || '', sent: s.sent, page: p, ...rk };
    },

    // web.site: search INSIDE a site. In order, and stopping at the first that answers: a documented public API
    // (Wikipedia), the site's OpenSearch description, WordPress's REST search, the site's own search form (GET),
    // the search engine with site: (Elffuss's SearXNG, else DuckDuckGo), its sitemap, and at last a short crawl
    // from the page given. Then the best results are
    // read and their passages ranked for the question.
    async site(site, query, { question = '', signal } = {}) {
      return siteIn(session(signal), site, query, { question });
    },

    // A short crawl from a page, same site and below its folder, following the links whose words match the
    // question best; its passages ranked across the pages read.
    async crawl(url, question, { signal, pages, depth } = {}) {
      const s = session(signal);
      const start = normalizeSite(url);
      if (!start) return { error: { code: 'bad-url' }, sent: [] };
      if (!(await allowed(s, start.href))) return { robots: true, passages: [], items: [], sent: s.sent };
      const home = await readPage(s, start.href);
      if (home.error) return { error: home.error, passages: [], items: [], sent: s.sent };
      const c = await crawlFrom(s, home, question, start, { pages, depth });
      return { ...c, sent: s.sent, notes: s.notes };
    },
  };

async function siteIn(s, site, query, { question = '', skipEngine = false } = {}) {
  const signal = s.signal;
    const start = normalizeSite(site);
    if (!start) return { error: { code: 'bad-url' }, sent: [] };
    const ask = (question + ' ' + query).trim();
    const tries = [];
    let items = [], via = '';
    const done = (v, list) => { if (list.length) { items = list; via = v; return true; } tries.push(v); return false; };
    try {
      const known = knownSearch(start.href, query);
      if (known) {
        const r = await s.fetch(known.url);
        done(known.via, r.ok ? known.parse(r.text) : []);
      }
      let home = null;
      if (!items.length) {
        if (!(await allowed(s, start.href))) return { site: start.href, query, robots: true, items: [], sent: s.sent, tries };
        // Read for its links and what it says about searching it: no alternates (feeds, AMP) for this one.
        home = await readPage(s, start.href, { alternates: false });
        if (home.error) return { site: start.href, query, error: home.error, items: [], sent: s.sent, tries };
      }
      if (!items.length && home?.hints?.opensearch && (await allowed(s, home.hints.opensearch))) {
        const d = await s.fetch(home.hints.opensearch);
        const os = d.ok ? parseOpenSearch(d.text) : {};
        const sug = os.suggest && fillTemplate(os.suggest, query, home.url);
        if (sug && (await allowed(s, sug))) { const r = await s.fetch(sug); done('opensearch', r.ok ? parseSuggestions(r.text) : []); }
        const html = !items.length && os.html && fillTemplate(os.html, query, home.url);
        if (html && (await allowed(s, html))) { const p = await readPage(s, html, { alternates: false }); done('opensearch', p.links ? resultLinks(p, query, { ...R, site: start.href }) : []); }
        else if (!items.length && (sug || html)) tries.push('opensearch:robots');
      }
      if (!items.length && home?.hints?.wpApi) {
        const u = home.hints.wpApi.replace(/\/?$/, '/') + 'wp/v2/search?search=' + encodeURIComponent(query) + '&per_page=8';
        if (await allowed(s, u)) { const r = await s.fetch(u); done('wordpress', r.ok ? parseWpSearch(r.text) : []); }
      }
      if (!items.length && home?.hints?.forms?.length) {
        const u = home.hints.forms[0].build(query);
        if (await allowed(s, u)) {
          const p = await readPage(s, u, { alternates: false });
          done('form', p.links && !p.jsOnly ? resultLinks(p, query, { ...R, site: start.href, exclude: [home.url] }) : []);
        } else tries.push('form:robots');
      }
      if (!items.length && !skipEngine) {
        const dir = start.pathname.endsWith('/') ? start.pathname : start.pathname.replace(/[^/]*$/, '');
        const scope = start.hostname.replace(/^www\./, '') + dir.replace(/\/$/, '');
        const r = await engineSearch(s, `site:${scope} ${query}`);
        done(r.blocked ? r.via + ':blocked' : r.via, r.items.filter((it) => sameSite(it.url, start.href)));
      }
      if (!items.length) {
        const robots = await robotsFor(s, start.href);
        const maps = (robots?.sitemaps || []).filter((m) => sameSite(m, start.href) && within(m, start.href));
        const list = await sitemapSearch(s, maps.length ? maps : [start.origin + '/sitemap.xml'], query, start);
        done('sitemap', list);
      }
      if (!items.length && home?.chunks) {
        const c = await crawlFrom(s, home, ask, start);
        if (c.matched && c.passages.length) return { site: start.href, query, via: 'crawl', items: c.items, passages: c.passages, sent: s.sent, tries, notes: s.notes };
        tries.push('crawl');
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      if (e.code !== 'budget') throw e;
      tries.push('budget');
    }
    const rr = items.length ? await readResults(s, items, ask, { n: L.readTop, budget: Math.max(600, L.siteChars - 900), perPage: L.siteChars }).catch((e) => { if (signal?.aborted) throw e; return { passages: [] }; }) : { passages: [] };
    return { site: start.href, query, via, items: items.slice(0, 6), passages: rr.passages, sent: s.sent, tries, notes: s.notes };
}

  async function sitemapSearch(s, maps, query, start) {
    const locs = [];
    const queue = [...maps];
    let read = 0;
    while (queue.length && read < L.sitemaps && s.left > 3) {
      const m = queue.shift();
      if (/\.gz(\?|$)/i.test(m) || !(await allowed(s, m))) continue;
      const r = await s.fetch(m).catch((e) => { if (s.signal?.aborted || e.code === 'budget') throw e; return null; });
      read++;
      if (!r?.ok || !isTextual(r.type)) continue;
      const sm = parseSitemap(r.text);
      if (sm.index) queue.unshift(...sm.locs.map((x) => x.loc).filter((x) => sameSite(x, start.href)).sort((a, b) => /post|news|article|page/i.test(b) - /post|news|article|page/i.test(a)).slice(0, 6));
      else locs.push(...sm.locs.filter((x) => sameSite(x.loc, start.href) && within(x.loc, start.href)).slice(0, 20000));
    }
    return rankUrls(locs, query, R);
  }

  async function crawlFrom(s, home, question, start, { pages = L.crawlPages, depth = L.crawlDepth } = {}) {
    const read = [home];
    const seen = new Set([home.url, start.href]);
    let frontier = nextLinks(home, question, start, seen, 1);
    while (read.length < pages && frontier.length && s.left > 0) {
      frontier.sort((a, b) => b.s - a.s);
      const next = frontier.shift();
      seen.add(next.url);
      try {
        if (!(await allowed(s, next.url))) { s.notes.push({ robots: next.url }); continue; }
        const p = await readPage(s, next.url, { alternates: false });
        if (!p.chunks) continue;
        read.push(p);
        if (next.d < depth) frontier.push(...nextLinks(p, question, start, seen, next.d + 1));
      } catch (e) { if (s.signal?.aborted) throw e; if (e.code === 'budget') break; }
    }
    const rk = rankPassages(read, question, { ...R, budget: L.siteChars, perPage: Math.ceil(L.siteChars * 0.7) });
    return { pages: read.map((p) => p.url), items: read.slice(1).map((p) => ({ title: p.title, url: p.url, snippet: '' })), ...rk };
  }

  function nextLinks(page, question, start, seen, d) {
    const q = contentTerms(terms, question);
    const links = page.links.filter((l) => !seen.has(l.url) && !ASSET.test(l.url) && sameSite(l.url, start.href) && within(l.url, start.href));
    if (!links.length || !q.length) return [];
    const bm = buildBM25(links.map((l) => l.text + ' ' + slugWords(l.url)));
    const out = [];
    links.forEach((l, i) => { const sc = bm.scoreDoc(i, q) + (l.chrome ? 0 : 0.01); if (sc > 0.01) { out.push({ url: l.url, s: sc, d }); seen.add(l.url); } });
    return out.sort((a, b) => b.s - a.s).slice(0, 12);
  }
}

const hostName = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const fold = (w) => w.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const siteLabel = (domain) => domain.replace(/^www\./, '').split('.')[0];

// The domain the user meant, from their own words, when the model's site: found nothing: a domain they wrote that
// is not the one searched (one, or one whose name is close), else a word of theirs close to the site's name
// («aemet» for emet.gob.es: at most one edit in four letters). Null when their words say nothing better.
export function closestDomain(domain, text) {
  const t = String(text || '');
  const label = siteLabel(domain);
  const theirs = [...new Set((t.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) || []).map((d) => d.toLowerCase().replace(/^www\./, '')))].filter((d) => !/\.(js|html?|php|json|png|jpe?g)$/.test(d));
  if (theirs.includes(domain.replace(/^www\./, ''))) return null;
  const near = theirs.filter((d) => editDistance(siteLabel(d), label) <= 2);
  if (near.length) return { domain: near[0] };
  if (theirs.length === 1) return { domain: theirs[0] };
  const words = [...new Set(fold(t).match(/[a-z0-9]{3,}/g) || [])];
  if (words.includes(label)) return null;
  const tol = Math.max(1, Math.floor(label.length / 4));
  const w = words.filter((x) => editDistance(x, label) <= tol).sort((a, b) => editDistance(a, label) - editDistance(b, label))[0];
  return w ? { word: w } : null;
}

export function normalizeSite(site) {
  let t = String(site || '').trim();
  if (!t) return null;
  if (!/^https?:\/\//i.test(t)) t = 'https://' + t.replace(/^\/+/, '');
  try { const u = new URL(t); u.hash = ''; return /^https?:$/.test(u.protocol) ? u : null; } catch { return null; }
}
const sameSite = (a, b) => { try { return new URL(a).hostname.replace(/^www\./, '') === new URL(b).hostname.replace(/^www\./, ''); } catch { return false; } };
// Below the folder of the start page: /news/2024/x is within /news/; /docs/a.html makes the folder /docs/.
const within = (a, start) => { try { const p = new URL(start).pathname; const dir = p.endsWith('/') ? p : p.replace(/[^/]*$/, ''); return new URL(a).pathname.startsWith(dir); } catch { return false; } };

// ---------------------------------------------------------------- what the model reads

export const WORDS = {
  es: {
    results: (q) => `Resultados de la web para «${q}»:`,
    none: (q) => `Sin resultados para «${q}».`,
    blocked: (q) => `Los buscadores no han dejado buscar «${q}» ahora mismo. Vuelve a intentarlo en un momento, o lee una dirección con web.fetch.`,
    read: 'Lo que dicen las primeras páginas:',
    page: (n, total, q) => q ? `Lo más relevante para la pregunta (${n} de ${total} fragmentos):` : `El principio de la página (${n} de ${total} fragmentos):`,
    noMatch: 'La página no menciona las palabras de la pregunta; este es su principio:',
    more: 'Hay más en la página: pide otra parte con web.fetch y otra pregunta.',
    fromData: (list, alt) => `(Página con poco texto propio: esto sale de ${list.map((f) => ({ 'json-ld': 'sus datos estructurados', state: 'los datos que trae para JavaScript', noscript: 'su versión sin JavaScript', meta: 'su descripción', amp: 'su versión AMP', feed: 'su feed', 'format=amp': 'su versión AMP', 'mastodon-api': 'la API pública de Mastodon', 'bluesky-api': 'la API pública de Bluesky' }[f] || f)).join(', ')}${alt ? ', ' + alt : ''}.)`,
    jsOnly: 'Esta página se construye con JavaScript y sin un navegador no tiene texto que leer. Busca la misma información en otra página.',
    notText: (t) => `No es una página de texto (${t}): no se puede leer aquí.`,
    site: (h, st) => `${h} respondió con el código ${st}.`,
    proxy: (h, code) => code === 'rate-limited' ? 'Se ha llegado al límite de lecturas por minuto. Espera un minuto y vuelve a intentarlo.' : `No se pudo leer ${h} a través del proxy (${code}).`,
    siteHead: (h, q, via) => `Búsqueda de «${q}» dentro de ${h}${via ? ` (con ${via})` : ''}:`,
    siteNone: (h, q) => `No se encontró «${q}» dentro de ${h}: ni su buscador, ni los buscadores de internet, ni su mapa del sitio dieron resultados.`,
    robots: (h) => `${h} pide en su robots.txt que los programas no lean esa parte del sitio.`,
    via: { wikipedia: 'la API de Wikipedia', opensearch: 'el buscador del sitio', wordpress: 'el buscador de WordPress', form: 'el buscador del sitio', sitemap: 'su mapa del sitio', searxng: 'el buscador de Elffuss con site:', ddg: 'DuckDuckGo site:', crawl: 'una lectura de sus páginas' },
    answer: 'Respuesta directa:',
    cut: '[… cortado]',
    cite: 'Al responder, cita de dónde lo sacas con su dirección: [título](dirección).',
    fixed: (f) => f.to ? `(Con «site:${f.from}» no salió nada; se buscó con «${f.to}».)` : `(Con «site:${f.from}» no salió nada; se buscó sin limitar a esa web.)`,
  },
  en: {
    results: (q) => `Web results for “${q}”:`,
    none: (q) => `No results for “${q}”.`,
    blocked: (q) => `The search engines would not search for “${q}” right now. Try again in a moment, or read an address with web.fetch.`,
    read: 'What the first pages say:',
    page: (n, total, q) => q ? `Most relevant to the question (${n} of ${total} passages):` : `The start of the page (${n} of ${total} passages):`,
    noMatch: 'The page does not mention the words of the question; this is how it starts:',
    more: 'There is more on the page: ask for another part with web.fetch and another question.',
    fromData: (list, alt) => `(A page with little text of its own: this comes from ${list.map((f) => ({ 'json-ld': 'its structured data', state: 'the data it ships for JavaScript', noscript: 'its no-JavaScript version', meta: 'its description', amp: 'its AMP version', feed: 'its feed', 'format=amp': 'its AMP version', 'mastodon-api': 'Mastodon\'s public API', 'bluesky-api': 'Bluesky\'s public API' }[f] || f)).join(', ')}${alt ? ', ' + alt : ''}.)`,
    jsOnly: 'This page is built by JavaScript and has no text to read without a browser. Look for the same information on another page.',
    notText: (t) => `Not a text page (${t}): it cannot be read here.`,
    site: (h, st) => `${h} answered with code ${st}.`,
    proxy: (h, code) => code === 'rate-limited' ? 'The limit of reads per minute was reached. Wait a minute and try again.' : `Could not read ${h} through the proxy (${code}).`,
    siteHead: (h, q, via) => `Search for “${q}” inside ${h}${via ? ` (with ${via})` : ''}:`,
    siteNone: (h, q) => `Nothing found for “${q}” inside ${h}: neither its search, nor the web search engines, nor its sitemap gave results.`,
    robots: (h) => `${h} asks in its robots.txt that programs do not read that part of the site.`,
    via: { wikipedia: 'the Wikipedia API', opensearch: 'the site\'s search', wordpress: 'WordPress search', form: 'the site\'s search', sitemap: 'its sitemap', searxng: 'the Elffuss search with site:', ddg: 'DuckDuckGo site:', crawl: 'reading its pages' },
    answer: 'Direct answer:',
    cut: '[… cut]',
    cite: 'When you answer, say where it comes from with its address: [title](address).',
    fixed: (f) => f.to ? `(“site:${f.from}” found nothing; searched with “${f.to}” instead.)` : `(“site:${f.from}” found nothing; searched without keeping to that site.)`,
  },
};

const hostOf = (u) => { try { return new URL(u).host; } catch { return String(u); } };
const passageLines = (ps, withUrl) => {
  const out = [];
  let lastUrl = '';
  for (const p of ps) {
    if (withUrl && p.url !== lastUrl) { out.push(`[${p.url}]${p.title ? ' ' + p.title : ''}`); lastUrl = p.url; }
    out.push((p.h ? `§ ${p.h}\n` : '') + p.text);
  }
  return out.join('\n');
};

export function renderSearch(r, w) {
  if (!r.items.length) return r.blocked ? w.blocked(r.query) : w.none(r.query);
  const lines = r.items.map((it) => `• ${it.title}\n  ${it.url}${it.snippet ? '\n  ' + it.snippet.slice(0, 180) : ''}`);
  let text = w.results(r.query) + (r.fixed ? '\n' + w.fixed(r.fixed) : '') + (r.answers?.length ? '\n' + w.answer + ' ' + r.answers.join(' · ') : '') + '\n\n' + lines.join('\n\n');
  if (r.passages?.length) text += '\n\n' + w.read + '\n' + passageLines(r.passages, true);
  return text + '\n\n' + w.cite;
}

export function renderPage(r, w, question) {
  if (r.error) return r.error.type ? w.notText(r.error.type) : r.error.code ? w.proxy(hostOf(r.url), r.error.code) : w.site(hostOf(r.url), r.error.status);
  if (r.jsOnly && !r.passages.length) return `[${r.url}]\n${w.jsOnly}`;
  const from = (r.fallbacks || []).filter((f) => !/^facts$|:empty$/.test(f));
  const head = `[${r.url}]${r.title ? ' ' + r.title : ''}${r.published ? ` (${r.published.slice(0, 10)})` : ''}` + (from.length ? '\n' + w.fromData(from, r.altUrl) : '');
  if (!r.passages.length) return head + '\n' + (r.jsOnly ? w.jsOnly : (r.description || ''));
  const label = r.matched ? w.page(r.passages.length, r.total, !!question) : w.noMatch;
  const more = r.passages.length < r.total ? '\n' + w.more : '';
  return `${head}\n${label}\n${passageLines(r.passages, false)}${more}\n${w.cite}`;
}

export function renderSite(r, w) {
  const h = hostOf(r.site || '');
  if (r.robots) return w.robots(h);
  if (r.error) return r.error.type ? w.notText(r.error.type) : r.error.code ? w.proxy(h, r.error.code) : w.site(h, r.error.status);
  if (!r.items?.length && !r.passages?.length) return w.siteNone(h, r.query);
  const lines = (r.items || []).map((it) => `• ${it.title}\n  ${it.url}`);
  let text = w.siteHead(h, r.query, w.via[r.via] || '') + (lines.length ? '\n\n' + lines.join('\n') : '');
  if (r.passages?.length) text += '\n\n' + w.read + '\n' + passageLines(r.passages, true);
  return text + '\n\n' + w.cite;
}
