// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The pieces of MOSS-TTS-Nano's voice cloning that are not the model: the text
// as the model takes it, the chunks a long text is read in, the rows of the
// request (the prompt template, the voice's codes, the text's ids) and the
// inputs of the sampling graph. They follow the official ONNX runtime of
// OpenMOSS (onnx_tts_runtime.py and ort_cpu_runtime.py of OpenMOSS/MOSS-TTS-Nano,
// Apache-2.0), written again from what it does; no code of it is copied. Pure.

import { sentences } from './text.js';
import { AiError } from '../core/errors.js';
import * as VOICE_ES from './moss-voice-es.js';

/** Sample rate of MOSS-Audio-Tokenizer-Nano (its output is stereo; speech is given mono). */
export const MOSS_SAMPLE_RATE = 48000;
/** Codes per frame. */
export const N_VQ = 16;
/** Text tokens a chunk is read in at most (the official runtime's budget). */
export const CHUNK_TOKENS = 75;
/** Frames a chunk may take at most (30 s at 12.5 frames a second). */
export const MAX_FRAMES = 375;
/**
 * Fewest frames a chunk of text should give, per character: Spanish read at its
 * pace gives about 0.7 to 1 frame a character. Now and then the model ends a chunk
 * after its first sentence; under this it is read again (see MAX_READS).
 */
export const MIN_FRAMES_PER_CHAR = 0.4;
/** Readings of a chunk at most, when one ends too early: the longest is kept. */
export const MAX_READS = 3;

/** True when a chunk's frames are too few for its text (an early end). */
export function endedEarly(text, frames) {
  const chars = String(text).replace(/\s+/g, ' ').trim().length;
  return chars >= 20 && frames < MIN_FRAMES_PER_CHAR * chars;
}

/** The voices of MOSS-TTS-Nano: a voice prompt each, shipped as codes. */
export const MOSS_VOICES = Object.freeze([
  Object.freeze({ id: 'es_elffuss', name: 'Elffuss', lang: 'es', gender: 'f', model: 'moss', codes: VOICE_ES }),
]);

/** The voice entry of an id, or null. */
export function mossVoice(id) {
  return MOSS_VOICES.find(v => v.id === id) || null;
}

/**
 * The text as the official runtime cleans it before the tokenizer (its robust
 * pass, the part of it a Spanish or English text meets): control characters
 * dropped, lines and spaces made one space, runs of the same mark made one,
 * and a full stop at the end when there is no closing mark.
 * @param {string} text
 */
export function cleanText(text) {
  let s = String(text).replace(/\r\n?/g, '\n').replace(/[​-‍﻿]/g, '');
  s = [...s].filter(c => c === '\n' || c === '\t' || !/\p{C}/u.test(c)).join('');
  s = s.replace(/[ \t 　]+/g, ' ').replace(/ *\n+ */g, '\n')
    .replace(/\.{3,}|…+/g, '…').replace(/([!?¡¿,;:])\1+/g, '$1')
    .split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => (/[.!?…:;,"'»”)\]]$/.test(l) ? l : l + '.')).join(' ');
  return s.trim();
}

/**
 * Chunks of a text, each at most `max` tokens where a sentence allows, with the
 * pause that follows each: sentences are packed together; a sentence over the
 * budget is cut at a comma or a semicolon, else between words.
 * @param {string} text cleaned
 * @param {(s: string) => number} count tokens of a string
 * @param {number} [max]
 * @returns {{ text: string, pause: number }[]}
 */
export function chunkText(text, count, max = CHUNK_TOKENS) {
  const pieces = [];
  for (const s of sentences(text)) {
    if (count(s.text) <= max) { pieces.push(s); continue; }
    const parts = cutLong(s.text, count, max);
    parts.forEach((p, i) => pieces.push({ text: p, pause: i === parts.length - 1 ? s.pause : 0.16 }));
  }
  const out = [];
  for (const p of pieces) {
    const last = out.at(-1);
    if (last && count(last.text + ' ' + p.text) <= max) { last.text += ' ' + p.text; last.pause = p.pause; }
    else out.push({ ...p });
  }
  return out;
}

function cutLong(text, count, max) {
  const out = [];
  let cur = '';
  for (const clause of text.split(/(?<=[,;:])\s+/)) {
    const next = cur ? cur + ' ' + clause : clause;
    if (count(next) <= max) { cur = next; continue; }
    if (cur) out.push(cur);
    if (count(clause) <= max) { cur = clause; continue; }
    cur = '';
    for (const w of clause.split(/\s+/)) {
      const nw = cur ? cur + ' ' + w : w;
      if (cur && count(nw) > max) { out.push(cur); cur = w; } else cur = nw;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The request rows of a voice-cloning chunk, flat (rows × (N_VQ + 1), int32): the
 * user prefix and <|audio_start|>, one row per frame of the voice's codes, then
 * <|audio_end|>, the instruction, the text's ids, the assistant prefix and
 * <|audio_start|>. A text row is its id followed by the audio pad.
 * @param {{ tts_config: object, prompt_templates: object }} manifest browser_poc_manifest.json
 * @param {ArrayLike<number>} codes frame-major, frames × N_VQ
 * @param {number[]} ids the text's token ids
 * @returns {{ data: Int32Array, rows: number }}
 */
export function cloneRows(manifest, codes, ids) {
  const c = manifest.tts_config, t = manifest.prompt_templates;
  const nvq = c.n_vq, width = nvq + 1, pad = c.audio_pad_token_id;
  if (nvq !== N_VQ) throw new AiError('model-mismatch', `the model has ${nvq} codebooks, ${N_VQ} expected`);
  if (codes.length % nvq) throw new AiError('model-mismatch', 'the voice prompt is not whole frames');
  const before = [...t.user_prompt_prefix_token_ids, c.audio_start_token_id];
  const after = [c.audio_end_token_id, ...t.user_prompt_after_reference_token_ids, ...ids, ...t.assistant_prompt_prefix_token_ids, c.audio_start_token_id];
  const frames = codes.length / nvq;
  const rows = before.length + frames + after.length;
  const data = new Int32Array(rows * width).fill(pad);
  let r = 0;
  for (const id of before) data[(r++) * width] = id;
  for (let f = 0; f < frames; f++, r++) {
    data[r * width] = c.audio_user_slot_token_id;
    for (let q = 0; q < nvq; q++) data[r * width + 1 + q] = codes[f * nvq + q];
  }
  for (const id of after) data[(r++) * width] = id;
  return { data, rows };
}

/** The row fed back after a frame: the assistant's audio slot and the frame's codes. */
export function frameRow(manifest, frame) {
  const c = manifest.tts_config;
  const row = new Int32Array(c.n_vq + 1).fill(c.audio_pad_token_id);
  row[0] = c.audio_assistant_slot_token_id;
  for (let q = 0; q < frame.length; q++) row[1 + q] = frame[q];
  return row;
}

/**
 * The inputs of moss_tts_local_fixed_sampled_frame besides the hidden state: which
 * codes each codebook has already given (for its repetition penalty), and the
 * uniform numbers of this frame, drawn as the official runtime draws them (one for
 * the assistant's token, then one per codebook).
 * @param {Uint8Array[]} seen per codebook, 1 where the code was given
 * @param {() => number} uniform in [0, 1)
 * @param {number} codebook size of each codebook
 */
export function frameInputs(seen, uniform, codebook) {
  const mask = new Int32Array(seen.length * codebook);
  seen.forEach((s, q) => { for (let k = 0; k < codebook; k++) if (s[k]) mask[q * codebook + k] = 1; });
  const clamp = u => Math.min(0.99999994, Math.max(0, u));
  const assistant = new Float32Array([clamp(uniform())]);
  const audio = new Float32Array(seen.length);
  for (let q = 0; q < seen.length; q++) audio[q] = clamp(uniform());
  return { mask, assistant, audio };
}

/** One channel of a [1, channels, samples] audio tensor's data, or their mean. */
export function toMono(data, channels, samples, length = samples) {
  const out = new Float32Array(length);
  for (let ch = 0; ch < channels; ch++) {
    const base = ch * samples;
    for (let i = 0; i < length; i++) out[i] += data[base + i] / channels;
  }
  return out;
}
