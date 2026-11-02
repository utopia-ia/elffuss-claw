// Iconos estilo VS Code, en SVG inline propio (sin dependencias).
// Archivos: insignia con la abreviatura y el color canónico del lenguaje.
const FILE_TYPES = {
  js: ['JS', '#f1dd3f'], mjs: ['JS', '#f1dd3f'], cjs: ['JS', '#f1dd3f'],
  ts: ['TS', '#3178c6'], tsx: ['TS', '#3178c6'], jsx: ['JS', '#61dafb'],
  py: ['PY', '#4b8bbe'], rs: ['RS', '#dea584'], go: ['GO', '#00add8'],
  java: ['J', '#e76f00'], c: ['C', '#659ad2'], h: ['H', '#659ad2'],
  cpp: ['C+', '#f34b7d'], cs: ['C#', '#178600'],
  json: ['{}', '#cbcb41'], yaml: ['Y', '#cb4b4b'], yml: ['Y', '#cb4b4b'],
  toml: ['T', '#9c4221'], xml: ['<>', '#e37933'],
  html: ['<>', '#e34c26'], css: ['#', '#9b7cf6'], scss: ['#', '#c6538c'],
  md: ['M', '#519aba'], txt: ['≡', '#8b93a8'], csv: ['⊞', '#89e051'],
  sh: ['$', '#89e051'], sql: ['DB', '#e38c00'],
  svg: ['SV', '#ffb13b'], png: ['IMG', '#a074c4'], jpg: ['IMG', '#a074c4'],
  gif: ['IMG', '#a074c4'], ico: ['IMG', '#a074c4'],
  lock: ['🔒', '#8b93a8'], gitignore: ['GIT', '#f05033'],
};

export function fileIcon(name) {
  const base = name.toLowerCase();
  const ext = base.startsWith('.git') ? 'gitignore' : (base.split('.').pop() || '');
  const [label, color] = FILE_TYPES[ext] || ['·', '#6b7391'];
  const fontSize = label.length > 2 ? 5 : (label.length === 2 ? 6.5 : 8);
  return `<svg class="fico" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="${color}1f" stroke="${color}" stroke-width="1"/>
    <text x="8" y="${label.length > 2 ? 10.4 : 10.8}" font-size="${fontSize}" text-anchor="middle"
      fill="${color}" font-family="system-ui" font-weight="700">${label}</text></svg>`;
}

export function folderIcon() {
  return `<svg class="fico chev" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path class="chevron" d="M6 4.5 L10 8 L6 11.5" fill="none" stroke="#8b93a8" stroke-width="1.6" stroke-linecap="round"/>
  </svg><svg class="fico" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M1.5 4 a1 1 0 0 1 1-1 h3.2 l1.6 1.8 h6.2 a1 1 0 0 1 1 1 v6.7 a1 1 0 0 1 -1 1 h-11 a1 1 0 0 1 -1-1 Z"
      fill="#dcb67a33" stroke="#dcb67a" stroke-width="1"/></svg>`;
}

// Codicons de UI (estilo VS Code, sin emojis). Trazos con currentColor.
const ico = (p, sw = 1.6) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
export const UI = {
  clear: ico('<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>'),
  // nueva conversación: un bocadillo con un +, no una papelera (que se lee «borrar»)
  newChat: ico('<path d="M4 5h16v11H9l-5 4z"/><path d="M12 8v5M9.5 10.5h5"/>'),
  gear: ico('<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/>'),
  send: ico('<path d="M4 12l16-8-6 16-3.5-6.5L4 12z"/>'),
  add: ico('<path d="M12 5v14M5 12h14"/>', 1.8),
  slash: ico('<path d="M15 5L9 19"/>', 1.8),
  editor: ico('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>'),
  chat: ico('<path d="M4 5h16v11H9l-5 4z"/>'),
  puzzle: ico('<path d="M10 4h4a1 1 0 0 1 1 1v2a1.5 1.5 0 1 0 3 0V6h2a1 1 0 0 1 1 1v4h-1a1.5 1.5 0 1 0 0 3h1v4a1 1 0 0 1-1 1h-4v-1a1.5 1.5 0 1 0-3 0v1H6a1 1 0 0 1-1-1v-4h1a1.5 1.5 0 1 0 0-3H5V7a1 1 0 0 1 1-1h4z"/>'),
  close: ico('<path d="M6 6l12 12M18 6L6 18"/>', 1.8),
  code: ico('<path d="M9 8l-5 4 5 4M15 8l5 4-5 4"/>'),
};

// Codicons de la barra de actividad (trazos simples estilo VS Code).
export const ACTIVITY = {
  files: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
    <path d="M7 4h7l4 4v12H7z"/><path d="M14 4v4h4"/><path d="M4 8v13h10" opacity=".55"/></svg>`,
  search: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
    <circle cx="10.5" cy="10.5" r="5.5"/><path d="M15 15l5 5"/></svg>`,
  gear: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
    <circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/></svg>`,
  chat: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
    <path d="M4 5h16v11H9l-5 4z"/></svg>`,
};

// Iconos de marca, con el degradado de Elffuss (latón → violeta → verde agua) en
// vez de currentColor: el cerebro es la configuración (el modelo y sus ajustes),
// el diccionario lo que se guarda (los modelos bajados) y el chip dice dónde
// corre el modelo. El degradado va en coordenadas del icono (userSpaceOnUse): con
// las de cada trazo, una raya recta no tiene alto y no se pintaba. Cada icono
// lleva su propio id de degradado para no repetir ids en la página.
let _grad = 0;
const marca = (p, s) => {
  const id = 'elfg' + (++_grad);
  return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="url(#${id})" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">`
    + `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="3" y1="3" x2="21" y2="21"><stop offset="0" stop-color="#e2bd84"/><stop offset=".55" stop-color="#a48cff"/><stop offset="1" stop-color="#5fe0cc"/></linearGradient></defs>${p}</svg>`;
};
const MEDIO_CEREBRO = '<path d="M11.4 5.6A2.5 2.5 0 0 0 7 6.6a2.9 2.9 0 0 0-2.3 3.7A3.2 3.2 0 0 0 4.6 15a3 3 0 0 0 2.6 2.4 2.6 2.6 0 0 0 4.2 1.1z"/><path d="M7.6 10.2c1 0 1.8.5 2.2 1.3M7.4 14.6c.9-.2 1.6-.8 1.9-1.6"/>';
export const brainIcon = (s = 16) => marca(MEDIO_CEREBRO + `<g transform="matrix(-1 0 0 1 24 0)">${MEDIO_CEREBRO}</g>`, s);
export const dictIcon = (s = 16) => marca('<path d="M5 5.2A2.2 2.2 0 0 1 7.2 3H18v14.5H7.2A2.2 2.2 0 0 0 5 19.7z"/><path d="M5 19.7a1.6 1.6 0 0 0 1.6 1.6H18v-3.8"/><path d="M9.2 13.5l2.3-6 2.3 6M10 11.6h3"/><path d="M18 6.5h1.6M18 10h1.6M18 13.5h1.6"/>', s);
export const gpuIcon = (s = 16) => marca('<rect x="6" y="6" width="12" height="12" rx="2.2"/><path d="M10 10h4v4h-4z"/><path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3"/>', s);
