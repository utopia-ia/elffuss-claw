// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// One picture from a prompt, given the three models as functions (so that this
// file runs the same in a Worker, on a page or in Node's tests with stand-ins):
//   1. the prompt's tokens and their embeddings, through the text model (Gemma 2);
//   2. noise from the seed, drawn as PyTorch draws it;
//   3. 1 to 4 steps of the transformer and the sampler;
//   4. the decoder, then scaling to the asked size and 8-bit pixels.
// It reports each stage (encode, step i of n, decode) and stops between models
// when the signal is aborted.

import { AiError, throwIfAborted } from '../core/errors.js';
import { Mt19937, randn } from './rng.js';
import { timesteps, modelInput, step, SIGMA_DATA } from './schedule.js';
import { captionTokens } from './prompt.js';
import { resizeCrop, toRgba } from './pixels.js';

/**
 * @typedef {{ encode: (text: string) => number[], embed: (ids: number[]) => Float32Array, hidden: number,
 *   runEncoder: (embeds: Float32Array, tokens: number) => Promise<Float32Array>,
 *   runTransformer: (o: { latents: Float32Array, h: number, w: number, caption: Float32Array, tokens: number, time: number, guidance: number }) => Promise<Float32Array>,
 *   runDecoder: (latents: Float32Array, h: number, w: number) => Promise<{ data: Float32Array, height: number, width: number }>,
 *   config: { channels: number, factor: number, scaling: number, guidance: number, sigmaData?: number } }} Models
 *   `config` comes from the model's own configuration files: latent channels, the
 *   decoder's spatial factor, its scaling factor, and the guidance value the
 *   transformer is given (4.5 × guidance_embeds_scale).
 */

/**
 * @param {Models} m
 * @param {{ prompt: string, seed: number, steps: number, width: number, height: number, genWidth: number, genHeight: number }} req
 * @param {{ signal?: AbortSignal, report?: (stage: string, extra?: object) => void }} [o]
 * @returns {Promise<{ rgba: Uint8ClampedArray, width: number, height: number, promptTokens: number, truncated: boolean }>}
 */
export async function generate(m, req, { signal, report = () => {} } = {}) {
  const { channels, factor, scaling, guidance } = m.config;
  const sigmaData = m.config.sigmaData ?? SIGMA_DATA;
  const h = req.genHeight / factor, w = req.genWidth / factor;
  if (!Number.isInteger(h) || !Number.isInteger(w)) throw new AiError('run-failed', `the size must be a multiple of ${factor}`);

  report('encode');
  const { ids, keep, promptTokens, truncated } = captionTokens(m.encode, req.prompt);
  const states = await m.runEncoder(m.embed(ids), ids.length);
  const caption = new Float32Array(keep.length * m.hidden);
  keep.forEach((pos, i) => caption.set(states.subarray(pos * m.hidden, (pos + 1) * m.hidden), i * m.hidden));
  throwIfAborted(signal);

  const gen = new Mt19937(req.seed);
  const n = channels * h * w;
  let latents = randn(gen, n);
  for (let i = 0; i < n; i++) latents[i] = Math.fround(latents[i] * sigmaData);
  const times = timesteps(req.steps);
  let x0 = null;
  for (let i = 0; i < req.steps; i++) {
    report('step', { step: i + 1, steps: req.steps });
    const s = times[i], t = times[i + 1];
    const { input, time, scale } = modelInput(latents, s, sigmaData);
    const output = await m.runTransformer({ latents: input, h, w, caption, tokens: keep.length, time, guidance });
    if (output.length !== n) throw new AiError('model-mismatch', `the transformer gave ${output.length} values, the latents have ${n}`);
    // The reference draws noise at every step, also the last (where it is multiplied by 0).
    const noise = randn(gen, n);
    ({ x0, next: latents } = step({ latents, input, output, time, scale, s, t, noise, sigmaData }));
    throwIfAborted(signal);
  }

  report('decode');
  const z = new Float32Array(n);
  for (let i = 0; i < n; i++) z[i] = x0[i] / sigmaData / scaling;
  const img = await m.runDecoder(z, h, w);
  if (img.height !== req.genHeight || img.width !== req.genWidth) throw new AiError('model-mismatch', `the decoder gave ${img.width} × ${img.height}`);
  const planes = resizeCrop(img.data, 3, img.height, img.width, req.width, req.height);
  return { rgba: toRgba(planes, req.width, req.height), width: req.width, height: req.height, promptTokens, truncated };
}
