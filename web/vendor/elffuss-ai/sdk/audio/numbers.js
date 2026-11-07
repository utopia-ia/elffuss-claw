// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Numbers as words, in Spanish and English, so that the speech task reads them
// out: cardinals up to the trillions, decimals, ordinals of English (1st, 2nd)
// and of Spanish (1.º, 1.ª), years and a few symbols. Pure.

const ES_UNITS = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const ES_TENS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const ES_HUNDREDS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

function esBelow1000(n) {
  if (n === 100) return 'cien';
  const h = Math.floor(n / 100), r = n % 100;
  const parts = [];
  if (h) parts.push(ES_HUNDREDS[h]);
  if (r) {
    if (r < 30) parts.push(ES_UNITS[r]);
    else parts.push(ES_TENS[Math.floor(r / 10)] + (r % 10 ? ' y ' + ES_UNITS[r % 10] : ''));
  }
  return parts.join(' ');
}

/** A whole number in Spanish words ("uno" stays "uno"; before a noun, "un" is the caller's choice). */
export function spanishNumber(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 0) return 'menos ' + spanishNumber(-n);
  n = Math.floor(n);
  if (n < 1000) return n === 0 ? 'cero' : esBelow1000(n);
  const scales = [[1e12, 'billón', 'billones'], [1e6, 'millón', 'millones']];
  for (const [v, one, many] of scales) {
    if (n >= v) {
      const q = Math.floor(n / v), r = n % v;
      const head = q === 1 ? 'un ' + one : spanishNumber(q).replace(/uno$/, 'un') + ' ' + many;
      return r ? head + ' ' + spanishNumber(r) : head;
    }
  }
  const q = Math.floor(n / 1000), r = n % 1000;
  const head = q === 1 ? 'mil' : spanishNumber(q).replace(/veintiuno$/, 'veintiún').replace(/uno$/, 'un') + ' mil';
  return r ? head + ' ' + esBelow1000(r) : head;
}

const EN_UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function enBelow1000(n) {
  const h = Math.floor(n / 100), r = n % 100;
  const parts = [];
  if (h) parts.push(EN_UNITS[h] + ' hundred');
  if (r) {
    if (h) parts.push('and');
    parts.push(r < 20 ? EN_UNITS[r] : EN_TENS[Math.floor(r / 10)] + (r % 10 ? '-' + EN_UNITS[r % 10] : ''));
  }
  return parts.join(' ');
}

/** A whole number in English words, British style "and" after hundreds as num2words does. */
export function englishNumber(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 0) return 'minus ' + englishNumber(-n);
  n = Math.floor(n);
  if (n === 0) return 'zero';
  const out = [];
  for (const [v, name] of [[1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]) {
    if (n >= v) { out.push(enBelow1000(Math.floor(n / v)) + ' ' + name); n %= v; }
  }
  if (n) out.push(n < 100 && out.length ? 'and ' + enBelow1000(n) : enBelow1000(n));
  return out.join(' ');
}

const EN_ORD = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
/** An English ordinal ("twenty-first"). */
export function englishOrdinal(n) {
  const w = englishNumber(n);
  return w.replace(/([a-z]+)$/, last => EN_ORD[last] || (last.endsWith('y') ? last.slice(0, -1) + 'ieth' : last + 'th'));
}

/** A year read the English way: 1984 → nineteen eighty-four, 2005 → two thousand and five. */
export function englishYear(n) {
  if (n >= 1100 && n < 2000 && n % 100 !== 0) return `${englishNumber(Math.floor(n / 100))} ${n % 100 < 10 ? 'oh ' + englishNumber(n % 100) : englishNumber(n % 100)}`;
  if (n >= 2010 && n < 2100) return `${englishNumber(Math.floor(n / 100))} ${englishNumber(n % 100)}`;
  if (n % 100 === 0 && n >= 1100 && n < 2000) return `${englishNumber(n / 100)} hundred`;
  return englishNumber(n);
}

const ES_ORD = ['', 'primero', 'segundo', 'tercero', 'cuarto', 'quinto', 'sexto', 'séptimo', 'octavo', 'noveno', 'décimo'];

/**
 * Text with its numbers (and %, €, $, &, +, @) in words.
 * @param {string} text
 * @param {'es'|'en'} lang
 */
export function spellNumbers(text, lang) {
  const es = lang === 'es';
  let t = String(text);
  // Ordinals.
  t = es
    ? t.replace(/\b(\d{1,2})\.?\s?([ºª])/g, (m, d, g) => { const w = ES_ORD[Number(d)]; return w ? (g === 'ª' ? w.replace(/o$/, 'a') : w) : m; })
    : t.replace(/\b(\d+)(st|nd|rd|th)\b/gi, (m, d) => englishOrdinal(Number(d)));
  // Money and percentages.
  const cur = es ? { '€': ['euro', 'euros'], '$': ['dólar', 'dólares'], '£': ['libra', 'libras'] } : { '€': ['euro', 'euros'], '$': ['dollar', 'dollars'], '£': ['pound', 'pounds'] };
  t = t.replace(/([€$£])\s?(\d[\d.,]*)|(\d[\d.,]*)\s?([€$£])/g, (m, c1, n1, n2, c2) => {
    const c = c1 || c2, raw = n1 || n2, n = raw.replace(/[.,]$/, '');
    const v = parseNumber(n, es);
    return `${n} ${Math.abs(v) === 1 ? cur[c][0] : cur[c][1]}${c1 && n !== raw ? raw.at(-1) : ''}`;
  });
  t = t.replace(/(\d)\s?%/g, (m, d) => `${d} ${es ? 'por ciento' : 'percent'}`);
  t = t.replace(/\s&\s/g, es ? ' y ' : ' and ').replace(/(\w)\+(\w)/g, `$1 ${es ? 'más' : 'plus'} $2`).replace(/(\w)@(\w)/g, `$1 ${es ? 'arroba' : 'at'} $2`);
  // Numbers: thousands separators and decimals as each language writes them.
  t = t.replace(/-?\d+(?:[.,]\d+)*/g, m => {
    const neg = m.startsWith('-');
    const s = neg ? m.slice(1) : m;
    const v = parseNumber(s, es);
    const isYear = !es && /^\d{4}$/.test(s) && v >= 1100 && v < 2100;
    let words;
    if (Number.isInteger(v)) words = isYear ? englishYear(v) : es ? spanishNumber(v) : englishNumber(v);
    else {
      const [i, d] = String(v).split('.');
      const whole = es ? spanishNumber(Number(i)) : englishNumber(Number(i));
      const frac = d.length <= 2 && !d.startsWith('0') ? (es ? spanishNumber(Number(d)) : englishNumber(Number(d))) : [...d].map(x => (es ? spanishNumber(Number(x)) : englishNumber(Number(x)))).join(' ');
      words = `${whole} ${es ? 'coma' : 'point'} ${frac}`;
    }
    return (neg ? (es ? 'menos ' : 'minus ') : '') + words;
  });
  return t;
}

/** Read "1.234,5" (Spanish) or "1,234.5" (English); a lone separator before three digits groups thousands. */
export function parseNumber(s, es) {
  const group = es ? '.' : ',', dec = es ? ',' : '.';
  let x = s;
  if (new RegExp(`^\\d{1,3}(\\${group}\\d{3})+(\\${dec}\\d+)?$`).test(x)) x = x.split(group).join('');
  x = x.replace(dec, '.');
  const v = Number(x.replace(/[^\d.]/g, ''));
  return Number.isFinite(v) ? v : 0;
}
