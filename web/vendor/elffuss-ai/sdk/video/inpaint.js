// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// What MI-GAN (Picsart AI Research, MIT) is given and what is done with what it
// paints. The model takes an RGB image and a mask, both bytes, the mask 255
// where the photo is kept and 0 where it must paint; it was trained on squares
// of 512, so the hole is cropped with some of its surroundings and scaled to
// about that size, and its answer is scaled back and laid only inside the hole,
// with a soft seam. Pure functions over typed arrays: Node tests them.

/** The side the model works best at. */
export const SIDE = 512;

/**
 * The part of the photo to give the model: the box of the hole, grown by
 * `margin` of its size on every side (context to paint from), inside the photo,
 * and the size it is scaled to (longest side SIDE, never enlarged, multiples of 8).
 * @returns {{ x: number, y: number, w: number, h: number, ow: number, oh: number } | null} null when there is no hole
 */
export function cropFor(hole, w, h, { margin = 0.35, side = SIDE } = {}) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (hole[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const mx = Math.round((x1 - x0 + 1) * margin) + 8, my = Math.round((y1 - y0 + 1) * margin) + 8;
  const x = Math.max(0, x0 - mx), y = Math.max(0, y0 - my);
  const cw = Math.min(w, x1 + 1 + mx) - x, ch = Math.min(h, y1 + 1 + my) - y;
  const k = Math.min(1, side / Math.max(cw, ch));
  const r8 = v => Math.max(8, Math.round(v / 8) * 8);
  return { x, y, w: cw, h: ch, ow: r8(cw * k), oh: r8(ch * k) };
}

/** Box-filter resample of RGBA (or any `ch`-channel bytes) from a crop of a picture to ow × oh. */
export function resampleCrop(src, sw, crop, ch = 4) {
  const { x: cx, y: cy, w: cw, h: chh, ow, oh } = crop;
  const out = new Float32Array(ow * oh * ch);
  const sx = cw / ow, sy = chh / oh;
  for (let y = 0; y < oh; y++) {
    const ya = cy + y * sy, yb = cy + (y + 1) * sy;
    for (let x = 0; x < ow; x++) {
      const xa = cx + x * sx, xb = cx + (x + 1) * sx;
      const acc = new Float64Array(ch);
      let wt = 0;
      for (let yy = Math.floor(ya); yy < Math.ceil(yb); yy++) {
        const wy = Math.min(yb, yy + 1) - Math.max(ya, yy);
        for (let xx = Math.floor(xa); xx < Math.ceil(xb); xx++) {
          const wx = Math.min(xb, xx + 1) - Math.max(xa, xx), q = wx * wy, o = (yy * sw + xx) * ch;
          for (let c = 0; c < ch; c++) acc[c] += src[o + c] * q;
          wt += q;
        }
      }
      for (let c = 0; c < ch; c++) out[(y * ow + x) * ch + c] = acc[c] / wt;
    }
  }
  return out;
}

/**
 * The model's two inputs for a crop: the image (1 × 3 × oh × ow, planar bytes)
 * and the mask (1 × 1 × oh × ow; 255 kept, 0 to paint; any pixel touched by the
 * hole is painted).
 */
export function modelInputs(rgba, hole, w, crop) {
  const n = crop.ow * crop.oh;
  const px = resampleCrop(rgba, w, crop, 4);
  const hm = resampleCrop(hole, w, crop, 1);
  const image = new Uint8Array(3 * n), mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const keep = hm[i] < 0.02;
    mask[i] = keep ? 255 : 0;
    for (let c = 0; c < 3; c++) image[c * n + i] = keep ? Math.round(px[i * 4 + c]) : 0;
  }
  return { image, mask };
}

/**
 * Lay what the model painted (1 × 3 × oh × ow bytes) into the hole of a copy of
 * the photo, scaled back to the crop (bilinear), blended over a seam of
 * `feather` pixels at the hole's edge (where `soft` says, 0-1, how much of the
 * painting shows; by default the hole itself).
 * @returns {Uint8ClampedArray} RGBA
 */
export function composite(rgba, w, h, crop, painted, soft) {
  const out = Uint8ClampedArray.from(rgba);
  const { x: cx, y: cy, w: cw, h: ch, ow, oh } = crop;
  const n = ow * oh;
  for (let y = cy; y < cy + ch; y++) {
    const fy = Math.min(oh - 1, Math.max(0, ((y - cy) + 0.5) * oh / ch - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(oh - 1, y0 + 1), ty = fy - y0;
    for (let x = cx; x < cx + cw; x++) {
      const i = y * w + x;
      const a = soft[i];
      if (!(a > 0)) continue;
      const fx = Math.min(ow - 1, Math.max(0, ((x - cx) + 0.5) * ow / cw - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(ow - 1, x0 + 1), tx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const p = c * n;
        const v = (painted[p + y0 * ow + x0] * (1 - tx) + painted[p + y0 * ow + x1] * tx) * (1 - ty) + (painted[p + y1 * ow + x0] * (1 - tx) + painted[p + y1 * ow + x1] * tx) * ty;
        out[i * 4 + c] = out[i * 4 + c] * (1 - a) + v * a;
      }
      out[i * 4 + 3] = 255;
    }
  }
  return out;
}
