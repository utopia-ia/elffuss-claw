// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Spanish text to the phonemes Kokoro's Spanish voices were trained on. Kokoro
// phonemised Spanish with eSpeak NG ("es", Castilian) and a small mapping of
// misaki (t^ʃ → ʧ, a^ɪ → I, e^ɪ → A, a^ʊ → W); Spanish spelling is regular
// enough to give the same symbols by rule, so eSpeak NG (GPL) is not shipped.
// What the rules follow, as eSpeak NG writes it:
//  - the stress mark goes right before the stressed vowel (after any glide),
//    from the written accent or the usual rule (vowel, n or s: next to last
//    syllable; otherwise the last); long words take a secondary mark on the
//    first syllable; short function words take none;
//  - b, d, g soften to β, ð, ɣ after a vowel or a consonant, across words too,
//    but not after a pause or m/n; a final d stays d;
//  - c/z before e, i → θ; ll → ʎ; y → ʝ (i at the end or alone); j and g before
//    e, i → x; ch → ʧ; ñ → ɲ; r → r at the start, after n, l, s and as rr, else ɾ;
//    n → m before b, p, v and → ŋ before g, j in the word; x → ks (s at the start);
//  - unstressed i, u next to a vowel are glides (j, w); ai/ay → I, ei/ey → A,
//    oi/oy → oɪ, au → W, eu → eʊ.
// Pure; the tests compare it with eSpeak NG's output for a list of sentences.

import { spellNumbers } from './numbers.js';

const STRONG = 'aeo';
const ACCENT = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u' };
/** Words eSpeak NG leaves unstressed. */
export const UNSTRESSED = new Set('el la los las lo le les de del a al en con y e o u que por sin si mi mis tu tus su sus nos os me te se ni'.split(' '));
/** Words that take a secondary stress only. */
export const SECONDARY = new Set('para pero como hasta desde sobre entre según mientras'.split(' '));
const X_AS_J = new Set(['méxico', 'mexicano', 'mexicana', 'mexicanos', 'mexicanas', 'texas', 'oaxaca', 'xavier']);

/**
 * Units of one word: consonant phonemes and vowel slots { v, acc } in order.
 * @param {string} w lower-case word
 */
function units(w) {
  const out = [];
  const isV = c => 'aeiouáéíóúü'.includes(c);
  for (let i = 0; i < w.length; i++) {
    const c = w[i], n = w[i + 1] || '', n2 = w[i + 2] || '';
    const front = 'eiéí'.includes(n);
    if (isV(c)) {
      if (c === 'ü') { out.push({ v: 'u', acc: false, hiatus: true }); continue; }
      out.push({ v: ACCENT[c] || c, acc: c in ACCENT });
      continue;
    }
    switch (c) {
      case 'b': case 'v': out.push({ c: 'B' }); break;
      case 'c':
        if (n === 'h') { out.push({ c: 'ʧ' }); i++; } else out.push({ c: front ? 'θ' : 'k' });
        break;
      case 'z': out.push({ c: 'θ' }); break;
      case 'q': out.push({ c: 'k' }); if (n === 'u' && 'eiéí'.includes(n2)) i++; break;
      case 'g':
        if (front) out.push({ c: 'x' });
        else { out.push({ c: 'G' }); if (n === 'u' && 'eiéí'.includes(n2)) i++; }
        break;
      case 'j': out.push({ c: 'x' }); break;
      case 'd': out.push({ c: 'D' }); break;
      case 'h': break;
      case 'l': if (n === 'l') { out.push({ c: 'ʎ' }); i++; } else out.push({ c: 'l' }); break;
      case 'ñ': out.push({ c: 'ɲ' }); break;
      case 'r': {
        const prev = out.at(-1);
        if (n === 'r') { out.push({ c: 'r' }); i++; }
        else out.push({ c: (!prev || (prev.c && 'nls'.includes(prev.c))) ? 'r' : 'ɾ' });
        break;
      }
      case 'y':
        if (i === w.length - 1 || (!isV(n) && n !== '')) out.push({ v: 'i', acc: false, y: true });
        else out.push({ c: 'ʝ' });
        break;
      case 'x':
        if (X_AS_J.has(w)) out.push({ c: 'x' });
        else if (i === 0) out.push({ c: 's' });
        else { out.push({ c: 'k' }); out.push({ c: 's' }); }
        break;
      case 'w': out.push({ c: 'w' }); break;
      case 'k': out.push({ c: 'k' }); break;
      case 'n': {
        const nx = w[i + 1];
        if (nx && 'bpvm'.includes(nx) && nx !== 'm') out.push({ c: 'm' });
        else if (nx === 'j' || nx === 'g' || (nx === 'x' && X_AS_J.has(w))) out.push({ c: 'ŋ' });
        else out.push({ c: 'n' });
        break;
      }
      default:
        if (/[a-zç]/.test(c)) out.push({ c: c === 'ç' ? 's' : c });
    }
  }
  return out;
}

/** Group vowel slots into nuclei: [{ items: [vowel slots], main: index }]. */
function nuclei(u) {
  const groups = [];
  for (let i = 0; i < u.length; i++) {
    if (!('v' in u[i])) continue;
    const run = [];
    let j = i;
    while (j < u.length && 'v' in u[j]) run.push(j++);
    // Split a run of vowels into syllables: strong+strong is a hiatus, an accented weak vowel stands alone.
    let cur = [];
    const weak = k => !STRONG.includes(u[k].v) && !u[k].acc && !u[k].hiatus;
    for (const k of run) {
      if (!cur.length) { cur.push(k); continue; }
      const prev = cur[cur.length - 1];
      const join = (weak(prev) || weak(k)) && !(u[k].acc && !STRONG.includes(u[k].v)) && !(u[prev].acc && !STRONG.includes(u[prev].v))
        && !(weak(prev) && weak(k) && cur.length > 1);
      if (join && cur.length < 3) cur.push(k); else { groups.push(cur); cur = [k]; }
    }
    if (cur.length) groups.push(cur);
    i = j - 1;
  }
  return groups.map(items => {
    let main = items.findIndex(k => u[k].acc);
    if (main < 0) main = items.findIndex(k => STRONG.includes(u[k].v));
    if (main < 0 && items.length > 1 && u[items.at(-1)].y) main = items.length - 2;
    if (main < 0) main = items.length > 1 && u[items[0]].v === 'u' && u[items[1]].v === 'i' ? 1 : (items.length > 1 && u[items[0]].v === 'i' ? 1 : 0);
    return { items, main };
  });
}

/** Which nucleus takes the stress, by accent or by rule. */
function stressedIndex(word, groups, u) {
  const acc = groups.findIndex(g => g.items.some(k => u[k].acc));
  if (acc >= 0) return acc;
  if (groups.length < 2) return groups.length - 1;
  const last = word.at(-1);
  return 'aeiounsy'.includes(last) ? groups.length - 2 : groups.length - 1;
}

const DIPH = { ai: 'I', ei: 'A', au: 'W', oi: 'oɪ', eu: 'eʊ', ou: 'O' };

/**
 * Phonemes of one word with B, D, G still to resolve (stop or fricative) by context.
 * @param {string} word lower case, letters only
 * @param {'primary'|'secondary'|'none'} [stress]
 */
export function wordPhonemes(word, stress = 'primary') {
  if (word.length > 5 && word.endsWith('mente') && word !== 'mente') {
    const base = word.slice(0, -5);
    const b = wordPhonemes(base, /[áéíóú]/.test(base) || base.length > 1 ? stress : 'none');
    return b + wordPhonemes('mente', stress);
  }
  const u = units(word);
  // A final d is a stop (ciudad → θjuðˈad).
  if (u.at(-1)?.c === 'D') u[u.length - 1] = { c: 'd' };
  const groups = nuclei(u);
  if (!groups.length) return u.map(x => x.c || '').join('');
  const s = stressedIndex(word, groups, u);
  const marks = new Map();
  if (stress === 'primary') {
    marks.set(s, 'ˈ');
    if (s >= 2) marks.set(0, 'ˌ');
  } else if (stress === 'secondary') marks.set(s, 'ˌ');
  const nucleusOf = new Map();
  groups.forEach((g, gi) => g.items.forEach((k, ii) => nucleusOf.set(k, { gi, ii, g })));
  let out = '';
  for (let k = 0; k < u.length; k++) {
    const x = u[k];
    if (!('v' in x)) { out += x.c; continue; }
    const { gi, ii, g } = nucleusOf.get(k);
    const mark = marks.get(gi) || '';
    // A falling diphthong becomes one symbol (mapped as Kokoro learnt it).
    if (ii === g.main && g.items.length >= 2 && ii + 1 < g.items.length) {
      const next = u[g.items[ii + 1]];
      const d = DIPH[x.v + next.v];
      if (d && (ii + 2 === g.items.length)) { out += mark + d; k = g.items[ii + 1]; continue; }
    }
    if (ii < g.main) out += x.v === 'i' ? 'j' : x.v === 'u' ? 'w' : x.v;
    else if (ii === g.main) out += mark + x.v;
    else out += x.v === 'i' ? (x.y ? 'j' : 'j') : x.v === 'u' ? 'w' : x.v;
  }
  return out;
}

const SOFT = { B: ['b', 'β'], D: ['d', 'ð'], G: ['ɡ', 'ɣ'] };
/** Resolve B, D, G across a phrase: a stop after a pause, m, n (and l for B, G), else a fricative. */
function resolveStops(ps) {
  let out = '';
  let prev = null; // last phoneme letter, or null after a pause
  for (const ch of ps) {
    if (SOFT[ch]) {
      const stop = prev === null || prev === 'm' || prev === 'n' || prev === 'ŋ';
      out += SOFT[ch][stop ? 0 : 1];
      prev = ch;
      continue;
    }
    out += ch;
    if (/[,.;:!?¡¿—…()"“”]/.test(ch)) prev = null;
    else if (!/[\sˈˌ]/.test(ch)) prev = ch;
  }
  return out;
}

/**
 * Spanish text to Kokoro phonemes.
 * @param {string} text
 * @returns {string}
 */
export function spanishToPhonemes(text) {
  const t = spellNumbers(String(text).normalize('NFC'), 'es')
    .replace(/[«»]/g, '"').replace(/[‘’´`]/g, "'").replace(/\s+/g, ' ').trim();
  const tokens = t.match(/[\p{L}]+|[,.;:!?¡¿—…()"“”-]|\S/gu) || [];
  const parts = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (/^\p{L}+$/u.test(tok)) {
      const w = tok.toLowerCase();
      const stress = UNSTRESSED.has(w) ? 'none' : SECONDARY.has(w) ? 'secondary' : 'primary';
      let ps = w === 'y' ? 'i' : wordPhonemes(w, stress);
      // n before b, p, v, m of the next word sounds m.
      const next = tokens[i + 1];
      if (ps.endsWith('n') && next && /^[bpvBPV]/.test(next)) ps = ps.slice(0, -1) + 'm';
      parts.push({ ps, word: true });
    } else if (/[,.;:!?—…()"“”]/.test(tok)) parts.push({ ps: tok === '-' ? '' : tok, word: false });
    else if (tok === '-') parts.push({ ps: '', word: false });
  }
  let s = '';
  for (const p of parts) {
    if (!p.ps) continue;
    if (p.word) s += (s && !s.endsWith(' ') && !/[(“"]$/.test(s) ? ' ' : '') + p.ps;
    else if (/[(“]/.test(p.ps)) s += (s ? ' ' : '') + p.ps;
    else s += p.ps;
  }
  return resolveStops(s).replace(/\s+/g, ' ').trim();
}
