// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The UMT5 tokenizer Wan 2.1 uses (google/umt5-xxl, the tokenizer.json in the
// Wan-AI repository): the prompt is cleaned the way Wan cleans it (ftfy's fixes
// that matter for typed text, HTML entities undone twice, runs of white space
// made one space), split at spaces into words that start with "▁", each word cut
// into the vocabulary's pieces by the Unigram model's best path (Viterbi), and
// "</s>" appended. No dependencies; the vocabulary comes from tokenizer.json.

const UNK_PENALTY = 10;
const EOS_ID = 1;

/** Characters ftfy turns into plain quotes and ligatures it spells out. */
const QUOTES = { '‘': "'", '’': "'", '‚': "'", '‛': "'", '“': '"', '”': '"', '„': '"', '‟': '"', '′': "'", '″': '"' };
const LIGATURES = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'ſt', 'ﬆ': 'st', 'Ĳ': 'IJ', 'ĳ': 'ij', 'Ǉ': 'LJ', 'ǈ': 'Lj', 'ǉ': 'lj', 'Ǌ': 'NJ', 'ǋ': 'Nj', 'ǌ': 'nj' };
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', iexcl: '¡', iquest: '¿', ntilde: 'ñ', Ntilde: 'Ñ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', uuml: 'ü', Uuml: 'Ü', ccedil: 'ç', Ccedil: 'Ç', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', deg: '°' };

function unescapeHtml(s) {
  return s.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[A-Za-z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/**
 * The prompt as Wan's tokenizer wrapper cleans it (`whitespace_clean(basic_clean(text))`):
 * the subset of ftfy.fix_text that typed prompts meet (quotes, ligatures, full-width
 * forms, control characters, line breaks, NFC), HTML entities undone twice, white
 * space collapsed and trimmed.
 * @param {string} text
 */
export function cleanPrompt(text) {
  let s = String(text ?? '');
  s = s.replace(/\r\n?|\u2028|\u2029|\u0085/g, '\n');
  s = s.replace(/[‘-‟′″]/g, c => QUOTES[c] ?? c);
  s = s.replace(/[ﬀ-ﬆĲĳǇ-ǌ]/g, c => LIGATURES[c] ?? c);
  s = s.replace(/[！-～　]/g, c => c.normalize('NFKC'));
  s = s.replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f﻿￹-￼]/g, '');
  s = s.normalize('NFC');
  s = unescapeHtml(unescapeHtml(s)).trim();
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * A tokenizer from the parsed tokenizer.json of umt5-xxl.
 * @param {{ model: { type: string, vocab: [string, number][], unk_id: number } }} json
 */
export function createTokenizer(json) {
  const model = json?.model;
  if (model?.type !== 'Unigram' || !Array.isArray(model.vocab)) throw new TypeError('not a Unigram tokenizer.json');
  const pieces = new Map();
  let minScore = Infinity, maxLen = 0;
  model.vocab.forEach(([piece, score], id) => {
    if (!pieces.has(piece)) pieces.set(piece, { id, score });
    if (score < minScore) minScore = score;
    if (piece.length > maxLen) maxLen = piece.length;
  });
  const unkId = model.unk_id ?? 3;
  const unkScore = minScore - UNK_PENALTY;

  /** Best segmentation of one word (Viterbi over code points), unknown runs fused into one <unk>. */
  function word(w) {
    const chars = Array.from(w);
    const n = chars.length;
    const best = new Float64Array(n + 1).fill(-Infinity);
    const from = new Int32Array(n + 1).fill(-1);
    const ids = new Int32Array(n + 1);
    best[0] = 0;
    for (let i = 0; i < n; i++) {
      if (best[i] === -Infinity) continue;
      let sub = '';
      let found = false;
      for (let j = i; j < n && sub.length < maxLen; j++) {
        sub += chars[j];
        const p = pieces.get(sub);
        if (p) {
          found = j === i || found;
          const sc = best[i] + p.score;
          if (sc > best[j + 1]) { best[j + 1] = sc; from[j + 1] = i; ids[j + 1] = p.id; }
        }
      }
      if (!pieces.has(chars[i])) {
        const sc = best[i] + unkScore;
        if (sc > best[i + 1]) { best[i + 1] = sc; from[i + 1] = i; ids[i + 1] = unkId; }
      }
    }
    const out = [];
    for (let k = n; k > 0; k = from[k]) out.push(ids[k]);
    out.reverse();
    // consecutive unknowns become one, as the Unigram model does
    return out.filter((id, i) => !(id === unkId && out[i - 1] === unkId));
  }

  return {
    /**
     * Token ids of a prompt, with "</s>" at the end, cut to `maxLength` (the end token kept).
     * @param {string} text
     * @param {{ maxLength?: number, clean?: boolean }} [opts]
     */
    encode(text, { maxLength = 512, clean = true } = {}) {
      let s = clean ? cleanPrompt(text) : String(text);
      s = s.replace(/ {2,}/g, ' ');
      const ids = [];
      if (s.length) {
        const spaced = '▁' + s.replace(/ /g, '▁');
        for (const w of spaced.split(/(?=▁)/)) if (w) ids.push(...word(w));
      }
      if (ids.length > maxLength - 1) ids.length = maxLength - 1;
      ids.push(EOS_ID);
      return ids;
    },
    vocabSize: model.vocab.length,
  };
}
