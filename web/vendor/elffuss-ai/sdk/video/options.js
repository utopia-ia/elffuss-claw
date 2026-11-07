// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The options of a video and the size it is made at. Pure: the page, the task's
// Worker and the tests read them the same way. Everything here is plain data,
// so a run's options survive postMessage and a chat tool call maps onto them.

import { PRESETS, DEFAULT_PRESET, ASPECTS, DEFAULT_ASPECT } from './camera.js';

/** Shortest and longest video, and the default, in seconds. */
export const SECONDS = Object.freeze({ min: 2, max: 15, default: 6 });
/** Frame rates offered, and the default. */
export const FPS = Object.freeze({ list: [24, 25, 30, 60], default: 30 });
/** Short side of the video for each quality. */
export const QUALITY = Object.freeze({ high: 1080, standard: 720 });

/**
 * The options of a run, checked and completed. Unknown values fall back to the
 * defaults; nothing throws for a value out of range: it is brought inside.
 * @param {object} [o]
 * @returns {{ preset: string, seconds: number, aspect: string, fps: number, quality: 'high'|'standard', strength: number,
 *   effects: { dof: number, vignette: number, grain: number }, container: 'auto'|'mp4'|'webm' }}
 */
export function normalizeOptions(o = {}) {
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
  const unit = (v, d) => Math.min(1, Math.max(0, num(v, d)));
  const fx = o.effects || {};
  return {
    preset: PRESETS.includes(o.preset) ? o.preset : DEFAULT_PRESET,
    seconds: Math.min(SECONDS.max, Math.max(SECONDS.min, num(o.seconds, SECONDS.default))),
    aspect: o.aspect in ASPECTS ? o.aspect : DEFAULT_ASPECT,
    fps: FPS.list.includes(num(o.fps, 0)) ? num(o.fps, 0) : FPS.default,
    quality: o.quality === 'standard' || o.quality === 'high' ? o.quality : 'high',
    strength: Math.min(2, Math.max(0.2, num(o.strength, 1))),
    effects: { dof: unit(fx.dof, 0), vignette: unit(fx.vignette, 0.35), grain: unit(fx.grain, 0) },
    container: ['mp4', 'webm'].includes(o.container) ? o.container : 'auto',
  };
}

/** Width and height (even numbers) of the video for an aspect and a quality. */
export function outputSize(aspect, quality = 'high') {
  const short = QUALITY[quality] || QUALITY.high;
  const r = ASPECTS[aspect] || ASPECTS[DEFAULT_ASPECT];
  const even = v => Math.max(2, Math.round(v / 2) * 2);
  return r >= 1 ? { width: even(short * r), height: short } : { width: short, height: even(short / r) };
}

/**
 * The quality to use when the caller says 'auto': standard (720) on a phone or
 * a device that says it has little memory, high (1080) elsewhere.
 * @param {{ mobile?: boolean, deviceMemory?: number }} env
 */
export function autoQuality({ mobile = false, deviceMemory } = {}) {
  if (mobile) return 'standard';
  if (Number.isFinite(deviceMemory) && deviceMemory > 0 && deviceMemory < 4) return 'standard';
  return 'high';
}
