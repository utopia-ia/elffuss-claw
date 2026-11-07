// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The SentencePiece tokenizer of T5Gemma (the text encoder of Stable Audio 3),
// read from its tokenizer.model and encoding as SentencePiece's BPE model does:
// spaces become ▁ (no normalisation, no dummy prefix), the text is split into
// characters (user-defined symbols such as <mask> kept whole), the adjacent pair
// whose join is a piece with the highest score is merged until none is left, and
// what is not a piece falls back to its UTF-8 bytes (<0xNN>). No BOS or EOS is
// added: Stable Audio feeds the ids as SentencePiece's Encode gives them.
// Pure, no DOM; written from the format, no code of SentencePiece is copied.

const NORMAL = 1, UNKNOWN = 2, CONTROL = 3, USER = 4, BYTE = 6;

/** Read the pieces of a SentencePiece ModelProto (field 1: piece, score, type). */
export function parseModel(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let p = 0;
  const varint = () => {
    let v = 0, s = 0, x;
    do { x = b[p++]; v += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80);
    return v;
  };
  const dec = new TextDecoder();
  const pieces = [];
  while (p < b.length) {
    const key = varint(), field = Math.floor(key / 8), wire = key & 7;
    if (wire === 2) {
      const len = varint(), end = p + len;
      if (field === 1) {
        const piece = { piece: '', score: 0, type: NORMAL };
        while (p < end) {
          const k = varint(), f = Math.floor(k / 8), w = k & 7;
          if (f === 1 && w === 2) { const l = varint(); piece.piece = dec.decode(b.subarray(p, p + l)); p += l; }
          else if (f === 2 && w === 5) { piece.score = new DataView(b.buffer, b.byteOffset + p, 4).getFloat32(0, true); p += 4; }
          else if (f === 3 && w === 0) piece.type = varint();
          else skip(w);
        }
        pieces.push(piece);
      }
      p = end;
    } else skip(wire);
  }
  function skip(w) {
    if (w === 0) varint();
    else if (w === 1) p += 8;
    else if (w === 5) p += 4;
    else if (w === 2) { const l = varint(); p += l; }
    else throw new TypeError('not a SentencePiece model');
  }
  if (!pieces.length) throw new TypeError('not a SentencePiece model');
  return pieces;
}

/**
 * The normaliser of a model with SentencePiece's `nmt_nfkc` rule, `remove_extra_whitespaces`
 * and `add_dummy_prefix` (MOSS-TTS-Nano): Unicode NFKC, control characters dropped, every
 * kind of space and line break as one space, the ends trimmed, and one space in front.
 * @param {string} text
 */
export function nmtNfkc(text) {
  const s = String(text).normalize('NFKC')
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f\u200b-\u200d\ufeff]/g, '')
    .replace(/[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g, ' ')
    .trim();
  return s ? ' ' + s : '';
}

/**
 * A tokenizer from a model's pieces.
 * @param {{ piece: string, score: number, type: number }[]} pieces
 * @param {{ normalize?: (text: string) => string }} [o] `normalize`: the model's normaliser
 *   (none for T5Gemma; `nmtNfkc` for MOSS-TTS-Nano)
 */
export function createTokenizer(pieces, { normalize = null } = {}) {
  const normal = new Map(), user = new Map(), bytes = new Map();
  let unk = 0;
  pieces.forEach((x, id) => {
    if (x.type === NORMAL) normal.set(x.piece, { id, score: x.score });
    else if (x.type === USER) user.set(x.piece, id);
    else if (x.type === BYTE) bytes.set(x.piece, id);
    else if (x.type === UNKNOWN) unk = id;
  });
  const users = [...user.keys()].sort((a, b) => b.length - a.length);
  const firstChars = new Set(users.map(u => u[0]));
  const enc = new TextEncoder();
  const hex = n => '<0x' + n.toString(16).toUpperCase().padStart(2, '0') + '>';

  /** @param {string} text @returns {number[]} */
  function encode(text) {
    const s = (normalize ? normalize(String(text)) : String(text)).replace(/ /g, '▁');
    const syms = [];
    for (let i = 0; i < s.length;) {
      if (firstChars.has(s[i])) {
        const u = users.find(x => s.startsWith(x, i));
        if (u) { syms.push({ t: u, fixed: true }); i += u.length; continue; }
      }
      const cp = s.codePointAt(i), ch = String.fromCodePoint(cp);
      syms.push({ t: ch, fixed: false });
      i += ch.length;
    }
    for (;;) {
      let best = -1, bestScore = -Infinity;
      for (let i = 0; i + 1 < syms.length; i++) {
        if (syms[i].fixed || syms[i + 1].fixed) continue;
        const m = normal.get(syms[i].t + syms[i + 1].t);
        if (m && m.score > bestScore) { best = i; bestScore = m.score; }
      }
      if (best < 0) break;
      syms.splice(best, 2, { t: syms[best].t + syms[best + 1].t, fixed: false });
    }
    const ids = [];
    for (const x of syms) {
      if (x.fixed) { ids.push(user.get(x.t)); continue; }
      const n = normal.get(x.t);
      if (n) { ids.push(n.id); continue; }
      for (const byte of enc.encode(x.t)) ids.push(bytes.get(hex(byte)) ?? unk);
    }
    return ids;
  }
  return { encode, size: pieces.length };
}

/**
 * Ids and attention mask of a prompt at a fixed length (pad 0, truncated).
 * @param {{ encode(text: string): number[] }} tok
 * @param {string} text
 * @param {number} length
 * @returns {{ ids: BigInt64Array, mask: BigInt64Array, count: number, truncated: boolean }}
 */
export function encodeFixed(tok, text, length) {
  const all = tok.encode(text);
  const n = Math.min(all.length, length);
  const ids = new BigInt64Array(length), mask = new BigInt64Array(length);
  for (let i = 0; i < n; i++) { ids[i] = BigInt(all[i]); mask[i] = 1n; }
  return { ids, mask, count: n, truncated: all.length > length };
}

export { NORMAL, UNKNOWN, CONTROL, USER, BYTE };
