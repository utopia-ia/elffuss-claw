// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// What a caller may ask for, checked and completed in one place: on the page
// before anything is sent to the Worker, and again in the Worker. A request is
// plain JSON, so a chat's tool call `{"tool": "image.generate", "args": {...}}`
// is passed as it is.

import { AiError } from '../core/errors.js';
import { resolveSize } from './shapes.js';
import { STEP_CHOICES } from './schedule.js';
import { MAX_SEED, randomSeed } from './rng.js';

/** The number of steps when none is asked: the two-step schedule the model was distilled for. */
export const DEFAULT_STEPS = 2;
/** Longest prompt accepted, in characters (the model reads at most 300 tokens of it). */
export const MAX_PROMPT_CHARS = 2000;

/**
 * @typedef {{ prompt: string, aspect?: '1:1'|'4:3'|'3:2'|'16:9'|'3:4'|'2:3'|'9:16', width?: number, height?: number,
 *   seed?: number, steps?: 1|2|3|4 }} ImageRequest
 *   `aspect` (default 1:1) picks a trained size of about a megapixel; `width` and
 *   `height` (256 to 2048) ask for an exact size instead, generated at the
 *   nearest trained shape and scaled and cropped to it. `seed` (0 to 4294967295)
 *   repeats a picture: the same prompt, seed, steps and size give the same image;
 *   without one, a random seed is used and returned. `steps` 1 to 4 (default 2).
 */

/**
 * Check a request and fill in its defaults (a random seed when none is given).
 * @param {ImageRequest} input
 * @returns {{ prompt: string, seed: number, steps: number, aspect: string|null, width: number, height: number, genWidth: number, genHeight: number }}
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
  let size;
  try { size = resolveSize(input); } catch (err) { throw new AiError('unsupported-format', err.message); }
  return { prompt, seed, steps, ...size };
}
