// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Few-step sampling of distilled Wan students. Every student here predicts the
// rectified-flow velocity v at time t (x_t = (1 - t)·x0 + t·noise), and they are
// sampled the same way: estimate the clean latent x0 = x_t - t·v, then put fresh
// noise back at the next, smaller time. Only the list of times changes:
//   rCM / TurboDiffusion  TrigFlow angles [atan(σmax), …, 0] mapped to flow
//                         time sin/(sin + cos) (their inference script)
//   DMD students          flow times shifted by `shift` (Self-Forcing's
//                         warped list 1000, 750, 500, 250 at shift 5)
// The model receives t × 1000.

/**
 * @typedef {{ kind: 'trigflow', sigmaMax: number, mid: number[] } | { kind: 'shifted', shift: number, list: number[] }} SamplerSpec
 */

/** The samplers of the students we run. */
export const SAMPLERS = Object.freeze({
  // TurboDiffusion's "better visual quality" angles for 2–4 steps.
  rcm: Object.freeze({ kind: 'trigflow', sigmaMax: 80, mid: Object.freeze([1.5, 1.4, 1.0]) }),
  // Self-Forcing (DMD): warped denoising steps 1000, 750, 500, 250 with shift 5.
  selfForcing: Object.freeze({ kind: 'shifted', shift: 5, list: Object.freeze([1000, 750, 500, 250]) }),
});

/**
 * Flow times of a sampler for `steps` steps, from the first (near 1) down to 0.
 * @param {SamplerSpec} spec
 * @param {number} steps 1 to the most the sampler has
 * @returns {number[]} steps + 1 times
 */
export function flowTimes(spec, steps) {
  if (spec.kind === 'trigflow') {
    if (!(Number.isInteger(steps) && steps >= 1 && steps <= spec.mid.length + 1)) throw new RangeError(`steps must be 1 to ${spec.mid.length + 1}`);
    const angles = [Math.atan(spec.sigmaMax), ...spec.mid.slice(0, steps - 1), 0];
    return angles.map(a => Math.sin(a) / (Math.cos(a) + Math.sin(a)));
  }
  if (spec.kind === 'shifted') {
    if (!(Number.isInteger(steps) && steps >= 1 && steps <= spec.list.length)) throw new RangeError(`steps must be 1 to ${spec.list.length}`);
    // Self-Forcing picks the steps from the 1000 shifted training times (σ from 1 down to 0.001).
    const list = steps === spec.list.length ? spec.list : spec.list.slice(0, steps);
    const times = list.map(d => {
      const s = 1 - (1000 - d) / 1000;
      return (spec.shift * s) / (1 + (spec.shift - 1) * s);
    });
    return [...times, 0];
  }
  throw new TypeError('unknown sampler');
}

/**
 * One step, in place: x ← (1 - tNext)·(x - t·v) + tNext·noise. With tNext = 0 it
 * leaves the clean estimate.
 * @param {Float32Array} x the current latent (overwritten)
 * @param {ArrayLike<number>} v the predicted velocity
 * @param {number} t current flow time
 * @param {number} tNext next flow time
 * @param {ArrayLike<number> | null} noise fresh noise, needed when tNext > 0
 */
export function step(x, v, t, tNext, noise) {
  if (tNext > 0 && (!noise || noise.length < x.length)) throw new RangeError('a step to a time above 0 needs fresh noise');
  const a = 1 - tNext;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i] - t * v[i];
    x[i] = tNext > 0 ? a * x0 + tNext * noise[i] : x0;
  }
  return x;
}
