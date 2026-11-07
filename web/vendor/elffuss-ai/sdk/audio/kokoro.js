// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// What Kokoro 82M needs around its network: the voices this module offers, the
// phoneme ids (the model's own vocabulary, from its tokenizer.json, between two
// 0s), and the style vector of a voice for a text of that length (a voice file
// holds 510 vectors of 256 values; Kokoro takes the one at the phoneme count
// minus one). Pure.

/** Sample rate of Kokoro (mono). */
export const SPEECH_SAMPLE_RATE = 24000;
/** Values of one style vector. */
export const STYLE_SIZE = 256;

/**
 * The voices offered, Spanish first. `lang` is the language they speak; the
 * grade is Kokoro's own (VOICES.md of hexgrad/Kokoro-82M).
 */
export const VOICES = Object.freeze([
  { id: 'ef_dora', name: 'Dora', lang: 'es', gender: 'f' },
  { id: 'em_alex', name: 'Alex', lang: 'es', gender: 'm' },
  { id: 'em_santa', name: 'Santa', lang: 'es', gender: 'm' },
  { id: 'af_heart', name: 'Heart', lang: 'en', gender: 'f' },
  { id: 'af_bella', name: 'Bella', lang: 'en', gender: 'f' },
  { id: 'af_nicole', name: 'Nicole', lang: 'en', gender: 'f' },
  { id: 'am_michael', name: 'Michael', lang: 'en', gender: 'm' },
  { id: 'am_fenrir', name: 'Fenrir', lang: 'en', gender: 'm' },
  { id: 'am_puck', name: 'Puck', lang: 'en', gender: 'm' },
].map(Object.freeze));

/** Default voice of each language. */
export const DEFAULT_VOICE = Object.freeze({ es: 'ef_dora', en: 'af_heart' });

/** Speed range Kokoro takes well. */
export const SPEED = Object.freeze({ min: 0.5, max: 2, default: 1 });

/** The voice entry for an id, or null. */
export function voiceInfo(id) {
  return VOICES.find(v => v.id === id) || null;
}

/** The vocabulary of a Kokoro tokenizer.json: character → id. */
export function readVocab(json) {
  const vocab = json?.model?.vocab;
  if (!vocab || typeof vocab !== 'object') throw new TypeError('not a Kokoro tokenizer.json');
  return new Map(Object.entries(vocab));
}

/**
 * Input ids of a phoneme string: 0, the id of each known character, 0. Unknown
 * characters are dropped, as the tokenizer's normaliser does.
 * @param {Map<string, number>} vocab
 * @param {string} ps
 * @returns {{ ids: BigInt64Array, count: number }}
 */
export function phonemeIds(vocab, ps) {
  const ids = [0n];
  for (const ch of ps) if (vocab.has(ch)) ids.push(BigInt(vocab.get(ch)));
  ids.push(0n);
  return { ids: BigInt64Array.from(ids), count: ids.length - 2 };
}

/**
 * The style vector of a voice for `count` phonemes.
 * @param {Float32Array} voice 510 × 256 values
 * @param {number} count
 */
export function styleFor(voice, count) {
  const rows = Math.floor(voice.length / STYLE_SIZE);
  const i = Math.max(0, Math.min(rows - 1, count - 1));
  return voice.slice(i * STYLE_SIZE, (i + 1) * STYLE_SIZE);
}
