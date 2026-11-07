// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The camera of a video made from one photo: its moves (presets), their easing,
// where each point of the photo lands in each frame, and the framing that keeps
// the photo's edges out of the picture. Pure functions: the renderer (WebGL2,
// sdk/video/render.js) draws with the same numbers, and Node tests them.
//
// The photo is a surface in front of the camera. Its pixel (u, v), u to the
// right and v down, both 0-1, has a disparity d (0 farthest, 1 nearest, as the
// depth model gives it). At the first view every point sits on its own ray, so
// the photo looks exactly as it is; its distance along that ray is
// Z = 1 / (1 + relief · (d − focus.d)): the subject (focus) at distance 1,
// what is nearer closer, what is farther away. Moving the camera then shows the
// parallax a real camera would see.

/** The camera moves, in the order the page offers them. */
export const PRESETS = Object.freeze(['dolly-in', 'orbit', 'swing', 'zoom-pan', 'vertigo']);
/** The move used when none is asked for. */
export const DEFAULT_PRESET = 'dolly-in';
/** Moves that end where they start: the video loops without a seam. */
export const LOOPS = Object.freeze(['orbit', 'swing']);

/** Aspect ratios of the output, width / height. */
export const ASPECTS = Object.freeze({ '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 });
/** The aspect used when none is asked for. */
export const DEFAULT_ASPECT = '16:9';

/** How strong the relief of the photo is by default (see `relief` above). */
export const RELIEF = 0.5;
/** The farthest a point may be: its disparity never goes under this (Z at most 1 / this). */
export const MIN_DISPARITY = 0.3;
/** The frame window at the first view, as a share of the largest one the photo allows. */
export const BASE_FIT = 0.985;
/** A little more zoom than the sampled frames need, for the frames between them. */
export const COVER_MARGIN = 1.006;
/** The most the framing may zoom in to keep the edges out (beyond it, the move is made smaller). */
export const MAX_COVER_ZOOM = 1.45;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** Ease in and out (sine): 0 at 0, 1 at 1, flat at both ends. */
export function easeInOut(t) {
  const x = clamp(t, 0, 1);
  return 0.5 - 0.5 * Math.cos(Math.PI * x);
}

/** A smoother ease for long moves (quintic smootherstep): still at both ends, no jerk. */
export function easeSmoother(t) {
  const x = clamp(t, 0, 1);
  return x * x * x * (x * (6 * x - 15) + 10);
}

/**
 * Where a point of the photo is in the world.
 * @param {{ A: number, relief: number, focusD: number }} g the photo's aspect (width / height), relief and focus disparity
 * @returns {[number, number, number]}
 */
export function worldPoint(g, u, v, d) {
  const disp = Math.max(MIN_DISPARITY, 1 + g.relief * (d - g.focusD));
  const z = 1 / disp;
  return [(u - 0.5) * g.A * z, (0.5 - v) * z, z];
}

/**
 * Where a world point lands in the frame of a view: x and y from −1 to 1 inside
 * the frame (y up), and its distance in front of the camera.
 * @param {{ pos: number[], yaw: number, pitch: number, shift: number[], half: number[] }} view
 * @param {number[]} p
 */
export function projectWorld(view, p) {
  const dx = p[0] - view.pos[0], dy = p[1] - view.pos[1], dz = p[2] - view.pos[2];
  const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
  const x1 = cy * dx - sy * dz, z1 = sy * dx + cy * dz;
  const y2 = cp * dy - sp * z1, z2 = sp * dy + cp * z1;
  return { x: (x1 / z2 - view.shift[0]) / view.half[0], y: (y2 / z2 - view.shift[1]) / view.half[1], z: z2 };
}

/** Where a point of the photo lands in the frame of a view (see projectWorld). */
export function projectPoint(plan, view, u, v, d) {
  return projectWorld(view, worldPoint(plan, u, v, d));
}

/**
 * The largest window of the photo with the output's aspect, centred as near the
 * subject as the photo allows. Coordinates are those of the photo at distance 1:
 * x from −A/2 to A/2, y from −1/2 to 1/2 (up).
 * @param {number} A photo aspect, width / height
 * @param {number} r output aspect, width / height
 * @param {{ u: number, v: number }} focus
 * @param {number} [fit]
 */
export function baseWindow(A, r, focus, fit = BASE_FIT) {
  let hx, hy;
  if (r >= A) { hx = A / 2; hy = hx / r; } else { hy = 0.5; hx = hy * r; }
  hx *= fit; hy *= fit;
  const fx = (focus.u - 0.5) * A, fy = 0.5 - focus.v;
  return { cx: clamp(fx, -A / 2 + hx, A / 2 - hx), cy: clamp(fy, -0.5 + hy, 0.5 - hy), hx, hy };
}

/**
 * The amplitudes of each move at strength 1, in units of the subject's distance
 * (translations), radians (turns) and factors (zooms).
 */
export const MOVES = Object.freeze({
  'dolly-in': { push: 0.14, rise: 0.012 },
  orbit: { angle: 0.065 },
  swing: { radius: 0.042, tilt: 0.55 },
  'zoom-pan': { travel: 0.035, zoom: 0.08 },
  vertigo: { pull: 0.42 },
});

/**
 * Plan a move for a photo: its geometry, the window, and the zoom that keeps
 * the edges of every layer out of the frame for the whole move.
 * @param {{ preset?: string, aspect?: number, A: number, focus: { u: number, v: number, d: number },
 *   relief?: number, strength?: number, borders?: { u: number, v: number, d: number }[][] }} o
 *   `aspect` is the output's (width / height); `borders` are, per layer, points of the photo's edge where
 *   that layer shows, with their disparity in that layer (sdk/video/layers.js, borderSamples).
 *   `parallax` are limits of the photo: `{ span: [d0, d1], limit }` says that two points of disparities d0
 *   and d1 must never part by more than `limit` (in heights of the photo) during the move; the move is made
 *   smaller until they hold (what the painting behind the subject covers, what a surface may stretch).
 */
export function planCamera({ preset = DEFAULT_PRESET, aspect = ASPECTS[DEFAULT_ASPECT], A, focus, relief = RELIEF, strength = 1, borders = [], parallax = [] }) {
  if (!PRESETS.includes(preset)) throw new RangeError('unknown camera move: ' + preset);
  if (!(A > 0) || !(aspect > 0)) throw new RangeError('aspects must be positive');
  const f = { u: clamp(Number(focus?.u ?? 0.5), 0, 1), v: clamp(Number(focus?.v ?? 0.5), 0, 1), d: clamp(Number(focus?.d ?? 0.5), 0, 1) };
  const plan = {
    preset, aspect, A, relief, focusD: f.d, focus: f, strength: clamp(strength, 0, 2),
    window: baseWindow(A, aspect, f), cover: 1, loop: LOOPS.includes(preset),
  };
  // A move that would part the photo's layers more than they can take is made smaller.
  for (let i = 0; i < 16 && parallax.some(c => maxParallax(plan, c.span) > c.limit); i++) plan.strength *= 0.85;
  // The zoom that keeps every layer's edge out of the frame. A move so large that
  // it needs more than MAX_COVER_ZOOM is made smaller instead.
  for (let i = 0; i < 8; i++) {
    const need = coverZoom(plan, borders);
    if (need <= MAX_COVER_ZOOM || i === 7) { plan.cover = Math.max(1, need * COVER_MARGIN); break; }
    plan.strength *= 0.8;
  }
  return plan;
}

/**
 * The view of a planned move at time t (0-1): camera position, turn, lens shift
 * and the half size of the frame window at distance 1.
 * @param {ReturnType<typeof planCamera>} plan
 * @param {number} t
 */
export function cameraAt(plan, t) {
  const s = plan.strength;
  const w = plan.window;
  const F = worldPoint(plan, plan.focus.u, plan.focus.v, plan.focusD); // the subject, at distance 1
  let pos = [0, 0, 0], yaw = 0, pitch = 0, zoom = 1, keep = true, pan = [0, 0];
  const m = MOVES[plan.preset];
  if (plan.preset === 'dolly-in') {
    const e = easeSmoother(t);
    pos = [0, m.rise * s * e, m.push * s * e];
  } else if (plan.preset === 'orbit') {
    // Around the subject, on a level arc, there and back (a loop).
    const a = m.angle * s * Math.sin(2 * Math.PI * t);
    const r = F[2];
    pos = [F[0] - r * Math.sin(a), 0, F[2] - r * Math.cos(a)];
    yaw = a;
  } else if (plan.preset === 'swing') {
    // A small ellipse in front of the photo, the subject held still (a loop).
    const a = 2 * Math.PI * t;
    pos = [m.radius * s * Math.sin(a), m.radius * s * m.tilt * Math.cos(a), 0];
  } else if (plan.preset === 'zoom-pan') {
    // A slow push while the camera travels along the photo's long side.
    const e = easeInOut(t);
    const along = w.hx >= w.hy * plan.aspect ? 0 : 1;
    const dir = [along === 0 ? 1 : 0, along === 1 ? 1 : 0];
    const d = (2 * e - 1) * m.travel * s;
    pos = [dir[0] * d, dir[1] * d, 0];
    zoom = 1 + m.zoom * s * e;
    keep = false;
    pan = [dir[0] * d, dir[1] * d];
  } else if (plan.preset === 'vertigo') {
    // Pull back while zooming in: the subject keeps its size, the background grows.
    const e = easeSmoother(t);
    const back = m.pull * s * e;
    pos = [0, 0, -back];
    zoom = (F[2] + back) / F[2];
  }
  const half = [w.hx / (zoom * plan.cover), w.hy / (zoom * plan.cover)];
  // The lens shift that keeps the subject where it was in the frame (most moves),
  // or that follows the camera (the pan).
  let shift, anchor = [0, 0];
  if (keep) {
    const view0 = { pos, yaw, pitch, shift: [0, 0], half: [1, 1] };
    const q = projectWorld(view0, F); // where the subject lands, unshifted, in units of distance 1
    const fx = (F[0] / F[2] - w.cx) / w.hx, fy = (F[1] / F[2] - w.cy) / w.hy; // its place in the first frame
    shift = [q.x - fx * half[0], q.y - fy * half[1]];
    anchor = [fx, fy];
  } else {
    shift = [w.cx + pan[0], w.cy + pan[1]];
  }
  return { pos, yaw, pitch, shift, half, zoom, anchor };
}

/**
 * The zoom (1 or more) a plan needs so that no point of any layer's edge shows
 * inside the frame, at any time of the move.
 * @param {ReturnType<typeof planCamera>} plan
 * @param {{ u: number, v: number, d: number }[][]} borders
 * @param {number} [steps]
 */
export function coverZoom(plan, borders, steps = 120) {
  let need = 1;
  const saved = plan.cover;
  plan.cover = 1;
  for (let i = 0; i <= steps; i++) {
    const view = cameraAt(plan, i / steps);
    for (const layer of borders) {
      for (const p of layer) {
        const q = projectPoint(plan, view, p.u, p.v, p.d);
        if (!(q.z > 0)) continue;
        if (Math.max(Math.abs(q.x), Math.abs(q.y)) >= 1) continue;
        // The framing zooms about the anchor (the subject, held still): the zoom at
        // which this point leaves the frame by the nearer side.
        let z = Infinity;
        for (const [n, a] of [[q.x, view.anchor[0]], [q.y, view.anchor[1]]]) {
          const dn = n - a;
          if (Math.abs(dn) > 1e-9) z = Math.min(z, ((dn > 0 ? 1 : -1) - a) / dn);
        }
        if (Number.isFinite(z)) need = Math.max(need, z);
      }
    }
  }
  plan.cover = saved;
  return need;
}

/**
 * The most two points of the subject's place, at disparities d0 and d1, part
 * during a move, in heights of the photo.
 */
export function maxParallax(plan, [d0, d1], steps = 48) {
  let most = 0;
  for (let i = 0; i <= steps; i++) {
    const view = cameraAt(plan, i / steps);
    const a = projectPoint(plan, view, plan.focus.u, plan.focus.v, d0), b = projectPoint(plan, view, plan.focus.u, plan.focus.v, d1);
    most = Math.max(most, Math.hypot((b.x - a.x) * view.half[0], (b.y - a.y) * view.half[1]));
  }
  return most;
}

/** Number of frames of a video of `seconds` at `fps`. */
export function frameCount(seconds, fps) {
  return Math.max(1, Math.round(seconds * fps));
}

/**
 * The time (0-1) of frame i of n. A loop never shows its first frame twice: its
 * last frame is one step before the start.
 */
export function frameTime(i, n, loop) {
  if (n <= 1) return 0;
  return loop ? i / n : i / (n - 1);
}
