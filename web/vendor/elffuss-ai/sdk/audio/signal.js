// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Small signal helpers over planar Float32 channels: the waveform a player
// draws, fades, a measure of a clip (peak, RMS, clipped and silent share), and
// the joining of speech chunks with pauses and short fades, so no seam clicks.
// Pure, no DOM.

/**
 * Min and max of each of `buckets` slices of the mix of the channels, for a
 * waveform: [min0, max0, min1, max1, …].
 * @param {Float32Array[]} channels
 * @param {number} buckets
 * @returns {Float32Array}
 */
export function peaks(channels, buckets) {
  const n = channels[0]?.length || 0;
  const k = Math.max(1, Math.floor(buckets));
  const out = new Float32Array(k * 2);
  for (let b = 0; b < k; b++) {
    const from = Math.floor((b * n) / k), to = Math.max(from + 1, Math.floor(((b + 1) * n) / k));
    let lo = 0, hi = 0;
    for (let i = from; i < to && i < n; i++) {
      let s = 0;
      for (const c of channels) s += c[i];
      s /= channels.length;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    out[b * 2] = lo; out[b * 2 + 1] = hi;
  }
  return out;
}

/** Raised-cosine fade in over the first `samples` samples (in place). */
export function fadeIn(channel, samples) {
  const n = Math.min(samples, channel.length);
  for (let i = 0; i < n; i++) channel[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
  return channel;
}

/** Raised-cosine fade out over the last `samples` samples (in place). */
export function fadeOut(channel, samples) {
  const n = Math.min(samples, channel.length), L = channel.length;
  for (let i = 0; i < n; i++) channel[L - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
  return channel;
}

/**
 * Peak and RMS in dBFS, the share of samples at full scale and of short windows (a twentieth of a second)
 * below -60 dBFS, and the DC offset, over all channels.
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 */
export function measure(channels, sampleRate) {
  let peak = 0, sum = 0, clipped = 0, count = 0, dc = 0;
  for (const c of channels) {
    let m = 0;
    for (let i = 0; i < c.length; i++) {
      const a = Math.abs(c[i]);
      if (a > peak) peak = a;
      if (a >= 32766 / 32767) clipped++;
      sum += c[i] * c[i]; m += c[i];
    }
    count += c.length;
    dc = Math.max(dc, Math.abs(m / (c.length || 1)));
  }
  const win = Math.max(1, Math.round(sampleRate * 0.05));
  const n = channels[0]?.length || 0;
  let silent = 0, windows = 0;
  for (let w = 0; w + win <= n; w += win) {
    let e = 0;
    for (const c of channels) for (let i = w; i < w + win; i++) e += c[i] * c[i];
    windows++;
    if (e / (win * channels.length) < 1e-6) silent++;
  }
  const db = x => (x > 0 ? 20 * Math.log10(x) : -Infinity);
  return { peakDb: db(peak), rmsDb: db(Math.sqrt(sum / (count || 1))), clipped: clipped / (count || 1), silent: windows ? silent / windows : 1, dc, seconds: n / sampleRate };
}

/**
 * Where the sound of a mono clip starts and ends: the first and last sample
 * whose short neighbourhood (a hundredth of a second) rises above `floorDb`, padded by `pad` samples.
 * @returns {[number, number]} [start, end)
 */
export function soundBounds(samples, sampleRate, { floorDb = -45, pad = 0 } = {}) {
  const win = Math.max(1, Math.round(sampleRate * 0.01));
  const thr = 10 ** (floorDb / 20);
  let start = -1, end = -1;
  for (let w = 0; w < samples.length; w += win) {
    let m = 0;
    for (let i = w; i < Math.min(samples.length, w + win); i++) m = Math.max(m, Math.abs(samples[i]));
    if (m >= thr) { if (start < 0) start = w; end = Math.min(samples.length, w + win); }
  }
  if (start < 0) return [0, 0];
  return [Math.max(0, start - pad), Math.min(samples.length, end + pad)];
}

/**
 * Join mono speech chunks: each one cut to its sound (with a little margin),
 * faded in and out over a few milliseconds, then the pause that follows it.
 * @param {{ samples: Float32Array, pause: number }[]} chunks `pause` in seconds after the chunk
 * @param {number} sampleRate
 * @param {{ fadeMs?: number, marginMs?: number }} [opts]
 * @returns {Float32Array}
 */
export function joinSpeech(chunks, sampleRate, { fadeMs = 8, marginMs = 40 } = {}) {
  const fade = Math.round((sampleRate * fadeMs) / 1000), margin = Math.round((sampleRate * marginMs) / 1000);
  const parts = [];
  let total = 0;
  chunks.forEach((c, i) => {
    const [a, b] = soundBounds(c.samples, sampleRate, { pad: margin });
    const s = c.samples.slice(a, b);
    fadeIn(s, fade); fadeOut(s, fade);
    const gap = i < chunks.length - 1 ? Math.round(Math.max(0, c.pause) * sampleRate) : 0;
    parts.push([s, gap]);
    total += s.length + gap;
  });
  const out = new Float32Array(total);
  let o = 0;
  for (const [s, gap] of parts) { out.set(s, o); o += s.length + gap; }
  return out;
}
