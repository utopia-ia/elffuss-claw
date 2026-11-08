// «Tu versión» de Elffuss como DATOS: el tema que el usuario pide («ponte en verde», «más redondo») es un JSON pequeño
// que elffuss.com valida y aplica con su propio código. Nunca CSS ni código: cada valor se analiza y se vuelve a
// escribir, y solo puede tocar las propiedades de la lista. Este módulo es el validador canónico: Claw y Code lo usan
// al guardar, y el chat lo copia (chat-sync) y valida OTRA VEZ al aplicar, porque lo guardado viene de otra app.
//
//   validateTheme(x)   → { ok, theme, errors }   theme normalizado (solo lo válido), errors legibles para el modelo
//   themeProperties(t) → [[--propiedad, valor], …] para style.setProperty, y nada más
//   themeTexts(t, lang)→ { clave: texto } en texto plano, para textContent

export const SCHEMA = 'elffuss-theme@1';

// Color de la paleta → la propiedad de ds/tokens.css que lo lleva.
export const COLORS = {
  wall: '--ef-wall', surface: '--ef-surface', board: '--ef-board', steel: '--ef-steel', ink: '--ef-ink',
  graphite: '--ef-graphite', 'on-ink': '--ef-on-ink', tape: '--ef-tape', accent: '--ef-accent', selection: '--ef-selection',
};
// Escalas con nombre, no números libres: un radio de 400px o un espaciado de 0 rompen la página sin que nadie lo vea.
export const RADIUS = {
  square: ['0px', '0px', '0px', '0px'], soft: ['4px', '6px', '8px', '12px'],
  round: ['8px', '12px', '16px', '22px'], pill: ['10px', '18px', '22px', '28px'],
};
export const DENSITY = { compact: 0.75, normal: 1, roomy: 1.25 };
const SPACING = [4, 8, 12, 16, 24, 32, 48, 64];
// Solo pilas de fuentes del sistema: una fuente remota la bloquea la CSP y otra web podría seguir quién la pide.
export const FONTS = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
};
const LANGS = ['es', 'en'];
const MAX_TEXT = 160;
const MAX_TEXTS = 40;
const MAX_BYTES = 8 * 1024;
// Textos que el tema NO puede cambiar: avisos de descarga y de lo que sale del dispositivo, consentimientos,
// permisos, errores y la propia franja de «tu versión». Un tema que los reescribiera podría engañar justo donde el
// usuario decide algo. Claves exactas del chat y, por si aparecen otras con el mismo papel, un patrón.
export const DENY_TEXT = new Set([
  'gateTitle', 'gateBody', 'gateBtn', 'mgTitle', 'mgBody', 'mgBtn', 'mgBtnVision', 'mgBodyVision', 'mgNo', 'bytes',
  'fineMissing', 'fineCpu', 'fineCached', 'fineReady', 'stMissing', 'noPersist', 'askApps', 'askAppsBody', 'allow',
  'deny', 'delAsk', 'delYes', 'delNo', 'micDenied', 'mediaDenied', 'mediaNeed', 'mediaNeedBtn', 'mediaDownload',
  'webSentSearch', 'webSentUrl', 'webSentRead', 'webSentSite', 'webSentList', 'webSent', 'appDeniedLine',
  'memBtnOn', 'memBtnOff', 'memDownBtn', 'forgetLearnt', 'forgetFailed',
]);
const DENY_PATTERN = /gate|consent|permi|privacy|privac|download|descarg|sent|deny|denied|allow|forget|wipe|delete|del[A-Z]|mirror|official|version|myVersion|install|err[A-Z]|warn|secur|token|password|login|github|mem[A-Z]|memory|cookie/i;
export const textAllowed = (key) => !DENY_TEXT.has(key) && !DENY_PATTERN.test(key);

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
function hex6(c) {
  const h = c.toLowerCase();
  return h.length === 4 ? '#' + [...h.slice(1)].map((x) => x + x).join('') : h;
}
function luminance(c) {
  const h = hex6(c);
  const ch = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// Los colores de la versión oficial, para medir el contraste de un tema que solo cambia algunos.
const OFFICIAL = { wall: '#ffffff', ink: '#191b1e', 'on-ink': '#ffffff', surface: '#f6f7f4', tape: '#ffc629', selection: '#ffe48a', accent: '#191b1e' };

export function validateTheme(input) {
  const errors = [];
  const theme = { schema: SCHEMA };
  let x = input;
  let size = 0;
  try { size = new TextEncoder().encode(typeof x === 'string' ? x : JSON.stringify(x) ?? '').length; } catch { size = Infinity; }
  if (size > MAX_BYTES) return { ok: false, theme: null, errors: [`the theme is too large (${size} bytes, at most ${MAX_BYTES})`] };
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch { return { ok: false, theme: null, errors: ['the theme is not valid JSON'] }; } }
  if (!x || typeof x !== 'object' || Array.isArray(x)) return { ok: false, theme: null, errors: ['the theme must be a JSON object'] };
  for (const k of Object.keys(x)) if (!['schema', 'colors', 'radius', 'density', 'font', 'texts'].includes(k)) errors.push(`unknown field «${k}» (allowed: colors, radius, density, font, texts)`);

  if (x.colors != null) {
    if (typeof x.colors !== 'object' || Array.isArray(x.colors)) errors.push('colors must be an object');
    else {
      theme.colors = {};
      for (const [k, v] of Object.entries(x.colors)) {
        if (!Object.hasOwn(COLORS, k)) { errors.push(`unknown colour «${k}» (allowed: ${Object.keys(COLORS).join(', ')})`); continue; }
        if (typeof v !== 'string' || !HEX.test(v.trim())) { errors.push(`colour ${k} must be #rgb or #rrggbb, not «${String(v).slice(0, 30)}»`); continue; }
        theme.colors[k] = hex6(v.trim());
      }
      const c = { ...OFFICIAL, ...theme.colors };
      if (contrast(c.ink, c.wall) < 4.5) errors.push(`ink on wall is hard to read (contrast ${contrast(c.ink, c.wall).toFixed(1)}, needs 4.5)`);
      if (contrast(c.ink, c.surface) < 4.5) errors.push(`ink on surface is hard to read (contrast ${contrast(c.ink, c.surface).toFixed(1)}, needs 4.5)`);
      if (contrast(c['on-ink'], c.ink) < 4.5) errors.push(`on-ink on ink is hard to read (contrast ${contrast(c['on-ink'], c.ink).toFixed(1)}, needs 4.5)`);
      // Los estados también se tienen que ver: el texto sobre el subrayado y la selección se lee, y el acento (anillos,
      // botones de acento) se distingue de la página. El foco es la tinta, ya medida arriba.
      if (contrast(c.ink, c.tape) < 4.5) errors.push(`ink on tape is hard to read (contrast ${contrast(c.ink, c.tape).toFixed(1)}, needs 4.5)`);
      if (contrast(c.ink, c.selection) < 4.5) errors.push(`ink on selection is hard to read (contrast ${contrast(c.ink, c.selection).toFixed(1)}, needs 4.5)`);
      if (contrast(c.accent, c.wall) < 3) errors.push(`accent does not stand out from wall (contrast ${contrast(c.accent, c.wall).toFixed(1)}, needs 3)`);
      if (!Object.keys(theme.colors).length) delete theme.colors;
    }
  }
  for (const [k, table] of [['radius', RADIUS], ['density', DENSITY], ['font', FONTS]]) {
    if (x[k] == null) continue;
    if (Object.hasOwn(table, x[k])) theme[k] = x[k];
    else errors.push(`${k} must be one of ${Object.keys(table).join(', ')}`);
  }
  if (x.texts != null) {
    if (typeof x.texts !== 'object' || Array.isArray(x.texts)) errors.push('texts must be an object by language');
    else {
      theme.texts = {};
      let n = 0;
      for (const [lang, entries] of Object.entries(x.texts)) {
        if (!LANGS.includes(lang)) { errors.push(`texts: unknown language «${lang}» (allowed: ${LANGS.join(', ')})`); continue; }
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) { errors.push(`texts.${lang} must be an object`); continue; }
        for (const [key, val] of Object.entries(entries)) {
          if (!/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(key)) { errors.push(`texts.${lang}: bad key «${key.slice(0, 40)}»`); continue; }
          if (!textAllowed(key)) { errors.push(`texts.${lang}.${key} cannot be changed by a theme (it is a safety or privacy text)`); continue; }
          if (typeof val !== 'string') { errors.push(`texts.${lang}.${key} must be text`); continue; }
          const v = val.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
          if (!v || v.length > MAX_TEXT) { errors.push(`texts.${lang}.${key} must be 1 to ${MAX_TEXT} characters`); continue; }
          if (/[<>&]/.test(v)) { errors.push(`texts.${lang}.${key} cannot contain < > or &`); continue; }
          if (++n > MAX_TEXTS) { errors.push(`at most ${MAX_TEXTS} texts`); break; }
          (theme.texts[lang] ||= {})[key] = v;
        }
      }
      if (!Object.keys(theme.texts).length) delete theme.texts;
    }
  }
  return { ok: errors.length === 0, theme: errors.length ? null : theme, errors };
}

// Las propiedades CSS de un tema YA validado. Lo que no está aquí no se toca.
export function themeProperties(theme) {
  const out = [];
  if (!theme) return out;
  for (const [k, v] of Object.entries(theme.colors || {})) if (Object.hasOwn(COLORS, k) && HEX.test(v)) out.push([COLORS[k], hex6(v)]);
  if (Object.hasOwn(RADIUS, theme.radius ?? '')) RADIUS[theme.radius].forEach((v, i) => out.push([`--ef-r${i + 1}`, v]));
  if (Object.hasOwn(DENSITY, theme.density ?? '')) SPACING.forEach((v, i) => out.push([`--ef-s${i + 1}`, `${Math.round(v * DENSITY[theme.density])}px`]));
  if (Object.hasOwn(FONTS, theme.font ?? '')) out.push(['--ef-font', FONTS[theme.font]]);
  return out;
}

export function themeTexts(theme, lang) {
  const out = {};
  for (const [k, v] of Object.entries(theme?.texts?.[lang] || {})) if (textAllowed(k) && typeof v === 'string' && !/[<>&]/.test(v)) out[k] = v;
  return out;
}
