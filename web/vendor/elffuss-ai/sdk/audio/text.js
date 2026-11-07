// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Long text for the speech task: sentences (with the pause that follows each),
// then chunks the model can read in one go. Kokoro reads at most 510 phonemes at
// a time and sounds best a sentence or a few at a time, so sentences are packed
// up to a budget, and a sentence over it is cut at a comma, a semicolon or, at
// worst, a space. Pure.

/** Most phonemes Kokoro takes in one pass. */
export const MAX_PHONEMES = 510;
/** Phonemes a chunk is filled up to (room for the joins). */
export const CHUNK_PHONEMES = 400;

const ABBR = new Set(['sr', 'sra', 'srta', 'dr', 'dra', 'd', 'dña', 'ud', 'uds', 'etc', 'p. ej', 'mr', 'mrs', 'ms', 'st', 'vs', 'e.g', 'i.e', 'no', 'núm', 'pág', 'av', 'avda']);

/** Seconds of pause after a piece that ends in this character. */
export function pauseAfter(text, paragraphEnd = false) {
  if (paragraphEnd) return 0.6;
  const c = String(text).trim().replace(/["”»')\]]+$/, '').at(-1) || '';
  if ('.!?…'.includes(c)) return 0.32;
  if (':;'.includes(c)) return 0.24;
  if (',—'.includes(c)) return 0.16;
  return 0.12;
}

/**
 * Split text into sentences, each with the pause after it.
 * @param {string} text
 * @returns {{ text: string, pause: number }[]}
 */
export function sentences(text) {
  const out = [];
  const paragraphs = String(text).replace(/\r\n?/g, '\n').split(/\n\s*\n|\n(?=\s*[-•*]\s)/);
  paragraphs.forEach((para, pi) => {
    const p = para.replace(/\s+/g, ' ').trim();
    if (!p) return;
    const parts = [];
    let cur = '';
    const re = /([.!?…]+["”»')\]]*)(\s+|$)/g;
    let last = 0, m;
    while ((m = re.exec(p))) {
      const piece = p.slice(last, m.index + m[1].length);
      const word = (/([\p{L}.]+)[.]$/u.exec(piece)?.[1] || '').toLowerCase().replace(/\.$/, '');
      cur += piece;
      last = m.index + m[0].length;
      const abbr = m[1] === '.' && (ABBR.has(word) || /^\p{L}$/u.test(word) || /\d$/.test(piece) && /^\d/.test(p.slice(last)));
      if (!abbr) { parts.push(cur.trim()); cur = ''; } else cur += ' ';
    }
    cur += p.slice(last);
    if (cur.trim()) parts.push(cur.trim());
    parts.forEach((s, i) => out.push({ text: s, pause: pauseAfter(s, i === parts.length - 1 && pi < paragraphs.length - 1) }));
  });
  return out;
}

/**
 * Cut a phoneme string that is too long, at the last comma or semicolon before
 * the limit, else the last space, else hard.
 * @param {string} ps
 * @param {number} [max]
 * @returns {string[]}
 */
export function cutPhonemes(ps, max = MAX_PHONEMES) {
  const out = [];
  let rest = ps.trim();
  while ([...rest].length > max) {
    const head = [...rest].slice(0, max).join('');
    let at = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '));
    if (at < max * 0.3) at = head.lastIndexOf(' ');
    if (at < 1) at = head.length - 1;
    out.push(head.slice(0, at + 1).trim());
    rest = rest.slice(at + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Pack phonemised sentences into chunks: whole sentences up to `budget`
 * phonemes; one too long is cut. Each chunk keeps the pause of its last sentence.
 * @param {{ ps: string, pause: number }[]} items
 * @returns {{ ps: string, pause: number }[]}
 */
export function packChunks(items, budget = CHUNK_PHONEMES) {
  const out = [];
  let cur = null;
  for (const it of items) {
    const ps = it.ps.trim();
    if (!ps) continue;
    if ([...ps].length > MAX_PHONEMES) {
      if (cur) { out.push(cur); cur = null; }
      const pieces = cutPhonemes(ps);
      pieces.forEach((p, i) => out.push({ ps: p, pause: i < pieces.length - 1 ? 0.16 : it.pause }));
      continue;
    }
    // A long pause (end of paragraph) closes the chunk.
    if (cur && [...cur.ps].length + 1 + [...ps].length <= budget && cur.pause < 0.5) cur = { ps: cur.ps + ' ' + ps, pause: it.pause };
    else { if (cur) out.push(cur); cur = { ps, pause: it.pause }; }
  }
  if (cur) out.push(cur);
  return out;
}
