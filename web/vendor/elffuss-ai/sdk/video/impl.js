// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The image-to-video task where the models run (a Worker, or the page with
// worker: false). A run turns a photo into its scene (depth with Depth Anything
// V2 Small, layers cut where the depth jumps, the background behind them painted
// by MI-GAN) and the scene into a video: the camera of camera.js, drawn with
// WebGL2 on an OffscreenCanvas (render.js) and encoded with WebCodecs
// (encode.js). The scene of the last photo is kept, so another move, length or
// format of the same photo goes straight to the drawing. dispose() releases the
// sessions and the drawing context.

import { AiError, toAiError } from '../core/errors.js';
import { decodeImage } from '../core/image-input.js';
import { releaseSession } from '../core/ort-env.js';
import { planCamera, cameraAt, frameCount, frameTime, RELIEF } from './camera.js';
import { normalizeOptions, outputSize } from './options.js';
import { normalizeDisparity, resizePlane, guidedFilter, toGray, planLayers, morph, fillBehind, pushPull, softAlpha, decontaminate, borderSamples, boxMean, revealRegion } from './layers.js';
import { cropFor, modelInputs, composite } from './inpaint.js';
import { depthInputSize, depthSpec, toDepthInput } from './depth.js';
import { createRenderer } from './render.js';
import { encodeVideo } from './encode.js';
import { fitSoundtrack } from './audio.js';

export const task = 'image-to-video';

/** Longest side of the photo kept for each quality (the frames are cut from it). */
export const PHOTO_SIDE = Object.freeze({ high: 2560, standard: 1664 });
/** The most a surface may stretch across the photo's depth during a move, in heights of the photo. */
export const STRETCH_LIMIT = 0.025;
/** The share of the painted band behind the subject a move may uncover. */
export const REVEAL_SHARE = 0.35;
/** Longest side the depth and the layers are worked out at. */
export const PLAN_SIDE = 768;
/** Longest side of the scene the page gets for its preview, by default. */
export const PREVIEW_SIDE = 1280;

export async function load(ctx) {
  const ort = await ctx.ort();
  const depthFile = ctx.files.find(f => f.part === 'depth' && f.path.endsWith('.onnx'));
  const inpaintFile = ctx.files.find(f => f.part === 'inpaint' && f.path.endsWith('.onnx'));
  if (!depthFile || !inpaintFile) throw new AiError('model-mismatch', 'this variant lacks the depth or the inpainting model');
  const spec = depthSpec(JSON.parse(await ctx.text('depth:preprocessor_config.json')));
  const depth = await ctx.session(depthFile.ref);
  if (ctx.test?.failLoad) { await releaseSession(depth); throw new AiError('run-failed', 'test hook: the load fails after the sessions exist'); }
  let inpaint, inpaintDevice = ctx.device;
  try { inpaint = await ctx.session(inpaintFile.ref); }
  catch (err) {
    if (ctx.device !== 'webgpu') throw err;
    inpaint = await ctx.session(inpaintFile.ref, { providers: ['wasm'] });
    inpaintDevice = 'wasm';
  }
  return { ort, depth, inpaint, spec, inpaintDevice, scene: null };
}

/** A content key of an input: equal photos get equal keys. */
async function keyOf(input, side) {
  if (typeof Blob !== 'undefined' && input instanceof Blob && globalThis.crypto?.subtle) {
    const h = await crypto.subtle.digest('SHA-256', await input.arrayBuffer());
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('') + ':' + side;
  }
  return null;
}

/** RGBA pixels scaled with the browser's own high-quality resampling. */
function scaleRgba(data, W, H, w, h) {
  if (w === W && h === H) return data;
  const a = new OffscreenCanvas(W, H);
  a.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), W, H), 0, 0);
  const b = new OffscreenCanvas(w, h);
  const g = b.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(a, 0, 0, w, h);
  return g.getImageData(0, 0, w, h).data;
}

const fitSide = (W, H, side) => { const k = Math.min(1, side / Math.max(W, H)); return [Math.max(2, Math.round(W * k)), Math.max(2, Math.round(H * k))]; };

/** Premultiply RGBA in place. */
function premultiply(px) {
  for (let i = 0; i < px.length; i += 4) { const a = px[i + 3] / 255; px[i] = Math.round(px[i] * a); px[i + 1] = Math.round(px[i + 1] * a); px[i + 2] = Math.round(px[i + 2] * a); }
  return px;
}

/** A mask at another size (nearest pixel). */
function scaleMask(m, w, h, W, H) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) { const sy = Math.min(h - 1, Math.floor((y + 0.5) * h / H)); for (let x = 0; x < W; x++) out[y * W + x] = m[sy * w + Math.min(w - 1, Math.floor((x + 0.5) * w / W))]; }
  return out;
}

/**
 * The photo with `region` (photo size) painted by MI-GAN, which sees the photo
 * without `hole` (all of what is near, so that none of it leaks into the painting).
 */
async function paint(state, rgba, W, H, hole, region = hole, fringe = null) {
  const crop = cropFor(hole, W, H);
  if (!crop) return rgba;
  const { image, mask } = modelInputs(rgba, hole, W, crop);
  const { ort } = state;
  const out = await state.inpaint.run({
    [state.inpaint.inputNames[0]]: new ort.Tensor('uint8', image, [1, 3, crop.oh, crop.ow]),
    [state.inpaint.inputNames[1]]: new ort.Tensor('uint8', mask, [1, 1, crop.oh, crop.ow]),
  });
  const t = out[state.inpaint.outputNames[0]];
  if (t?.dims?.[2] !== crop.oh || t?.dims?.[3] !== crop.ow) throw new AiError('model-mismatch', `the inpainting model gave ${t?.dims?.join('×')}`);
  // The model also redraws what it was given; where its colours drifted from the
  // photo's (a shade lighter, say), the painting is brought back to them, so that
  // what it paints joins the photo with no visible halo.
  const n = crop.ow * crop.oh, off = [0, 0, 0];
  let known = 0;
  for (let i = 0; i < n; i++) if (mask[i] === 255) { known++; for (let c = 0; c < 3; c++) off[c] += image[c * n + i] - t.data[c * n + i]; }
  const painted = new Uint8ClampedArray(t.data.length);
  for (let c = 0; c < 3; c++) { const o = known ? off[c] / known : 0; for (let i = 0; i < n; i++) painted[c * n + i] = t.data[c * n + i] + o; }
  const f = new Float32Array(W * H);
  for (let i = 0; i < f.length; i++) f[i] = region[i];
  const r = Math.max(3, Math.round(Math.max(W, H) / 250));
  const soft = boxMean(boxMean(f, W, H, r), W, H, r);
  // Laid inside the region only, fading in from its edge: nothing outside it changes.
  for (let i = 0; i < soft.length; i++) soft[i] = Math.max(region[i] ? Math.min(1, Math.max(0, soft[i] * 2 - 1)) : 0, fringe ? fringe[i] : 0);
  return composite(rgba, W, H, crop, painted, soft);
}

/** The subject when no near part stands out: the middle of the photo, at its median depth there. */
function centreFocus(d, w, h) {
  const ds = [];
  for (let y = Math.floor(h * 0.3); y < Math.ceil(h * 0.7); y++) for (let x = Math.floor(w * 0.3); x < Math.ceil(w * 0.7); x++) ds.push(d[y * w + x]);
  ds.sort((a, b) => a - b);
  return { u: 0.5, v: 0.5, d: ds[Math.floor(ds.length / 2)] ?? 0.5 };
}


/**
 * The scene of a photo: its layers far to near, their depth, the subject, and
 * the edge points the framing keeps out of the frame.
 */
async function buildScene(state, input, side, ctx) {
  const img = await decodeImage(input, { maxSide: side });
  const W = img.width, H = img.height, rgba = img.data;
  ctx.report('running', { stage: 'depth' });
  // Depth: the model's input as its preprocessor says, its answer back to the plan size.
  const [dw, dh] = depthInputSize(W, H, state.spec);
  const din = toDepthInput(scaleRgba(rgba, W, H, dw, dh), dw, dh, state.spec);
  const { ort } = state;
  const out = await state.depth.run({ [state.depth.inputNames[0]]: new ort.Tensor('float32', din, [1, 3, dh, dw]) });
  const pred = out[state.depth.outputNames[0]];
  const ph = pred.dims.at(-2), pw = pred.dims.at(-1);
  const [aw, ah] = fitSide(W, H, PLAN_SIDE);
  const planRgba = scaleRgba(rgba, W, H, aw, ah);
  const gray = toGray(planRgba, aw, ah);
  const raw = resizePlane(normalizeDisparity(pred.data), pw, ph, aw, ah);
  const d = Float32Array.from(guidedFilter(gray, raw, aw, ah, 3, 4e-3), v => Math.min(1, Math.max(0, v)));
  for (const t of Object.values(out)) t?.dispose?.();

  // Layers: cut where the depth jumps (one cut by default), far to near.
  const { cuts } = planLayers(d, aw, ah);
  const grow = Math.max(3, Math.round(PLAN_SIDE / 70));
  const texGray = toGray(rgba, W, H);
  const layers = [];
  const borders = [];
  let focus = null;
  let parallax = [];
  if (!cuts.length) {
    layers.push({ rgba: Uint8ClampedArray.from(rgba), width: W, height: H, depth: { data: d, width: aw, height: ah }, opaque: true });
    borders.push(borderSamples({ depth: d, dw: aw, dh: ah }));
    focus = centreFocus(d, aw, ah);
    const all = Float32Array.from(d).sort();
    parallax = [{ span: [all[Math.floor(all.length * 0.02)], all[Math.floor(all.length * 0.98)]], limit: STRETCH_LIMIT }];
  } else {
    ctx.report('running', { stage: 'inpaint' });
    // Two layers: what is near (the cut), and the rest with what the near part hid.
    const mask = cuts[0].mask;
    const reveal = revealRegion(mask, d, aw, ah, { grow, jump: 0.05, reach: Math.max(2, Math.round(PLAN_SIDE / 200)) });
    // The near part's edge: crisp, following the photo, where the depth jumps; wide
    // and soft where it is cut from ground that goes on (both layers show the same
    // photo at the same depth there, so the blend is invisible).
    const realPlan = morph(reveal.edge, aw, ah, grow * 2);
    const realTex = scaleMask(realPlan, aw, ah, W, H);
    const crisp = softAlpha(morph(mask, aw, ah, 1), aw, ah, texGray, W, H, { steep: 3 });
    const up = scaleMask(mask, aw, ah, W, H);
    const m = Float32Array.from(up);
    const r = Math.max(2, Math.round(Math.max(W, H) * 0.006));
    const wide = boxMean(boxMean(m, W, H, r), W, H, r);

    // Behind it, where its real edges can uncover it: MI-GAN paints it without
    // seeing the near part (`hide`), and only what the near part covers is replaced
    // (its inside, and just outside it only where its soft edge still shows the part,
    // whose pixels there would stay behind as a ghost of its outline). Every pixel
    // the photo shows around it stays the photo's own.
    const bandTex = scaleMask(reveal.band, aw, ah, W, H), hideTex = scaleMask(reveal.hide, aw, ah, W, H);
    const regionTex = new Uint8Array(W * H);
    for (let i = 0; i < regionTex.length; i++) regionTex[i] = bandTex[i] | (hideTex[i] & realTex[i] & (crisp[i] > 0.02 ? 1 : 0));
    // Just outside the part, at real edges, the photo's pixels may still hold some
    // of it (its soft edge, a halo of light around it): there each pixel is painted
    // over as much as its colour is nearer the part's than the painted background's.
    const zone = morph(bandTex, W, H, Math.max(3, Math.round(Math.max(W, H) / 150)));
    for (let i = 0; i < zone.length; i++) zone[i] &= hideTex[i] & realTex[i];
    const full = await paint(state, rgba, W, H, scaleMask(morph(reveal.hide, aw, ah, grow), aw, ah, W, H), zone);
    const fg = decontaminate(rgba, crisp, W, H, 0.92, realTex);
    const farRgba = Uint8ClampedArray.from(rgba);
    for (let i = 0, j = 0; i < zone.length; i++, j += 4) {
      if (!zone[i]) continue;
      let w = 1;
      if (!bandTex[i]) {
        let dfg = 0, dbg = 0;
        for (let c = 0; c < 3; c++) { dfg += Math.abs(rgba[j + c] - fg[j + c]); dbg += Math.abs(rgba[j + c] - full[j + c]); }
        w = Math.min(1, Math.max(0, (dbg - dfg) / 60 + 0.5)) * Math.min(1, dbg / 24);
        w = Math.max(w, Math.min(1, crisp[i] * 3));
      }
      for (let c = 0; c < 3; c++) farRgba[j + c] = rgba[j + c] * (1 - w) + full[j + c] * w;
    }
    // Its depth there: what lies around the whole near part (never the part's own).
    const filled = fillBehind(d, morph(mask, aw, ah, grow), aw, ah);
    const regionPlan = morph(reveal.band, aw, ah, 2);
    const farDepth = Float32Array.from(d);
    for (let i = 0; i < farDepth.length; i++) if (regionPlan[i] && reveal.hide[i]) farDepth[i] = Math.min(d[i], filled[i]);
    layers.push({ rgba: farRgba, width: W, height: H, depth: { data: farDepth, width: aw, height: ah }, opaque: true });
    borders.push(borderSamples({ depth: farDepth, dw: aw, dh: ah }));

    // Where the far layer was painted, the near part keeps its crisp edge (the
    // painting must never show through a soft one); elsewhere the two blend.
    const rp = new Float32Array(aw * ah);
    for (let i = 0; i < rp.length; i++) rp[i] = realPlan[i];
    const realW = resizePlane(boxMean(rp, aw, ah, Math.max(2, grow)), aw, ah, W, H);
    const alpha = new Float32Array(W * H);
    for (let i = 0; i < alpha.length; i++) { const k = regionTex[i] ? 1 : Math.min(1, realW[i] * 1.5); alpha[i] = crisp[i] * k + wide[i] * (1 - k); }
    const px = premultiply(decontaminate(rgba, alpha, W, H, 0.92, realTex));
    // Its depth: its own everywhere inside; carried outward beyond its edge; only at
    // real edges, where the model's depth is soft, the inside's depth is used.
    const inset = Math.max(2, Math.round(grow / 2));
    const core = morph(mask, aw, ah, -inset), nearReal = morph(reveal.edge, aw, ah, inset + 2);
    const keep = new Float32Array(aw * ah);
    for (let i = 0; i < keep.length; i++) keep[i] = mask[i] && (core[i] || !nearReal[i]) ? 1 : 0;
    const depth = pushPull(d, keep, aw, ah);
    layers.push({ rgba: px, width: W, height: H, depth: { data: depth, width: aw, height: ah }, opaque: false });
    borders.push(borderSamples({ alpha: mask, aw, ah, depth, dw: aw, dh: ah }));

    // How far the camera may part them: no more than the painting covers (a share of
    // its band), and no surface stretched across the photo's depth beyond a little.
    const nearD = [], farD = [];
    for (let i = 0; i < d.length; i++) { if (reveal.edge[i]) nearD.push(d[i]); else if (reveal.band[i]) farD.push(filled[i]); }
    const med = a => { a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)] ?? 0; };
    const all = Float32Array.from(d).sort();
    const radius = Math.round(Math.max(aw, ah) * 0.05);
    parallax = [
      { span: [all[Math.floor(all.length * 0.02)], all[Math.floor(all.length * 0.98)]], limit: STRETCH_LIMIT },
      ...(nearD.length ? [{ span: [med(farD.length ? farD : [0]), med(nearD)], limit: REVEAL_SHARE * radius / ah }] : []),
    ];
    // The subject: the nearest cut, where it is solid.
    const sub = cuts.at(-1).mask;
    let sx = 0, sy = 0, n = 0;
    const ds = [];
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) if (sub[y * aw + x]) { sx += x; sy += y; n++; ds.push(d[y * aw + x]); }
    ds.sort((a, b) => a - b);
    focus = { u: (sx / n + 0.5) / aw, v: (sy / n + 0.5) / ah, d: ds[Math.floor(ds.length / 2)] };
    // What is near but off to a side (a shoulder at the edge of the frame) is not the
    // subject: then the camera holds what is in the middle of the photo.
    if (Math.hypot(focus.u - 0.5, focus.v - 0.5) > 0.3) focus = centreFocus(d, aw, ah);
  }
  return { A: W / H, width: W, height: H, relief: RELIEF, focusD: focus.d, focus, layers, borders, parallax, cuts: cuts.length };
}

/** A copy of a scene for the page's preview: smaller textures, buffers it may keep. */
function sceneForPage(scene, side) {
  const [w, h] = fitSide(scene.width, scene.height, side);
  const layers = scene.layers.map(l => ({ rgba: Uint8ClampedArray.from(scaleRgba(l.rgba, l.width, l.height, w, h)), width: w, height: h, opaque: l.opaque,
    depth: { data: Float32Array.from(l.depth.data), width: l.depth.width, height: l.depth.height } }));
  const value = { A: scene.A, width: w, height: h, relief: scene.relief, focusD: scene.focusD, focus: scene.focus, borders: scene.borders, parallax: scene.parallax, layers, cuts: scene.cuts };
  return { value, transfer: layers.flatMap(l => [l.rgba.buffer, l.depth.data.buffer]) };
}

/**
 * Run: `opts.output` 'scene' gives the scene (for a page's live preview), else
 * the video (see index.js, Video.run).
 */
export async function run(state, input, opts = {}, ctx) {
  if (opts.test?.failRun) {
    await state.depth.run({ [state.depth.inputNames[0]]: new state.ort.Tensor('float32', new Float32Array(3), [1, 3, 1, 1]) });
  }
  const o = normalizeOptions(opts);
  const side = PHOTO_SIDE[o.quality];
  const key = await keyOf(input, side);
  let scene = key && state.scene?.key === key ? state.scene : null;
  try {
    if (!scene) {
      state.scene = null;
      scene = await buildScene(state, input, side, ctx);
      scene.key = key;
      state.scene = key ? scene : null;
    }
    if (opts.output === 'scene') {
      ctx.report('done');
      return sceneForPage(scene, Number(opts.previewSide) > 0 ? Math.min(side, Number(opts.previewSide)) : PREVIEW_SIDE);
    }
    const { width, height } = outputSize(o.aspect, o.quality);
    const canvas = new OffscreenCanvas(width, height);
    const renderer = createRenderer(canvas, { msaa: 4, grid: o.quality === 'high' ? 560 : 400, preserve: true });
    let result;
    try {
      renderer.setScene(scene);
      const plan = planCamera({ preset: o.preset, aspect: width / height, A: scene.A, focus: scene.focus, relief: scene.relief, strength: o.strength, borders: scene.borders, parallax: scene.parallax });
      const n = frameCount(o.seconds, o.fps);
      const audio = opts.audio && opts.audio.channels?.length ? fitSoundtrack(opts.audio, n / o.fps) : null;
      ctx.report('running', { stage: 'render', frame: 0, frames: n });
      result = await encodeVideo({
        width, height, fps: o.fps, frames: n, audio, container: o.container,
        frame: i => { renderer.draw(cameraAt(plan, frameTime(i, n, plan.loop)), { ...o.effects, seed: (i * 0.6180339) % 1 }); return canvas; },
        onProgress: p => ctx.report('running', p),
      });
    } finally {
      renderer.dispose();
    }
    ctx.report('done');
    return {
      value: { ...result, model: ctx.modelId, device: ctx.device, dtype: ctx.dtype, preset: o.preset, aspect: o.aspect, layers: scene.layers.length },
      transfer: [],
    };
  } catch (err) {
    throw toAiError(err, 'run-failed');
  }
}

export async function dispose(state) {
  if (!state) return;
  state.scene = null;
  await releaseSession(state.depth);
  await releaseSession(state.inpaint);
}
