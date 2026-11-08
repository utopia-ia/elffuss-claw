// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The few-step sampler of SANA-Sprint (continuous-time consistency, "TrigFlow"),
// as diffusers' SCMScheduler and SanaSprintPipeline do it. Time runs from π/2
// (pure noise) to 0 (the picture). Each step scales the latents into the model's
// input, turns the model's output into a velocity, takes the clean estimate x0
// and, unless it is the last step, adds fresh noise for the next time. Pure
// functions over Float32Arrays; the arithmetic is float32 like the reference.

const f = Math.fround;

/** The noise level of the training data (scheduler_config.json, `sigma_data`). */
export const SIGMA_DATA = 0.5;
/** The first time of every schedule: π/2 as the reference writes it. */
export const MAX_TIME = f(1.5708);
/** The middle time of the two-step schedule, the one the model was distilled for. */
export const TWO_STEP_TIME = f(1.3);
/** Steps the model was trained to work with. */
export const STEP_CHOICES = Object.freeze([1, 2, 3, 4]);

/**
 * The times of a schedule of `steps` steps, from π/2 down to 0 (steps + 1 values).
 * Two steps use the distilled middle time 1.3; the others are evenly spaced.
 * @param {number} steps 1 to 4
 * @returns {Float32Array}
 */
export function timesteps(steps) {
  if (!STEP_CHOICES.includes(steps)) throw new RangeError('steps must be 1, 2, 3 or 4');
  if (steps === 2) return Float32Array.of(MAX_TIME, TWO_STEP_TIME, 0);
  const out = new Float32Array(steps + 1);
  const step = f((0 - MAX_TIME) / steps);
  for (let i = 0; i <= steps; i++) out[i] = i === steps ? 0 : f(MAX_TIME + f(step * i));
  return out;
}

/**
 * The schedule of SDEdit (a picture from another picture) starting at time `t`
 * (π/2 is all noise): the two-step schedule scaled to start there,
 * [t, t·1.3/(π/2), 0], as diffusers' Sprint img2img runs with
 * max_timesteps = t and intermediate_timesteps = t·1.3/(π/2).
 * @param {number} t in (0, π/2]
 * @returns {Float32Array}
 */
export function sdeditTimes(t) {
  if (!(t > 0 && t <= MAX_TIME + 1e-6)) throw new RangeError('the SDEdit time must be in (0, π/2]');
  const s = f(t);
  return Float32Array.of(s, f(f(s * TWO_STEP_TIME) / MAX_TIME), 0);
}

/**
 * What the transformer is given at time s: the latents scaled to its input, and
 * the time as it sees it (between 0 and 1).
 * @param {Float32Array} latents
 * @param {number} s
 * @param {number} [sigmaData]
 * @returns {{ input: Float32Array, time: number, scale: number }}
 */
export function modelInput(latents, s, sigmaData = SIGMA_DATA) {
  const sin = f(Math.sin(s)), cos = f(Math.cos(s));
  const time = f(sin / f(cos + sin));
  const scale = f(Math.sqrt(f(f(time * time) + f(f(1 - time) * f(1 - time)))));
  const input = new Float32Array(latents.length);
  for (let i = 0; i < latents.length; i++) input[i] = f(f(latents[i] / sigmaData) * scale);
  return { input, time, scale };
}

/**
 * One step: from the model's output at time s to the clean estimate x0, and the
 * latents at the next time t (x0 itself when t is 0).
 * @param {{ latents: Float32Array, input: Float32Array, output: Float32Array, time: number, scale: number,
 *   s: number, t: number, noise?: Float32Array, sigmaData?: number }} o
 *   `noise` is a standard normal draw of the latents' size (unused when t is 0)
 * @returns {{ x0: Float32Array, next: Float32Array }}
 */
export function step({ latents, input, output, time, scale, s, t, noise, sigmaData = SIGMA_DATA }) {
  const a = f(1 - 2 * time), b = f(f(1 - 2 * time) + f(2 * f(time * time)));
  const cs = f(Math.cos(s)), ss = f(Math.sin(s)), ct = f(Math.cos(t)), st = f(Math.sin(t));
  const n = latents.length;
  const x0 = new Float32Array(n), next = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = f(f(f(f(a * input[i]) + f(b * output[i])) / scale) * sigmaData);
    x0[i] = f(f(cs * latents[i]) - f(ss * v));
    next[i] = t === 0 || !noise ? x0[i] : f(f(ct * x0[i]) + f(st * f(noise[i] * sigmaData)));
  }
  return { x0, next };
}
