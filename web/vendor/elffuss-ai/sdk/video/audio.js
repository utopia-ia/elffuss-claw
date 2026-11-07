// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The soundtrack of a video. Decoding a sound file needs Web Audio, which only
// exists in a page (not in a Worker): decodeSoundtrack() is the one part of the
// video task that runs in the page, before the task's Worker gets the samples.
// fitSoundtrack() is pure: it makes the samples exactly as long as the video,
// looping a short piece and fading in and out so nothing clicks.

import { AiError } from '../core/errors.js';

/** The sample rate of every soundtrack (what the encoders take). */
export const SAMPLE_RATE = 48000;

/**
 * Samples of one channel or two, exactly `seconds` long: cut, or looped with a
 * short cross-fade when the sound is shorter, then faded in and out.
 * @param {{ sampleRate: number, channels: Float32Array[] }} sound
 * @param {number} seconds
 * @param {{ fadeIn?: number, fadeOut?: number, cross?: number }} [o] in seconds
 * @returns {{ sampleRate: number, channels: Float32Array[] }} two channels
 */
export function fitSoundtrack(sound, seconds, { fadeIn = 0.04, fadeOut = 0.6, cross = 0.25 } = {}) {
  const sr = sound.sampleRate;
  const n = Math.max(1, Math.round(seconds * sr));
  const src = sound.channels.length ? sound.channels : [new Float32Array(1)];
  const len = src[0].length;
  const xf = Math.min(Math.round(cross * sr), Math.floor(len / 4));
  const out = [0, 1].map(c => {
    const s = src[Math.min(c, src.length - 1)];
    const o = new Float32Array(n);
    if (len === 0) return o;
    if (len >= n) { o.set(s.subarray(0, n)); return o; }
    // Loop: each pass after the first starts xf samples early, cross-faded over the end of the last.
    let pos = 0;
    while (pos < n) {
      for (let i = 0; i < len && pos + i < n; i++) {
        const v = s[i];
        if (pos > 0 && i < xf) { const k = i / xf; o[pos + i] = o[pos + i] * (1 - k) + v * k; } else o[pos + i] = v;
      }
      pos += len - xf;
      if (len - xf <= 0) break;
    }
    return o;
  });
  const fi = Math.min(n, Math.round(fadeIn * sr)), fo = Math.min(n, Math.round(fadeOut * sr));
  for (const o of out) {
    for (let i = 0; i < fi; i++) o[i] *= i / fi;
    for (let i = 0; i < fo; i++) o[n - 1 - i] *= i / fo;
  }
  return { sampleRate: sr, channels: out };
}

/**
 * Decode a sound file in the page (any format the browser plays), at
 * SAMPLE_RATE. Fails with unsupported-format when it is not a sound.
 * @param {Blob} blob
 * @returns {Promise<{ sampleRate: number, channels: Float32Array[] }>}
 */
export async function decodeSoundtrack(blob) {
  const Ctx = globalThis.OfflineAudioContext;
  if (typeof Ctx !== 'function') throw new AiError('unsupported-format', 'this browser cannot decode sound here (it needs a page, not a Worker)');
  const bytes = await blob.arrayBuffer();
  const ctx = new Ctx(2, 1, SAMPLE_RATE);
  let buf;
  try { buf = await ctx.decodeAudioData(bytes); } catch (err) { throw new AiError('unsupported-format', 'not a sound this browser decodes', { cause: err }); }
  const channels = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) channels.push(Float32Array.from(buf.getChannelData(c)));
  return { sampleRate: buf.sampleRate, channels };
}

/**
 * Whatever a caller passes as a soundtrack, as samples: a Blob or File (decoded
 * here, in the page), an AudioBuffer, or `{ sampleRate, channels }` already.
 * @returns {Promise<{ sampleRate: number, channels: Float32Array[] } | null>}
 */
export async function soundtrackOf(audio) {
  if (audio == null) return null;
  if (typeof Blob !== 'undefined' && audio instanceof Blob) return decodeSoundtrack(audio);
  if (audio && typeof audio.getChannelData === 'function') {
    const channels = [];
    for (let c = 0; c < Math.min(2, audio.numberOfChannels); c++) channels.push(Float32Array.from(audio.getChannelData(c)));
    return { sampleRate: audio.sampleRate, channels };
  }
  if (audio && Number(audio.sampleRate) > 0 && Array.isArray(audio.channels) && audio.channels.every(c => c instanceof Float32Array)) return { sampleRate: Number(audio.sampleRate), channels: audio.channels.slice(0, 2) };
  throw new AiError('unsupported-format', 'a soundtrack is a sound file, an AudioBuffer or { sampleRate, channels }');
}
