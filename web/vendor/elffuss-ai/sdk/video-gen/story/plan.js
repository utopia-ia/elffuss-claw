// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The storyboard of a video that does what it is asked: a keyframe every three
// seconds, all of the same subject in the same place, and a clip between each
// pair. Pure functions, no model: the plan from a request (a template, when no
// language model writes it), the check of a plan a language model wrote, the
// size from a photo's shape, and where a photo sits in the frame without
// cropping it.
//
// How a keyframe is made, in the plan:
//   { image: 'start' | 'end' }     the person's photo, as it is
//   { prompt }                     from the text alone (the first, when there is no photo)
//   { prompt, from: k, t }         SDEdit from keyframe k: noised to time t (π/2 is all
//                                  noise), then denoised with the new text; t 1.45 keeps
//                                  the subject, the place and the light and lets the pose
//                                  change a little; 1.57 (π/2) is the text alone with the
//                                  same seed, for a move of the whole body (run, jump, turn
//                                  round, stand up), which 1.45 does not reach
// Big changes go a little at a time over the keyframes: a change that appears only
// in the last one is crammed into the last frames of its clip.

import { AiError } from '../../core/errors.js';

/** Seconds between keyframes. */
export const SHOT_SECONDS = 3;
/** Clips of the longest video (9 s). */
export const MAX_CLIPS = 3;
/** Frames of a clip: one shot at Wan's frame rate, 1 + 4k (49 = 1 + 4 · 12). */
export const CLIP_FRAMES = 49;
/** Frames of a clip handed on to the next one, and the extra frames that clip makes so each adds 3 s. */
export const CARRY = 5;
/** SDEdit start time of a keyframe made from the one before. */
export const SDEDIT_TIME = 1.45;
/** …and of one whose pose changes a lot (running, jumping, turning round, standing up): the text alone, same seed. */
export const BIG_CHANGE_TIME = 1.57;

// Actions that move the whole body: from 1.45 SANA keeps the pose (a standing fox does not start
// running), so their keyframe starts from the text alone. Spanish and English, any form.
const BIG_MOVES = /\b(run|runs|running|ran|dash(es|ing)?|sprint|jump|jumps|jumping|leap|turns? (a)?round|turning round|stand(s|ing)? up|gets? up|sits? down|lies? down|flies|flying|takes? off|corre|corren|corriendo|correr|sale corriendo|echa a correr|salta|saltan|saltando|saltar|brinca|se levanta|se pone de pie|de pie|se sienta|se tumba|se acuesta|se da la vuelta|da media vuelta|gira el cuerpo|vuela|volando|despega|huye)\b/i;

/** True when an action moves the whole body (see BIG_MOVES). */
export const isBigChange = text => BIG_MOVES.test(String(text || ''));
/** The longest a prompt of the plan can be, in characters. */
export const MAX_PROMPT = 600;

/** The sizes a storyboard is made at, by shape: wide, tall, square (multiples of 16, about 0.4 Mpx). */
export const STORY_SIZES = Object.freeze({ '16:9': '832x480', '9:16': '480x832', '1:1': '624x624' });

/** Clips of a video of about `seconds` (1 to MAX_CLIPS). */
export function clipCount(seconds) {
  const s = Number(seconds);
  if (!(s > 0)) throw new AiError('too-large', 'a storyboard needs a duration');
  return Math.min(MAX_CLIPS, Math.max(1, Math.ceil(s / SHOT_SECONDS - 1e-9)));
}

/** Frames of each clip, in order: the first full, the next ones longer by the frames they take over. */
export function clipFrames(clips, carry = CARRY) {
  return Array.from({ length: clips }, (_, i) => (i === 0 || !carry ? CLIP_FRAMES : CLIP_FRAMES + carry - 1));
}

/** Total frames of the stitched video. */
export function videoFrames(clips, carry = CARRY) {
  return clipFrames(clips, carry).reduce((s, n, i) => s + (i === 0 ? n : n - (carry || 1)), 0);
}

/**
 * The storyboard size closest to a picture's shape (by the ratio's logarithm).
 * @returns {'832x480'|'480x832'|'624x624'}
 */
export function sizeForAspect(width, height) {
  if (!(width > 0 && height > 0)) return STORY_SIZES['16:9'];
  const r = Math.log(width / height);
  let best = null, bd = Infinity;
  for (const [k, size] of Object.entries(STORY_SIZES)) {
    const [a, b] = k.split(':').map(Number);
    const d = Math.abs(Math.log(a / b) - r);
    if (d < bd) { bd = d; best = size; }
  }
  return best;
}

/**
 * Where a picture of srcW × srcH goes in a frame of W × H so that all of it shows:
 * the largest centred rectangle with its shape (whole pixels).
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
export function containRect(srcW, srcH, W, H) {
  const s = Math.min(W / srcW, H / srcH);
  const w = Math.min(W, Math.round(srcW * s)), h = Math.min(H, Math.round(srcH * s));
  return { x: Math.floor((W - w) / 2), y: Math.floor((H - h) / 2), w, h };
}

// Words that join the actions of a request: commas, "and then", "y luego", …
const JOINERS = /\s*(?:[,;.]\s*(?:(?:and|y|e)\s+)?(?:(?:then|luego|después|despues|finalmente|finally|al final)\s+)?|\s+(?:and then|y luego|y después|y despues|then|luego|después|despues|y finalmente|and finally|finalmente|finally)\s+|\s+(?:and|y|e)\s+(?=(?:se|sale|salta|mira|corre|vuelve|empieza|comienza|termina|acaba|it|he|she|they|the|turns|looks|runs|jumps|starts|stands|walks|flies|haz|haga|que)\b))\s*/i;

/**
 * The actions of a request, in order: its pieces between commas and joining words.
 * The first piece usually holds the subject and the place too.
 * @param {string} text
 * @returns {string[]}
 */
export function splitActions(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '')
    .split(JOINERS).map(s => s.trim().replace(/^(?:and|y|e|que)\s+/i, '')).filter(Boolean);
}

/** The pieces spread over `n` slots, in order (some slots share a piece when there are fewer). */
function spread(pieces, n) {
  if (!pieces.length) return Array.from({ length: n }, () => []);
  if (pieces.length >= n) {
    const out = Array.from({ length: n }, () => []);
    pieces.forEach((p, i) => out[Math.min(n - 1, Math.floor((i * n) / pieces.length))].push(p));
    return out;
  }
  return Array.from({ length: n }, (_, i) => [pieces[Math.min(pieces.length - 1, Math.floor((i * pieces.length) / n))]]);
}

/** How far along a change is at the end of clip `pos` of the `len` it spans: words the models read as a degree. */
function degree(pos, len, lang) {
  const words = lang === 'es' ? ['empezando', 'a medias', 'del todo'] : ['beginning', 'halfway', 'completely'];
  if (pos >= len) return words[2];
  return pos * 2 <= len ? words[0] : words[1];
}

/**
 * A storyboard from a request, without a language model: the request split into
 * its actions, spread over the clips; each keyframe shows what has happened by then
 * (a change that spans several clips is written as a degree: beginning, halfway,
 * completely), and each one after the first comes from the one before (SDEdit).
 * @param {{ prompt: string, seconds?: number, start?: boolean, end?: boolean, seed?: number, lang?: 'es'|'en' }} req
 *   `start` / `end`: the person gives a first / last photo
 * @returns {{ seed: number, style: string, shots: object[], clips: string[] }}
 */
export function planStory({ prompt, seconds = 9, start = false, end = false, seed = 1, lang = 'es' } = {}) {
  const text = String(prompt || '').trim();
  if (!text && !(start && end)) throw new AiError('decode-failed', 'a storyboard needs a description or two photos');
  const n = clipCount(seconds);
  const [scene = '', ...rest] = splitActions(text);
  // The first piece is the subject in its place and, often, the first thing it does.
  const actions = rest.length ? [scene, ...rest] : [scene];
  const perClip = spread(actions, n).map(p => p.join(', '));
  // A piece spread over several clips is one change in degrees: where clip i is in its run.
  const run = perClip.map((p, i) => {
    let s = i, e = i;
    while (s > 0 && perClip[s - 1] === p) s--;
    while (e < n - 1 && perClip[e + 1] === p) e++;
    return { pos: i - s + 1, len: e - s + 1 };
  });
  const withScene = what => clip(scene && what !== scene ? `${scene}, ${what}` : what);
  const shots = [];
  for (let k = 0; k <= n; k++) {
    if (k === 0 && start) shots.push({ image: 'start' });
    else if (k === n && end) shots.push({ image: 'end' });
    else if (k === 0) shots.push({ prompt: clip(`${scene}, ${lang === 'es' ? 'al principio' : 'at the start'}`) });
    else {
      const r = run[k - 1];
      const deg = r.len > 1 ? ` (${degree(r.pos, r.len, lang)})` : '';
      const what = perClip[k - 1];
      // a new big move (not the one already shown in the keyframe before) starts from the text alone
      const big = isBigChange(what) && (k < 2 || perClip[k - 2] !== what || r.pos === 1);
      shots.push({ prompt: clip(withScene(what) + deg), from: k - 1, t: big ? BIG_CHANGE_TIME : SDEDIT_TIME });
    }
  }
  const still = lang === 'es' ? 'movimiento suave y natural' : 'smooth natural motion';
  return { seed: seed >>> 0, style: '', shots, clips: perClip.map(p => withScene(p) || still) };
}

const clip = s => String(s).replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT);

/**
 * Check and normalise a plan (from planStory or written by a language model).
 * @param {any} plan { seed?, style?, shots: [{ prompt? , image?, from?, t? }], clips: [string] }
 * @param {{ start?: boolean, end?: boolean }} [given] the photos the person gave
 * @returns {{ seed: number, style: string, shots: { prompt: string, image: 'start'|'end'|null, from: number|null, t: number }[], clips: string[] }}
 */
export function checkPlan(plan, { start = false, end = false } = {}) {
  const bad = msg => new AiError('decode-failed', 'the storyboard is not valid: ' + msg);
  if (!plan || typeof plan !== 'object') throw bad('not an object');
  const clips = Array.isArray(plan.clips) ? plan.clips.map(c => clip(c)) : null;
  if (!clips || clips.length < 1 || clips.length > MAX_CLIPS) throw bad(`it needs 1 to ${MAX_CLIPS} clips`);
  if (clips.some(c => !c)) throw bad('a clip has no description');
  if (!Array.isArray(plan.shots) || plan.shots.length !== clips.length + 1) throw bad('it needs one keyframe more than clips');
  const shots = plan.shots.map((s, k) => {
    if (!s || typeof s !== 'object') throw bad(`keyframe ${k} is not an object`);
    const image = s.image === 'start' || s.image === 'end' ? s.image : null;
    if (image === 'start' && (k !== 0 || !start)) throw bad('the start photo goes first, and only when there is one');
    if (image === 'end' && (k !== plan.shots.length - 1 || !end)) throw bad('the end photo goes last, and only when there is one');
    const prompt = clip(s.prompt || '');
    if (!image && !prompt) throw bad(`keyframe ${k} has neither a photo nor a description`);
    let from = s.from == null ? null : Number(s.from);
    if (from != null && !(Number.isInteger(from) && from >= 0 && from < k)) throw bad(`keyframe ${k} comes from a later one`);
    if (image) from = null;
    const t = s.t == null ? SDEDIT_TIME : Number(s.t);
    if (!(t > 0 && t <= Math.PI / 2 + 1e-6)) throw bad(`keyframe ${k}: t must be in (0, π/2]`);
    return { prompt, image, from, t };
  });
  if (start && shots[0].image !== 'start') throw bad('there is a start photo and the first keyframe is not it');
  if (end && shots[shots.length - 1].image !== 'end') throw bad('there is an end photo and the last keyframe is not it');
  const seed = plan.seed == null ? 1 : Number(plan.seed);
  if (!(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff)) throw bad('the seed must be an integer from 0 to 4294967295');
  return { seed, style: clip(plan.style || ''), shots, clips };
}

/** The prompt of keyframe k or clip i with the plan's shared style. */
export const withStyle = (plan, text) => (plan.style ? `${text}, ${plan.style}` : text);

/**
 * What a language model is told to write (the chat's storyboard tool). English, as the
 * models read English best; the person's words may be in any language.
 */
export const PLAN_GUIDE = `Write a storyboard as JSON: {"seed": <int>, "style": <words shared by every shot: subject's look, place, light, camera, e.g. "a red fox with a white chest, misty pine forest at dawn, golden light, cinematic, photorealistic">, "shots": [...], "clips": [...]}.
One clip per 3 seconds (at most ${MAX_CLIPS}); one more shot than clips. A shot is the frame at a clip's border: {"prompt": "<what is seen at that moment>"}; every shot after the first has "from": <index of the shot it is painted from, usually the one before>, "t": 1.45 (keeps subject, place and light; use 1.57 only when the pose changes completely). A given start photo is {"image": "start"} as the first shot; an end photo {"image": "end"} as the last. A clip is what happens between two shots, one short sentence in English.
Spread big changes over the shots: if it starts snowing, the second shot already shows a little snow on the ground and the last one a lot; never leave a change for the last shot only.`;
