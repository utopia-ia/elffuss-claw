// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Where the vendored runtimes live under a site's /vendor/, by ONNX Runtime
// variant. Pure module: the build uses it to copy files and the SDK to point
// the runtimes at their own origin.

import { PINS, VENDOR_DIRS } from './runtime-pins.js';
import { AiError } from './errors.js';

const mismatch = (what, got, want) => new AiError('runtime-mismatch', `${what} is ${got ?? 'missing'}, the site pins ${want}`, { details: { what, got, want } });

/**
 * Check, before any session exists, that Transformers.js and the ONNX Runtime it
 * uses are the pinned versions, and that both see the same ONNX Runtime.
 * @param {{ env: any }} tf the Transformers.js module
 * @param {{ env: any }} ort the ONNX Runtime Web module the page imported
 * @param {typeof PINS} [want]
 */
export function assertTransformersRuntime(tf, ort, want = PINS) {
  const env = tf?.env;
  if (env?.version !== want.transformers) throw mismatch('Transformers.js', env?.version, want.transformers);
  const v = env?.backends?.onnx?.versions;
  if (v?.web !== want.onnxruntimeWeb) throw mismatch('ONNX Runtime Web (in Transformers.js)', v?.web, want.onnxruntimeWeb);
  if (v?.common !== want.onnxruntimeWeb) throw mismatch('onnxruntime-common (in Transformers.js)', v?.common, want.onnxruntimeWeb);
  if (ort && ort.env?.versions !== v) throw mismatch('ONNX Runtime instance', 'a second copy', 'one shared instance');
}

/** Check the ONNX Runtime Web module used directly (OCR). */
export function assertOrtRuntime(ort, want = PINS) {
  const v = ort?.env?.versions;
  if (v?.web !== want.onnxruntimeWeb) throw mismatch('ONNX Runtime Web', v?.web, want.onnxruntimeWeb);
  if (v?.common !== want.onnxruntimeWeb) throw mismatch('onnxruntime-common', v?.common, want.onnxruntimeWeb);
}

/** Check PDF.js (main thread of the OCR site). */
export function assertPdfjsRuntime(pdfjsLib, want = PINS) {
  if (pdfjsLib?.version !== want.pdfjs) throw mismatch('PDF.js', pdfjsLib?.version, want.pdfjs);
}

/**
 * Files of each ONNX Runtime Web variant, relative to its package directory.
 * `webgpu` brings WebGPU and WebAssembly; `wasm` brings WebAssembly only.
 */
export const ORT_VARIANTS = Object.freeze({
  webgpu: Object.freeze({
    bundle: 'dist/ort.webgpu.bundle.min.mjs',
    mjs: 'dist/ort-wasm-simd-threaded.asyncify.mjs',
    wasm: 'dist/ort-wasm-simd-threaded.asyncify.wasm',
  }),
  wasm: Object.freeze({
    bundle: 'dist/ort.wasm.bundle.min.mjs',
    mjs: 'dist/ort-wasm-simd-threaded.mjs',
    wasm: 'dist/ort-wasm-simd-threaded.wasm',
  }),
});

/** Files of PDF.js that the OCR site serves, relative to its package directory. */
export const PDFJS_FILES = Object.freeze({
  lib: 'build/pdf.min.mjs',
  worker: 'build/pdf.worker.min.mjs',
  wasmDir: 'wasm/',
  cMapDir: 'cmaps/',
  standardFontDir: 'standard_fonts/',
  iccDir: 'iccs/',
});

/**
 * Directory of the Transformers.js copy whose two ONNX Runtime imports point at
 * one variant of the vendored ONNX Runtime Web (the build writes it).
 * @param {'webgpu'|'wasm'} variant
 */
export function transformersDir(variant) {
  if (!ORT_VARIANTS[variant]) throw new Error('unknown ONNX Runtime variant: ' + variant);
  return `${VENDOR_DIRS.transformers}+ort${PINS.onnxruntimeWeb}-${variant}`;
}

/**
 * Import specifier, relative to the rewritten Transformers.js file, of the ONNX
 * Runtime bundle of one variant.
 * @param {'webgpu'|'wasm'} variant
 */
export function ortSpecifierFromTransformers(variant) {
  return `../../${VENDOR_DIRS.onnxruntimeWeb}/${ORT_VARIANTS[variant].bundle}`;
}

/**
 * Same-origin URLs of the runtimes of one site.
 * @param {{ variant: 'webgpu'|'wasm', base?: string, pdfjs?: boolean }} opts
 *   `base` is the URL of /vendor/ (default `/vendor/`).
 * @returns {{ variant: string, ortBundle: string, ortMjs: string, ortWasm: string, transformers: string,
 *   pdfjs?: { lib: string, worker: string, wasmUrl: string, cMapUrl: string, standardFontDataUrl: string, iccUrl: string } }}
 */
export function runtimeUrls({ variant, base = '/vendor/', pdfjs = false }) {
  const v = ORT_VARIANTS[variant];
  if (!v) throw new Error('unknown ONNX Runtime variant: ' + variant);
  const b = base.endsWith('/') ? base : base + '/';
  const ort = `${b}${VENDOR_DIRS.onnxruntimeWeb}/`;
  const out = {
    variant,
    ortBundle: ort + v.bundle,
    ortMjs: ort + v.mjs,
    ortWasm: ort + v.wasm,
    transformers: `${b}${transformersDir(variant)}/transformers.web.min.js`,
  };
  if (pdfjs) {
    const p = `${b}${VENDOR_DIRS.pdfjs}/`;
    out.pdfjs = {
      lib: p + PDFJS_FILES.lib,
      worker: p + PDFJS_FILES.worker,
      wasmUrl: p + PDFJS_FILES.wasmDir,
      cMapUrl: p + PDFJS_FILES.cMapDir,
      standardFontDataUrl: p + PDFJS_FILES.standardFontDir,
      iccUrl: p + PDFJS_FILES.iccDir,
    };
  }
  return out;
}
