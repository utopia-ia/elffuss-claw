// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Draws the layers of a photo seen by the camera of sdk/video/camera.js, with
// WebGL2, on a canvas of the page (the live preview) or an OffscreenCanvas of a
// Worker (the export): the same code, so the video is what the preview showed.
// Each layer is a dense grid lifted by its depth in the vertex shader, textured
// with the photo (mipmapped, premultiplied alpha), drawn far to near into a
// multisampled buffer; a last pass adds the finish (depth of field, vignette,
// grain) and writes the frame. dispose() deletes every object it made and gives
// the context back.

import { MIN_DISPARITY } from './camera.js';

const VS = `#version 300 es
precision highp float;
in vec2 a_uv;
uniform sampler2D u_depth;
uniform float u_A, u_relief, u_focusD, u_minDisp, u_near, u_far;
uniform vec3 u_pos;
uniform vec2 u_rot, u_shift, u_half;
out vec2 v_uv;
out float v_d;
void main() {
  float d = texture(u_depth, a_uv).r;
  float z = 1.0 / max(u_minDisp, 1.0 + u_relief * (d - u_focusD));
  vec3 p = vec3((a_uv.x - 0.5) * u_A * z, (0.5 - a_uv.y) * z, z) - u_pos;
  float cy = cos(u_rot.x), sy = sin(u_rot.x), cp = cos(u_rot.y), sp = sin(u_rot.y);
  float x1 = cy * p.x - sy * p.z, z1 = sy * p.x + cy * p.z;
  float y2 = cp * p.y - sp * z1, z2 = sp * p.y + cp * z1;
  float zn = (z2 - u_near) / (u_far - u_near) * 2.0 - 1.0;
  gl_Position = vec4((x1 - u_shift.x * z2) / u_half.x, (y2 - u_shift.y * z2) / u_half.y, zn * z2, z2);
  v_uv = a_uv;
  v_d = d;
}`;

const FS_LAYER = `#version 300 es
precision highp float;
in vec2 v_uv;
in float v_d;
uniform sampler2D u_color;
uniform float u_opaque, u_dispPass;
layout(location = 0) out vec4 o;
void main() {
  vec4 c = texture(u_color, v_uv);
  if (u_opaque > 0.5) c = vec4(c.rgb / max(c.a, 1e-4), 1.0);
  if (u_dispPass > 0.5) { if (c.a < 0.5) discard; o = vec4(v_d, v_d, v_d, 1.0); return; }
  o = c;
}`;

const VS_QUAD = `#version 300 es
precision highp float;
in vec2 a_uv;
out vec2 v_uv;
void main() { v_uv = a_uv; gl_Position = vec4(a_uv * 2.0 - 1.0, 0.0, 1.0); }`;

const FS_POST = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_img, u_disp;
uniform vec2 u_size;
uniform float u_dof, u_focus, u_vig, u_grain, u_seed, u_useDisp;
out vec4 o;
vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }
vec3 enc(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + u_seed) * 43758.5453); }
void main() {
  vec2 uv = v_uv;
  vec3 col = lin(texture(u_img, uv).rgb);
  if (u_dof > 0.0 && u_useDisp > 0.5) {
    float coc = clamp(abs(texture(u_disp, uv).r - u_focus) * 2.2, 0.0, 1.0);
    float r = coc * u_dof * u_size.y * 0.006;
    if (r > 0.35) {
      vec3 acc = col; float wsum = 1.0;
      for (int i = 0; i < 24; i++) {
        float fi = float(i) + 0.5;
        float a = fi * 2.39996323;
        float rr = sqrt(fi / 24.0) * r;
        vec2 q = uv + vec2(cos(a), sin(a)) * rr / u_size;
        float cq = clamp(abs(texture(u_disp, q).r - u_focus) * 2.2, 0.0, 1.0) * u_dof * u_size.y * 0.006;
        float w = smoothstep(rr - 1.0, rr + 1.0, cq + 0.5);
        acc += lin(texture(u_img, q).rgb) * w; wsum += w;
      }
      col = acc / wsum;
    }
  }
  if (u_vig > 0.0) {
    vec2 c = (uv - 0.5) * vec2(u_size.x / max(u_size.x, u_size.y), u_size.y / max(u_size.x, u_size.y)) * 2.0;
    col *= mix(1.0, 1.0 - smoothstep(0.55, 1.45, length(c)) * 0.55, u_vig);
  }
  vec3 outc = enc(col);
  if (u_grain > 0.0) outc += (hash(uv * u_size) - 0.5) * u_grain * 0.035;
  o = vec4(outc, 1.0);
}`;

/** IEEE half-precision bits of a float (for depth textures). */
export function toHalf(v) {
  const f = new Float32Array(1), i = new Uint32Array(f.buffer);
  f[0] = v;
  const x = i[0];
  const sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15, m = x & 0x7fffff;
  if (e <= 0) return sign;
  if (e >= 31) return sign | 0x7c00;
  m += 0x1000; // round
  if (m & 0x800000) { m = 0; e++; if (e >= 31) return sign | 0x7c00; }
  return sign | (e << 10) | (m >>> 13);
}

/** Half floats of a plane of values. */
export function halfPlane(values) {
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = toHalf(values[i]);
  return out;
}

/**
 * A grid of w × h vertices over the photo (u, v in 0-1) and its triangles.
 * @returns {{ uv: Float32Array, index: Uint32Array }}
 */
export function gridMesh(w, h) {
  const uv = new Float32Array(w * h * 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 2; uv[i] = x / (w - 1); uv[i + 1] = y / (h - 1); }
  const index = new Uint32Array((w - 1) * (h - 1) * 6);
  let k = 0;
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const p = y * w + x;
    index[k++] = p; index[k++] = p + 1; index[k++] = p + w;
    index[k++] = p + 1; index[k++] = p + w + 1; index[k++] = p + w;
  }
  return { uv, index };
}

function compile(gl, vs, fs) {
  const make = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  const a = make(gl.VERTEX_SHADER, vs), b = make(gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, a); gl.attachShader(p, b);
  gl.bindAttribLocation(p, 0, 'a_uv');
  gl.linkProgram(p);
  gl.deleteShader(a); gl.deleteShader(b);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('program: ' + gl.getProgramInfoLog(p));
  const u = new Proxy({}, { get: (c, k) => (k in c ? c[k] : (c[k] = gl.getUniformLocation(p, k))) });
  return { p, u };
}

/**
 * A renderer on a canvas (HTMLCanvasElement or OffscreenCanvas).
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @param {{ msaa?: number, grid?: number, preserve?: boolean }} [o] `grid`: vertices across the long side of the photo
 */
export function createRenderer(canvas, { msaa = 4, grid = 480, preserve = false } = {}) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, premultipliedAlpha: true, preserveDrawingBuffer: preserve, powerPreference: 'high-performance' });
  if (!gl) throw new Error('webgl2-unavailable');
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  const layerProg = compile(gl, VS, FS_LAYER);
  const postProg = compile(gl, VS_QUAD, FS_POST);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  const quadVao = gl.createVertexArray();
  gl.bindVertexArray(quadVao);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  const samples = Math.min(msaa, gl.getParameter(gl.MAX_SAMPLES) || 0);
  let mesh = null, layers = [], scene = null, targets = null, size = { w: 0, h: 0 }, disposed = false;

  function texture(w, h, internal, format, type, data, mips) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (mips) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    } else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    return t;
  }

  function freeScene() {
    for (const l of layers) { gl.deleteTexture(l.color); gl.deleteTexture(l.depth); }
    layers = [];
    if (mesh) { gl.deleteBuffer(mesh.vbo); gl.deleteBuffer(mesh.ibo); gl.deleteVertexArray(mesh.vao); mesh = null; }
  }

  function freeTargets() {
    if (!targets) return;
    for (const k of ['msFbo', 'resolveFbo', 'dispFbo']) gl.deleteFramebuffer(targets[k]);
    for (const k of ['msColor', 'msDepth', 'dispDepth']) gl.deleteRenderbuffer(targets[k]);
    for (const k of ['resolved', 'disp']) gl.deleteTexture(targets[k]);
    targets = null;
  }

  function ensureTargets(w, h) {
    if (targets && size.w === w && size.h === h) return;
    freeTargets();
    size = { w, h };
    const t = {};
    t.msFbo = gl.createFramebuffer();
    t.msColor = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, t.msColor);
    if (samples > 0) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, w, h); else gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, w, h);
    t.msDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, t.msDepth);
    if (samples > 0) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h); else gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.msFbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, t.msColor);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, t.msDepth);
    t.resolved = texture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null, false);
    t.resolveFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.resolveFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.resolved, 0);
    t.disp = texture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null, false);
    t.dispDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, t.dispDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    t.dispFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.dispFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.disp, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, t.dispDepth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    targets = t;
  }

  function drawLayers(view, dispPass) {
    const { p, u } = layerProg;
    gl.useProgram(p);
    gl.uniform1f(u.u_A, scene.A);
    gl.uniform1f(u.u_relief, scene.relief);
    gl.uniform1f(u.u_focusD, scene.focusD);
    gl.uniform1f(u.u_minDisp, MIN_DISPARITY);
    gl.uniform1f(u.u_near, 0.05);
    gl.uniform1f(u.u_far, 1 / MIN_DISPARITY + 2);
    gl.uniform3f(u.u_pos, view.pos[0], view.pos[1], view.pos[2]);
    gl.uniform2f(u.u_rot, view.yaw, view.pitch);
    gl.uniform2f(u.u_shift, view.shift[0], view.shift[1]);
    gl.uniform2f(u.u_half, view.half[0], view.half[1]);
    gl.uniform1f(u.u_dispPass, dispPass ? 1 : 0);
    gl.uniform1i(u.u_depth, 0);
    gl.uniform1i(u.u_color, 1);
    gl.bindVertexArray(mesh.vao);
    for (const l of layers) {
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.uniform1f(u.u_opaque, l.opaque ? 1 : 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, l.depth);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, l.color);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null);
  }

  return {
    gl,
    /**
     * The photo's layers, far to near: `rgba` premultiplied bytes of the photo
     * size, `depth` a plane of disparity (0-1) of any size.
     * @param {{ A: number, relief: number, focusD: number, layers: { rgba: Uint8Array|Uint8ClampedArray, width: number, height: number,
     *   depth: { data: Float32Array, width: number, height: number }, opaque?: boolean }[] }} s
     */
    setScene(s) {
      freeScene();
      scene = { A: s.A, relief: s.relief, focusD: s.focusD };
      const gw = Math.max(16, Math.round(s.A >= 1 ? grid : grid * s.A)), gh = Math.max(16, Math.round(s.A >= 1 ? grid / s.A : grid));
      const g = gridMesh(gw, gh);
      mesh = { vao: gl.createVertexArray(), vbo: gl.createBuffer(), ibo: gl.createBuffer(), count: g.index.length };
      gl.bindVertexArray(mesh.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, g.uv, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.index, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      for (const l of s.layers) {
        const rgba = l.rgba instanceof Uint8Array ? l.rgba : new Uint8Array(l.rgba.buffer, l.rgba.byteOffset, l.rgba.byteLength);
        layers.push({
          opaque: Boolean(l.opaque),
          color: texture(l.width, l.height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, rgba, true),
          depth: texture(l.depth.width, l.depth.height, gl.R16F, gl.RED, gl.HALF_FLOAT, l.depth.data instanceof Uint16Array ? l.depth.data : halfPlane(l.depth.data), false),
        });
      }
    },
    /**
     * Draw one frame of `view` (camera.js cameraAt) at the canvas's size.
     * @param {{ pos: number[], yaw: number, pitch: number, shift: number[], half: number[] }} view
     * @param {{ dof?: number, vignette?: number, grain?: number, seed?: number }} [fx]
     */
    draw(view, fx = {}) {
      if (disposed || !scene) return;
      const w = canvas.width, h = canvas.height;
      ensureTargets(w, h);
      gl.viewport(0, 0, w, h);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.CULL_FACE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets.msFbo);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      drawLayers(view, false);
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, targets.msFbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, targets.resolveFbo);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      const dof = Number(fx.dof) || 0;
      if (dof > 0) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, targets.dispFbo);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        drawLayers(view, true);
      }
      gl.disable(gl.DEPTH_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const { p, u } = postProg;
      gl.useProgram(p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, targets.resolved);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, targets.disp);
      gl.uniform1i(u.u_img, 0); gl.uniform1i(u.u_disp, 1);
      gl.uniform2f(u.u_size, w, h);
      gl.uniform1f(u.u_dof, dof);
      gl.uniform1f(u.u_useDisp, dof > 0 ? 1 : 0);
      gl.uniform1f(u.u_focus, scene.focusD);
      gl.uniform1f(u.u_vig, Number(fx.vignette) || 0);
      gl.uniform1f(u.u_grain, Number(fx.grain) || 0);
      gl.uniform1f(u.u_seed, Number(fx.seed) || 0);
      gl.bindVertexArray(quadVao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    },
    /** Read the last frame back as RGBA rows, top first (tests and checks). */
    read() {
      const w = canvas.width, h = canvas.height, px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const out = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) out.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      return out;
    },
    /** Delete every object of this renderer and give the context back. */
    dispose() {
      if (disposed) return;
      disposed = true;
      freeScene(); freeTargets();
      gl.deleteProgram(layerProg.p); gl.deleteProgram(postProg.p);
      gl.deleteBuffer(quad); gl.deleteVertexArray(quadVao);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
