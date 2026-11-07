// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// What a text-to-video run may ask for, checked before anything loads: the
// sizes the model was trained near (832 × 480 and its portrait, plus a lighter
// 640 × 368), a length in whole seconds from 1 to 5 (FPS frames each), 1 to 4 steps, a seed. The
// same shape is the chat tool's arguments: {"prompt", "seconds", "size", "seed", "steps"}.

import { AiError } from '../core/errors.js';
import { framesFor, grid, FPS } from './latent.js';

/** Sizes offered, width × height. The first is the default. */
export const SIZES = Object.freeze(['832x480', '480x832', '640x368', '368x640']);
/** Seconds offered, and the default. */
export const SECONDS = Object.freeze({ min: 1, max: 5, default: 2 });
/** Steps of the distilled sampler, and the default. */
export const STEPS = Object.freeze({ min: 1, max: 4, default: 4 });
/** Longest prompt kept, in tokens (the encoder's window). */
export const MAX_TOKENS = 512;

/**
 * Normalise and check the options of a run.
 * @param {{ prompt?: string, seconds?: number, size?: string, seed?: number, steps?: number }} o
 * @returns {{ prompt: string, seconds: number, size: string, seed: number|null, steps: number, width: number, height: number, frames: number, g: ReturnType<typeof grid> }}
 */
export function normalizeOptions(o = {}) {
  const prompt = typeof o.prompt === 'string' ? o.prompt.trim() : '';
  if (!prompt) throw new AiError('decode-failed', 'a video needs a prompt');
  const size = o.size == null ? SIZES[0] : String(o.size).replace(/\s+/g, '').replace('×', 'x');
  if (!SIZES.includes(size)) throw new AiError('too-large', `size ${size} is not offered`, { details: { sizes: SIZES } });
  const seconds = o.seconds == null ? SECONDS.default : Number(o.seconds);
  if (!(seconds >= SECONDS.min && seconds <= SECONDS.max)) throw new AiError('too-large', `seconds must be ${SECONDS.min} to ${SECONDS.max}`, { details: { seconds } });
  const steps = o.steps == null ? STEPS.default : Number(o.steps);
  if (!(Number.isInteger(steps) && steps >= STEPS.min && steps <= STEPS.max)) throw new AiError('decode-failed', `steps must be ${STEPS.min} to ${STEPS.max}`);
  let seed = null;
  if (o.seed != null) {
    seed = Number(o.seed);
    if (!(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff)) throw new AiError('decode-failed', 'the seed must be an integer from 0 to 4294967295');
  }
  const [width, height] = size.split('x').map(Number);
  const frames = framesFor(seconds);
  return { prompt, seconds: (frames - 1) / FPS, size, seed, steps, width, height, frames, g: grid({ width, height, frames }) };
}
