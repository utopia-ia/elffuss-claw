// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// From one photo and its depth to layers a camera can move through. Where the
// depth jumps (a person in front of a wall), the photo is cut in two: what is
// near becomes a layer of its own, with a soft edge that follows the photo, and
// what is behind it is filled in (MI-GAN paints the colours, sdk/video/inpaint.js;
// the depth is filled here from around it), only where a real jump of depth can
// uncover it. planLayers can cut more than once; the task cuts once, which
// proved the cleanest. Each layer keeps its depth beyond its own edge, so its
// edge moves with it and never stretches.
// Pure functions over typed arrays, no canvas: Node tests them.

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Raw model output to disparity 0-1 (1 nearest), robust to a few wild values:
 * the `lo` and `hi` quantiles become 0 and 1.
 * @param {ArrayLike<number>} raw
 */
export function normalizeDisparity(raw, { lo = 0.005, hi = 0.995 } = {}) {
  const n = raw.length;
  const step = Math.max(1, Math.floor(n / 65536));
  const sample = [];
  for (let i = 0; i < n; i += step) if (Number.isFinite(raw[i])) sample.push(raw[i]);
  sample.sort((a, b) => a - b);
  const out = new Float32Array(n);
  if (!sample.length) return out;
  const a = sample[Math.floor(lo * (sample.length - 1))], b = sample[Math.ceil(hi * (sample.length - 1))];
  if (!(b > a)) return out;
  const k = 1 / (b - a);
  for (let i = 0; i < n; i++) out[i] = Number.isFinite(raw[i]) ? clamp01((raw[i] - a) * k) : 0;
  return out;
}

/** Bilinear resize of a one-channel plane (pixel centres at half-integers). */
export function resizePlane(src, w, h, W, H) {
  const out = new Float32Array(W * H);
  const sx = w / W, sy = h / H;
  for (let y = 0; y < H; y++) {
    const fy = Math.min(h - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
      const a = src[y0 * w + x0], b = src[y0 * w + x1], c = src[y1 * w + x0], d = src[y1 * w + x1];
      out[y * W + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}

/** Mean over a (2r+1)² box, the box clipped at the edges (separable running sums). */
export function boxMean(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) s += src[row + x];
    for (let x = 0; x < w; x++) {
      const lo = Math.max(0, x - r), hi = Math.min(w - 1, x + r);
      tmp[row + x] = s / (hi - lo + 1);
      if (x + r + 1 < w) s += src[row + x + r + 1];
      if (x - r >= 0) s -= src[row + x - r];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) s += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const lo = Math.max(0, y - r), hi = Math.min(h - 1, y + r);
      out[y * w + x] = s / (hi - lo + 1);
      if (y + r + 1 < h) s += tmp[(y + r + 1) * w + x];
      if (y - r >= 0) s -= tmp[(y - r) * w + x];
    }
  }
  return out;
}

/**
 * Guided filter (He, Sun and Tang): smooths `p` while keeping the edges of the
 * guide `I`, so a soft map snaps to the photo's edges.
 */
export function guidedFilter(I, p, w, h, r, eps) {
  const n = w * h;
  const Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mI = boxMean(I, w, h, r), mp = boxMean(p, w, h, r), mIp = boxMean(Ip, w, h, r), mII = boxMean(II, w, h, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cov = mIp[i] - mI[i] * mp[i], v = mII[i] - mI[i] * mI[i];
    a[i] = cov / (v + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = boxMean(a, w, h, r), mb = boxMean(b, w, h, r);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ma[i] * I[i] + mb[i];
  return out;
}

/** Luma 0-1 of RGBA pixels. */
export function toGray(rgba, w, h) {
  const out = new Float32Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) / 255;
  return out;
}

/** Binary dilation (r > 0) or erosion (r < 0) with a square of side 2|r|+1. */
export function morph(mask, w, h, r) {
  if (!r) return Uint8Array.from(mask);
  const grow = r > 0, k = Math.abs(r);
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  const pass = (src, dst, len, count, at) => {
    for (let line = 0; line < count; line++) {
      let run = 0; // pixels of the sought value within the window
      const want = grow ? 1 : 0;
      for (let i = 0; i <= Math.min(k, len - 1); i++) if ((src[at(line, i)] ? 1 : 0) === want) run++;
      for (let i = 0; i < len; i++) {
        dst[at(line, i)] = grow ? (run > 0 ? 1 : 0) : (run > 0 ? 0 : 1);
        if (i + k + 1 < len && (src[at(line, i + k + 1)] ? 1 : 0) === want) run++;
        if (i - k >= 0 && (src[at(line, i - k)] ? 1 : 0) === want) run--;
      }
    }
  };
  pass(mask, tmp, w, h, (y, x) => y * w + x);
  pass(tmp, out, h, w, (x, y) => y * w + x);
  return out;
}

/** Connected parts (4-neighbours) of a mask: their label per pixel and their sizes. */
export function components(mask, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const sizes = [];
  const stack = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s] >= 0) continue;
    const id = sizes.length;
    let top = 0, n = 0;
    stack[top++] = s; label[s] = id;
    while (top) {
      const p = stack[--top]; n++;
      const x = p % w, y = (p - x) / w;
      if (x > 0 && mask[p - 1] && label[p - 1] < 0) { label[p - 1] = id; stack[top++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && label[p + 1] < 0) { label[p + 1] = id; stack[top++] = p + 1; }
      if (y > 0 && mask[p - w] && label[p - w] < 0) { label[p - w] = id; stack[top++] = p - w; }
      if (y < h - 1 && mask[p + w] && label[p + w] < 0) { label[p + w] = id; stack[top++] = p + w; }
    }
    sizes.push(n);
  }
  return { label, sizes };
}

/** A mask without its parts smaller than `minArea` pixels, and without holes smaller than it. */
export function cleanMask(mask, w, h, minArea) {
  const out = Uint8Array.from(mask);
  const fg = components(out, w, h);
  for (let i = 0; i < out.length; i++) if (out[i] && fg.sizes[fg.label[i]] < minArea) out[i] = 0;
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < inv.length; i++) inv[i] = out[i] ? 0 : 1;
  const bg = components(inv, w, h);
  for (let i = 0; i < out.length; i++) if (!out[i] && bg.sizes[bg.label[i]] < minArea) out[i] = 1;
  return out;
}

/**
 * Fill the unknown pixels of a map from the known ones around them, smoothly
 * (push-pull: averages up a pyramid of halvings, then back down). `known` is a
 * weight 0-1 per pixel; `channels` values per pixel.
 * @returns {Float32Array} the map, known pixels kept as they were
 */
export function pushPull(values, known, w, h, channels = 1) {
  const levels = [{ w, h, v: Float32Array.from(values), k: Float32Array.from(known) }];
  for (let i = 0; i < levels[0].v.length; i++) levels[0].v[i] *= levels[0].k[Math.floor(i / channels)];
  while (levels.at(-1).w > 1 || levels.at(-1).h > 1) {
    const a = levels.at(-1);
    const W = Math.max(1, Math.ceil(a.w / 2)), H = Math.max(1, Math.ceil(a.h / 2));
    const v = new Float32Array(W * H * channels), k = new Float32Array(W * H);
    for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
      const o = (y >> 1) * W + (x >> 1), p = y * a.w + x;
      k[o] += a.k[p];
      for (let c = 0; c < channels; c++) v[o * channels + c] += a.v[p * channels + c];
    }
    // Keep premultiplied sums, with the weight capped at 1 as the known share.
    for (let i = 0; i < W * H; i++) {
      if (k[i] > 1) { for (let c = 0; c < channels; c++) v[i * channels + c] /= k[i]; k[i] = 1; }
    }
    levels.push({ w: W, h: H, v, k });
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const a = levels[l], b = levels[l + 1];
    for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
      const p = y * a.w + x;
      const kk = a.k[p];
      if (kk >= 1) continue;
      // Bilinear sample of the coarser level at this pixel's centre.
      const fx = Math.min(b.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), fy = Math.min(b.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(b.w - 1, x0 + 1), y1 = Math.min(b.h - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
      const wts = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty], idx = [y0 * b.w + x0, y0 * b.w + x1, y1 * b.w + x0, y1 * b.w + x1];
      let bk = 0;
      for (let j = 0; j < 4; j++) bk += wts[j] * b.k[idx[j]];
      if (!(bk > 0)) continue;
      for (let c = 0; c < channels; c++) {
        let bv = 0;
        for (let j = 0; j < 4; j++) bv += wts[j] * b.v[idx[j] * channels + c];
        a.v[p * channels + c] = a.v[p * channels + c] + (1 - kk) * (bv / bk);
      }
      a.k[p] = 1;
    }
  }
  const out = levels[0].v;
  // Known pixels: back to their own values (they were weighted by their share).
  for (let i = 0; i < w * h; i++) {
    const k = known[i];
    if (k >= 1) for (let c = 0; c < channels; c++) out[i * channels + c] = values[i * channels + c];
  }
  return out;
}

/**
 * The depth to cut at, if the photo has a real jump: for candidate thresholds,
 * the mean jump of depth across the edge of what is nearer, measured `reach`
 * pixels apart. The best one wins if its jump is at least `minJump` and what is
 * near covers between `minArea` and `maxArea` of the photo.
 * @returns {{ threshold: number, jump: number, area: number } | null}
 */
export function chooseSplit(d, w, h, { known = null, reach = Math.max(2, Math.round(Math.max(w, h) / 120)), minJump = 0.12, minArea = 0.01, maxArea = 0.8 } = {}) {
  const vals = [];
  for (let i = 0; i < d.length; i += 7) if (!known || known[i]) vals.push(d[i]);
  if (vals.length < 16) return null;
  vals.sort((a, b) => a - b);
  // Thresholds halfway between successive quantiles, so that a cut can fall in a
  // gap of the histogram (between the ground and what stands on it).
  const qs = [];
  for (let q = 0.15; q <= 0.975 + 1e-9; q += 0.025) qs.push(vals[Math.floor(q * (vals.length - 1))]);
  const candidates = [...new Set(qs.slice(1).map((v, i) => (v + qs[i]) / 2))];
  let best = null;
  for (const T of candidates) {
    let area = 0, sum = 0, n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (known && !known[i]) continue;
      if (d[i] <= T) continue;
      area++;
      // An edge pixel of the near part: a neighbour at `reach` on the far side.
      for (const [dx, dy] of [[reach, 0], [-reach, 0], [0, reach], [0, -reach]]) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const j = Y * w + X;
        if (known && !known[j]) continue;
        if (d[j] <= T && d[x + Math.sign(dx) + (y + Math.sign(dy)) * w] <= T) { sum += d[i] - d[j]; n++; }
      }
    }
    const total = known ? known.reduce((s, k) => s + (k ? 1 : 0), 0) : w * h;
    const share = area / total;
    if (!n || share < minArea || share > maxArea) continue;
    const jump = sum / n;
    if (!best || jump > best.jump) best = { threshold: T, jump, area: share };
  }
  return best && best.jump >= minJump ? best : null;
}

/**
 * Plan the layers of a photo from its disparity (analysis size): the masks of
 * what is near (`maxCuts` of them, one by default), each cleaned, far to near.
 * @returns {{ cuts: { threshold: number, jump: number, area: number, mask: Uint8Array }[] }}
 */
export function planLayers(d, w, h, { maxCuts = 1 } = {}) {
  const minArea = Math.max(16, Math.round(w * h * 0.002));
  const cuts = [];
  let depth = d, known = null;
  for (let c = 0; c < maxCuts; c++) {
    const split = chooseSplit(depth, w, h, { known, minJump: c === 0 ? 0.12 : 0.14 });
    if (!split) break;
    const raw = new Uint8Array(w * h);
    for (let i = 0; i < raw.length; i++) raw[i] = (!known || known[i]) && depth[i] > split.threshold ? 1 : 0;
    const mask = cleanMask(raw, w, h, minArea);
    if (!mask.some(Boolean)) break;
    cuts.push({ ...split, mask });
    // What remains: everything farther, with the near part filled from around it.
    const keep = new Float32Array(w * h);
    for (let i = 0; i < keep.length; i++) keep[i] = (!known || known[i]) && !mask[i] ? 1 : 0;
    if (!keep.some(Boolean)) break;
    depth = pushPull(depth, keep, w, h);
    known = null;
  }
  // The near-most cut comes from the first split: order them far to near.
  return { cuts: cuts.reverse() };
}

/** Disparity of a map filled where `mask` is set, from the pixels around it (what lies behind). */
export function fillBehind(d, mask, w, h) {
  const keep = new Float32Array(w * h);
  for (let i = 0; i < keep.length; i++) keep[i] = mask[i] ? 0 : 1;
  return pushPull(d, keep, w, h);
}

/**
 * Disparity of a near layer: its own inside `mask` (eroded by `inset`, where
 * the depth model's edge is soft), carried outward beyond its edge so that the
 * edge moves with the layer.
 */
export function extendOutward(d, mask, w, h, inset = 2) {
  const core = morph(mask, w, h, -inset);
  const any = core.some(Boolean) ? core : mask;
  const keep = new Float32Array(w * h);
  for (let i = 0; i < keep.length; i++) keep[i] = any[i] ? 1 : 0;
  return pushPull(d, keep, w, h);
}

/**
 * The soft edge (alpha 0-1) of a mask at the photo's size, snapped to the
 * photo's own edges with a guided filter, then tightened so that it is not
 * wider than it must be.
 */
export function softAlpha(mask, mw, mh, gray, w, h, { radius = Math.max(2, Math.round(Math.max(w, h) / 400)), eps = 2e-3, steep = 1.6 } = {}) {
  const m = new Float32Array(mw * mh);
  for (let i = 0; i < m.length; i++) m[i] = mask[i] ? 1 : 0;
  const up = mw === w && mh === h ? m : resizePlane(m, mw, mh, w, h);
  const g = guidedFilter(gray, up, w, h, radius, eps);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = clamp01((g[i] - 0.5) * steep + 0.5);
  return out;
}

/**
 * Colours of a near layer where its edge is soft: those pixels mix the layer
 * with what was behind it, so their colour is taken from the solid inside of the
 * layer (carried outward), and only their alpha says how much shows. No fringe
 * of the old background then travels with the layer.
 */
export function decontaminate(rgba, alpha, w, h, solid = 0.92, where = null) {
  const n = w * h;
  const vals = new Float32Array(n * 3), keep = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    keep[i] = alpha[i] >= solid ? 1 : 0;
    vals[i * 3] = rgba[i * 4]; vals[i * 3 + 1] = rgba[i * 4 + 1]; vals[i * 3 + 2] = rgba[i * 4 + 2];
  }
  if (!keep.some(Boolean)) return Uint8ClampedArray.from(rgba);
  const f = pushPull(vals, keep, w, h, 3);
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    // Only where the edge is a real one (`where`): elsewhere what is behind is the
    // photo itself, and the photo's own colours join it with no seam.
    const own = where && !where[i];
    out[i * 4] = own ? rgba[i * 4] : f[i * 3]; out[i * 4 + 1] = own ? rgba[i * 4 + 1] : f[i * 3 + 1]; out[i * 4 + 2] = own ? rgba[i * 4 + 2] : f[i * 3 + 2];
    out[i * 4 + 3] = Math.round(alpha[i] * 255);
  }
  return out;
}

/**
 * Points of the photo's edge where a layer shows (alpha over 1/2), with its
 * disparity there: what the framing must keep out of the picture
 * (sdk/video/camera.js, coverZoom).
 * @param {{ alpha?: ArrayLike<number>|null, aw?: number, ah?: number, depth: ArrayLike<number>, dw: number, dh: number }} layer
 */
export function borderSamples({ alpha = null, aw = 0, ah = 0, depth, dw, dh }, per = 40) {
  const out = [];
  const at = (arr, w, h, u, v) => arr[Math.min(h - 1, Math.floor(v * h)) * w + Math.min(w - 1, Math.floor(u * w))];
  for (let i = 0; i <= per; i++) {
    const s = i / per;
    for (const [u, v] of [[s, 0], [s, 1], [0, s], [1, s]]) {
      if (alpha && at(alpha, aw, ah, Math.min(u, 0.9999), Math.min(v, 0.9999)) < 0.5) continue;
      out.push({ u, v, d: at(depth, dw, dh, Math.min(u, 0.9999), Math.min(v, 0.9999)) });
    }
  }
  return out;
}

/**
 * Where a near part can uncover what is behind it, and what of it the painter
 * must not see. `region`: its pixels within `radius` of a real jump of depth (a
 * neighbour `reach` pixels away and at least `jump` farther), grown by `grow`.
 * `hide`: the same within twice that radius, so the painter never sees the near
 * part next to where it paints and nothing of it leaks into the painting.
 * Elsewhere (where the part is cut from ground that goes on, the same depth on
 * both sides) nothing behind it ever shows: the layer behind keeps the photo as
 * it is there, with no painting and no seam, and the painter may read it.
 * `band` is `hide` before it grows (inside the part only) and `edge` the pixels of
 * the real jumps themselves.
 * @returns {{ region: Uint8Array, hide: Uint8Array, band: Uint8Array, edge: Uint8Array }}
 */
export function revealRegion(mask, d, w, h, { reach = Math.max(2, Math.round(Math.max(w, h) / 120)), jump = 0.08, radius = Math.round(Math.max(w, h) * 0.05), grow = 0 } = {}) {
  const edge = new Uint8Array(w * h), fake = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!mask[i]) continue;
    for (const [dx, dy] of [[reach, 0], [-reach, 0], [0, reach], [0, -reach]]) {
      const X = x + dx, Y = y + dy;
      if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
      const j = Y * w + X;
      if (mask[j]) continue;
      if (d[i] - d[j] >= jump) { edge[i] = 1; break; }
      // The part's edge with ground that goes on: behind it nothing ever shows.
      if (d[i] - d[j] < jump / 2 && mask[x + Math.sign(dx) + (y + Math.sign(dy)) * w] === 0) fake[i] = 1;
    }
  }
  for (let i = 0; i < fake.length; i++) if (edge[i]) fake[i] = 0;
  // Pixels nearer to a false edge than `radius` are never painted: the layer
  // behind keeps the photo there, which shows through the soft edge unchanged.
  const nearFake = morph(fake, w, h, radius);
  const within = (r, g) => { const band = morph(edge, w, h, r), out = new Uint8Array(w * h); for (let i = 0; i < out.length; i++) out[i] = band[i] & mask[i] & (nearFake[i] ? 0 : 1); return g ? morph(out, w, h, g) : out; };
  const band = within(radius * 2, 0);
  const hide = grow ? morph(band, w, h, grow) : band;
  const region = within(radius, grow);
  for (let i = 0; i < region.length; i++) region[i] &= hide[i];
  return { region, hide, band, edge };
}
