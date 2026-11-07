// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Picture sizes. SANA-Sprint was trained on a fixed set of sizes of about a
// megapixel (diffusers' ASPECT_RATIO_1024_BIN, height × width); like the
// reference pipeline, a requested size is generated at the trained size of the
// nearest shape and then scaled and cropped to what was asked. The aspect presets
// are trained sizes, so they are generated as they are.

/** Trained sizes, keyed by height / width, as [height, width], in the reference's order. */
export const TRAINED_SIZES = Object.freeze({
  '0.25': [512, 2048], '0.28': [512, 1856], '0.32': [576, 1792], '0.33': [576, 1728], '0.35': [576, 1664],
  '0.4': [640, 1600], '0.42': [640, 1536], '0.48': [704, 1472], '0.5': [704, 1408], '0.52': [704, 1344],
  '0.57': [768, 1344], '0.6': [768, 1280], '0.68': [832, 1216], '0.72': [832, 1152], '0.78': [896, 1152],
  '0.82': [896, 1088], '0.88': [960, 1088], '0.94': [960, 1024], '1.0': [1024, 1024], '1.07': [1024, 960],
  '1.13': [1088, 960], '1.21': [1088, 896], '1.29': [1152, 896], '1.38': [1152, 832], '1.46': [1216, 832],
  '1.67': [1280, 768], '1.75': [1344, 768], '2.0': [1408, 704], '2.09': [1472, 704], '2.4': [1536, 640],
  '2.5': [1600, 640], '3.0': [1728, 576], '4.0': [2048, 512],
});

/** The shapes offered by name (width:height), each a trained size. */
export const ASPECTS = Object.freeze({
  '1:1': { width: 1024, height: 1024 },
  '4:3': { width: 1152, height: 896 },
  '3:2': { width: 1216, height: 832 },
  '16:9': { width: 1344, height: 768 },
  '3:4': { width: 896, height: 1152 },
  '2:3': { width: 832, height: 1216 },
  '9:16': { width: 768, height: 1344 },
});

/** Smallest and largest side a caller may ask for. */
export const MIN_SIDE = 256;
export const MAX_SIDE = 2048;

/** The trained size nearest in shape to width × height (the reference's rule, first on a tie). */
export function nearestTrained(width, height) {
  const ratio = height / width;
  let best = null, gap = Infinity;
  for (const [key, size] of Object.entries(TRAINED_SIZES)) {
    const d = Math.abs(Number(key) - ratio);
    if (d < gap) { gap = d; best = size; }
  }
  return { height: best[0], width: best[1] };
}

/**
 * The size to generate at and the size to give back.
 * @param {{ aspect?: string, width?: number, height?: number }} req
 * @returns {{ width: number, height: number, genWidth: number, genHeight: number, aspect: string|null }}
 */
export function resolveSize({ aspect, width, height } = {}) {
  if (width != null || height != null) {
    const w = Math.round(Number(width ?? height)), h = Math.round(Number(height ?? width));
    if (!(w >= MIN_SIDE && w <= MAX_SIDE && h >= MIN_SIDE && h <= MAX_SIDE)) throw new RangeError(`width and height go from ${MIN_SIDE} to ${MAX_SIDE}`);
    const g = nearestTrained(w, h);
    return { width: w, height: h, genWidth: g.width, genHeight: g.height, aspect: null };
  }
  const name = aspect == null ? '1:1' : String(aspect);
  const a = ASPECTS[name];
  if (!a) throw new RangeError(`aspect must be one of ${Object.keys(ASPECTS).join(', ')}`);
  return { width: a.width, height: a.height, genWidth: a.width, genHeight: a.height, aspect: name };
}
