// SPDX-License-Identifier: Apache-2.0 AND Apache-2.0
// Copyright (c) 2026 UtopiaIA
// Follows the lexicon rules of misaki (github.com/hexgrad/misaki, misaki/en.py,
// Apache-2.0, by hexgrad), the phonemiser Kokoro was trained with: its US word
// lists (gold, then silver, both grown with capitalised forms), the -s, -ed and
// -ing endings, letters read one by one for acronyms, the special cases of a,
// an, the, to, in and I by what follows, and its stress rules. Rewritten in
// JavaScript without spaCy, so without part-of-speech tags: a word with several
// readings takes its default one. Numbers are spelt out before (numbers.js).
// Words the lists do not have go to the fallback (the small network of misaki,
// run by speech-impl.js). Pure: the lists and the fallback are passed in.

import { spellNumbers } from './numbers.js';

const STRESSES = 'ˌˈ', PRIMARY = 'ˈ', SECONDARY = 'ˌ';
const VOWELS = new Set('AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ');
const CONSONANTS = new Set('bdfhjklmnpstvwzðŋɡɹɾʃʒʤʧθ');
const US_TAUS = new Set('AIOWYiuæɑəɛɪɹʊʌ');
const PUNCTS = new Set(';:,.!?—…"“”');
const SYMBOLS = { '%': 'percent', '&': 'and', '+': 'plus', '@': 'at' };

/** misaki's apply_stress. */
export function applyStress(ps, stress) {
  const restress = p => {
    const ips = [...p].map((c, i) => [i, c]);
    for (let i = 0; i < ips.length; i++) {
      if (!STRESSES.includes(ips[i][1])) continue;
      const j = ips.findIndex(([k, c], idx) => idx >= i && VOWELS.has(c));
      if (j >= 0) ips[i][0] = j - 0.5;
    }
    return ips.sort((a, b) => a[0] - b[0]).map(x => x[1]).join('');
  };
  if (ps == null || stress == null) return ps;
  const has = c => ps.includes(c);
  if (stress < -1) return ps.replaceAll(PRIMARY, '').replaceAll(SECONDARY, '');
  if (stress === -1 || ((stress === 0 || stress === -0.5) && has(PRIMARY))) return ps.replaceAll(SECONDARY, '').replaceAll(PRIMARY, SECONDARY);
  if ((stress === 0 || stress === 0.5 || stress === 1) && ![...STRESSES].some(has)) return [...ps].some(c => VOWELS.has(c)) ? restress(SECONDARY + ps) : ps;
  if (stress >= 1 && !has(PRIMARY) && has(SECONDARY)) return ps.replace(SECONDARY, PRIMARY);
  if (stress > 1 && ![...STRESSES].some(has)) return [...ps].some(c => VOWELS.has(c)) ? restress(PRIMARY + ps) : ps;
  return ps;
}

/** misaki's grow_dictionary: lower-case entries also as Capitalised, and the other way. */
function grow(d) {
  const e = new Map();
  for (const [k, v] of Object.entries(d)) {
    if (k.length < 2) continue;
    const cap = k[0].toUpperCase() + k.slice(1);
    if (k === k.toLowerCase()) { if (k !== cap) e.set(cap, v); }
    else if (k === k[0].toUpperCase() + k.slice(1).toLowerCase()) e.set(k.toLowerCase(), v);
  }
  for (const [k, v] of Object.entries(d)) e.set(k, v);
  return e;
}

const isAlpha = w => /^[A-Za-z]+$/.test(w);
const LEXICON_CHARS = /^[A-Za-z'-]+$/;

/**
 * An English (US) phonemiser over misaki's lists.
 * @param {{ gold: Record<string, string|Record<string, string|null>>, silver: Record<string, string> }} lists
 */
export function createEnglish(lists) {
  const golds = grow(lists.gold), silvers = grow(lists.silver);
  const pick = v => (v && typeof v === 'object' ? v.DEFAULT ?? null : v);

  const getNNP = word => {
    const ps = [...word].filter(c => /[A-Za-z]/.test(c)).map(c => pick(golds.get(c.toUpperCase())));
    if (ps.some(p => p == null)) return null;
    const joined = applyStress(ps.join(''), 0);
    const i = joined.lastIndexOf(SECONDARY);
    return i < 0 ? joined : joined.slice(0, i) + PRIMARY + joined.slice(i + 1);
  };
  const isKnown = word => {
    if (golds.has(word) || silvers.has(word) || word in SYMBOLS) return true;
    if (!isAlpha(word)) return false;
    if (word.length === 1) return true;
    if (word === word.toUpperCase() && golds.has(word.toLowerCase())) return true;
    return word.slice(1) === word.slice(1).toUpperCase();
  };
  const lookup = (word, stress) => {
    let nnp = false;
    if (word === word.toUpperCase() && !golds.has(word)) { word = word.toLowerCase(); nnp = false; }
    let ps = pick(golds.get(word));
    if (ps == null && !nnp) ps = pick(silvers.get(word));
    if (ps == null) return getNNP(word);
    return applyStress(ps, stress);
  };
  const _s = st => (!st ? null : 'ptkfθ'.includes(st.at(-1)) ? st + 's' : 'szʃʒʧʤ'.includes(st.at(-1)) ? st + 'ᵻz' : st + 'z');
  const _ed = st => {
    if (!st) return null;
    const l = st.at(-1);
    if ('pkfθʃsʧ'.includes(l)) return st + 't';
    if (l === 'd') return st + 'ᵻd';
    if (l !== 't') return st + 'd';
    if (st.length < 2) return st + 'ɪd';
    if (US_TAUS.has(st.at(-2))) return st.slice(0, -1) + 'ɾᵻd';
    return st + 'ᵻd';
  };
  const _ing = st => (!st ? null : st.length > 1 && st.at(-1) === 't' && US_TAUS.has(st.at(-2)) ? st.slice(0, -1) + 'ɾɪŋ' : st + 'ɪŋ');
  const stemS = (w, stress) => {
    if (w.length < 3 || !w.endsWith('s')) return null;
    let stem;
    if (!w.endsWith('ss') && isKnown(w.slice(0, -1))) stem = w.slice(0, -1);
    else if ((w.endsWith("'s") || (w.length > 4 && w.endsWith('es') && !w.endsWith('ies'))) && isKnown(w.slice(0, -2))) stem = w.slice(0, -2);
    else if (w.length > 4 && w.endsWith('ies') && isKnown(w.slice(0, -3) + 'y')) stem = w.slice(0, -3) + 'y';
    else return null;
    return _s(lookup(stem, stress));
  };
  const stemEd = (w, stress) => {
    if (w.length < 4 || !w.endsWith('d')) return null;
    let stem;
    if (!w.endsWith('dd') && isKnown(w.slice(0, -1))) stem = w.slice(0, -1);
    else if (w.length > 4 && w.endsWith('ed') && !w.endsWith('eed') && isKnown(w.slice(0, -2))) stem = w.slice(0, -2);
    else return null;
    return _ed(lookup(stem, stress));
  };
  const stemIng = (w, stress) => {
    if (w.length < 5 || !w.endsWith('ing')) return null;
    let stem;
    if (w.length > 5 && isKnown(w.slice(0, -3))) stem = w.slice(0, -3);
    else if (isKnown(w.slice(0, -3) + 'e')) stem = w.slice(0, -3) + 'e';
    else if (w.length > 5 && /([bcdgklmnprstvxz])\1ing$|cking$/.test(w) && isKnown(w.slice(0, -4))) stem = w.slice(0, -4);
    else return null;
    return _ing(lookup(stem, stress));
  };

  /** One word to phonemes with misaki's lexicon, or null. `next` is whether the next word starts with a vowel (null at the end). */
  function word(w0, futureVowel) {
    let w = w0.replace(/[‘’]/g, "'");
    const stress = w === w.toLowerCase() ? null : w === w.toUpperCase() ? 2 : 0.5;
    // Special cases (without tags: the common reading).
    if (w in SYMBOLS) return lookup(SYMBOLS[w], null);
    if (w === 'a' || w === 'A') return w === 'A' && futureVowel === undefined ? 'ˈA' : 'ɐ';
    if (w === 'an' || w === 'An') return 'ɐn';
    if (w === 'I') return SECONDARY + 'I';
    if (w === 'to' || w === 'To') return futureVowel == null ? pick(golds.get('to')) : futureVowel ? 'tʊ' : 'tə';
    if (w === 'the' || w === 'The') return futureVowel === true ? 'ði' : 'ðə';
    if (w === 'in' || w === 'In') return (futureVowel == null ? PRIMARY : '') + 'ɪn';
    if (/^[A-Za-z]{1,2}(\.[A-Za-z]{1,2})+\.?$/.test(w)) return getNNP(w);
    const wl = w.toLowerCase();
    if (w.length > 1 && isAlpha(w.replace(/'/g, '')) && w !== wl && !golds.has(w) && !silvers.has(w)
      && (w === w.toUpperCase() || w.slice(1) === w.slice(1).toLowerCase())
      && (golds.has(wl) || silvers.has(wl) || stemS(wl, stress) || stemEd(wl, stress) || stemIng(wl, stress))) w = wl;
    let ps = null;
    if (isKnown(w)) ps = lookup(w, stress);
    else if (w.endsWith("s'") && isKnown(w.slice(0, -2) + "'s")) ps = lookup(w.slice(0, -2) + "'s", stress);
    else if (w.endsWith("'") && isKnown(w.slice(0, -1))) ps = lookup(w.slice(0, -1), stress);
    else ps = stemS(w, stress) ?? stemEd(w, stress) ?? stemIng(w, stress == null ? 0.5 : stress);
    return ps;
  }
  return { word, lookup, golds, silvers };
}

/**
 * English text to Kokoro phonemes.
 * @param {ReturnType<typeof createEnglish>} en
 * @param {string} text
 * @param {(word: string) => Promise<string>} fallback phonemes of a word the lists lack
 * @returns {Promise<string>}
 */
export async function englishToPhonemes(en, text, fallback) {
  const t = spellNumbers(String(text).normalize('NFKC'), 'en').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  const tokens = t.match(/[A-Za-z]+(?:'[A-Za-z]+)*'?|[;:,.!?—…"“”()]|-+|\S/g) || [];
  const out = new Array(tokens.length).fill('');
  let futureVowel = null; // the first phoneme of what follows: vowel (true), consonant (false), pause (null)
  for (let i = tokens.length - 1; i >= 0; i--) {
    const tok = tokens[i];
    if (PUNCTS.has(tok) || tok === '(' || tok === ')') { out[i] = tok; futureVowel = null; continue; }
    if (/^-+$/.test(tok)) { out[i] = tok.length > 1 ? '—' : ''; if (tok.length > 1) futureVowel = null; continue; }
    if (!/[A-Za-z]/.test(tok)) { out[i] = ''; continue; }
    let ps = en.word(tok, futureVowel);
    if (ps == null) ps = await fallback(tok);
    ps = (ps || '').replace(/ɾ/g, 'T').replace(/ʔ/g, 't');
    out[i] = ps;
    const first = [...ps].find(c => VOWELS.has(c) || CONSONANTS.has(c) || 'T'.includes(c));
    if (first) futureVowel = VOWELS.has(first);
  }
  let s = '';
  tokens.forEach((tok, i) => {
    const p = out[i];
    if (!p) return;
    const punct = PUNCTS.has(tok) || tok === ')' ;
    if (punct && tok !== '“' && tok !== '"') s += p;
    else s += (s && !/[ (“]$/.test(s) ? ' ' : '') + p;
  });
  return s.replace(/\s+/g, ' ').trim();
}
