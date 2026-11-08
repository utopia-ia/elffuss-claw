// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// What a caller may ask for, checked and completed in one place: on the page
// before anything is sent to the Worker, and again in the Worker. A request is
// plain JSON, so a chat's tool call `{"tool": "image.generate", "args": {...}}`
// is passed as it is.

import { AiError } from '../core/errors.js';
import { resolveSize, MIN_SIDE, MAX_SIDE } from './shapes.js';
import { STEP_CHOICES } from './schedule.js';
import { MAX_SEED, randomSeed } from './rng.js';

/** The number of steps when none is asked: the two-step schedule the model was distilled for. */
export const DEFAULT_STEPS = 2;
/** Longest prompt accepted, in characters (the model reads at most 300 tokens of it). */
export const MAX_PROMPT_CHARS = 2000;
/** How far a picture made from another may move from it when none is asked (0 close … 1 free). */
export const DEFAULT_STRENGTH = 0.7;
/** Pixels of a picture made from another: about a megapixel, in the shape of the one given. */
const FROM_IMAGE_PIXELS = 1024 * 1024;

/**
 * The SDEdit start time of a strength (TrigFlow time, π/2 is all noise). What a picture
 * keeps changes fast near π/2, so the scale is even in log(tan t): t = atan(2·30^strength).
 * 0 → 1.11 (the picture barely moves), 0.3 → 1.39 (small changes of pose and detail),
 * 0.6 → 1.51, 0.7 → 1.52 (a new light or style, the same layout: "at night", "as a watercolour";
 * the default, with the prompt led by the picture's caption: compose.js), 1 → 1.55 (the text
 * leads, the picture only hints). Measured on SANA-Sprint 0.6B, four pictures × four changes.
 * @param {number} strength 0 to 1
 */
export function strengthTime(strength) {
  return Math.atan(2 * Math.pow(30, Math.min(1, Math.max(0, strength))));
}

/**
 * The size of a picture made from one of w × h: about a megapixel, its shape, multiples of 8.
 * @returns {{ width: number, height: number }}
 */
export function sizeFromImage(w, h) {
  const s = Math.sqrt(FROM_IMAGE_PIXELS / (w * h));
  const fit = v => Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round((v * s) / 8) * 8));
  return { width: fit(w), height: fit(h) };
}

/**
 * @typedef {{ prompt: string, aspect?: '1:1'|'4:3'|'3:2'|'16:9'|'3:4'|'2:3'|'9:16', width?: number, height?: number,
 *   seed?: number, steps?: 1|2|3|4 }} ImageRequest
 *   `aspect` (default 1:1) picks a trained size of about a megapixel; `width` and
 *   `height` (256 to 2048) ask for an exact size instead, generated at the
 *   nearest trained shape and scaled and cropped to it. `seed` (0 to 4294967295)
 *   repeats a picture: the same prompt, seed, steps and size give the same image;
 *   without one, a random seed is used and returned. `steps` 1 to 4 (default 2).
 *   `image` (optional): a picture to start from, `{ width, height, rgba }` (RGBA bytes;
 *   TextToImage turns a Blob or an ImageBitmap into one); the result keeps its shape
 *   (about a megapixel) and `strength` (0 to 1, default 0.7) says how far it may move
 *   from it: low keeps the picture and changes its look, high follows the text more.
 */

/**
 * Check a request and fill in its defaults (a random seed when none is given).
 * @param {ImageRequest} input
 * @returns {{ prompt: string, seed: number, steps: number, aspect: string|null, width: number, height: number, genWidth: number, genHeight: number,
 *   image?: { width: number, height: number, rgba: ArrayBuffer|Uint8ClampedArray }, strength?: number }}
 */
export function normalizeRequest(input) {
  if (!input || typeof input !== 'object') throw new AiError('unsupported-format', 'a request is an object with a prompt');
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) throw new AiError('unsupported-format', 'the prompt is empty');
  if (prompt.length > MAX_PROMPT_CHARS) throw new AiError('too-large', `the prompt has more than ${MAX_PROMPT_CHARS} characters`);
  const steps = input.steps == null ? DEFAULT_STEPS : Number(input.steps);
  if (!STEP_CHOICES.includes(steps)) throw new AiError('unsupported-format', 'steps must be 1, 2, 3 or 4');
  const seed = input.seed == null || input.seed === '' ? randomSeed() : Number(input.seed);
  if (!(Number.isInteger(seed) && seed >= 0 && seed <= MAX_SEED)) throw new AiError('unsupported-format', `the seed is a whole number from 0 to ${MAX_SEED}`);
  if (input.image != null) {
    const img = input.image;
    const n = img && img.width > 0 && img.height > 0 && (img.rgba?.byteLength ?? img.rgba?.length);
    if (!n || n !== img.width * img.height * 4) throw new AiError('unsupported-format', 'the picture to start from is { width, height, rgba } with RGBA bytes');
    const strength = input.strength == null ? DEFAULT_STRENGTH : Number(input.strength);
    if (!(strength >= 0 && strength <= 1)) throw new AiError('unsupported-format', 'strength goes from 0 to 1');
    let size;
    try { size = resolveSize(sizeFromImage(img.width, img.height)); } catch (err) { throw new AiError('unsupported-format', err.message); }
    return { prompt, seed, steps: 2, ...size, image: img, strength };
  }
  let size;
  try { size = resolveSize(input); } catch (err) { throw new AiError('unsupported-format', err.message); }
  return { prompt, seed, steps, ...size };
}
