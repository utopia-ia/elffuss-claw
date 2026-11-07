// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// One error type for the whole SDK, with a stable code set where the error is
// born. Same shape as the engine's EngineError: `code`, `cause`, `details`; the
// message is the human sentence, in English.

/**
 * Every code an AiError can carry.
 * - store-unavailable: the model store iframe did not load, did not say it is ready, or did not answer the first question
 * - store-permission: the model store refused the request (this site may not ask for it)
 * - store-quota: the browser storage of the model store is full
 * - store-network: the download was cut; asking again resumes it
 * - integrity: a file does not have the size or the hash the registry pins
 * - not-in-registry: a model, repo, revision or file that the registry does not list
 * - device-unsupported: the model does not declare the requested backend
 * - webgpu-unavailable: WebGPU was requested and there is no usable adapter
 * - runtime-mismatch: a runtime loaded at a version other than the pinned one
 * - model-mismatch: the model is not what the registry describes (outputs, dictionary)
 * - aborted: cancelled through an AbortSignal
 * - decode-failed: an input could not be decoded
 * - unsupported-format: an input of a type the task does not take
 * - too-large: an input too large even after scaling it down
 * - out-of-memory: the runtime could not get the memory the model needs in this browser
 * - run-failed: anything else while running, with the original error as `cause`
 * - disposed: the task instance was disposed
 * @typedef {'store-unavailable'|'store-permission'|'store-quota'|'store-network'|'integrity'|'not-in-registry'|
 *   'device-unsupported'|'webgpu-unavailable'|'runtime-mismatch'|'model-mismatch'|'aborted'|'decode-failed'|
 *   'unsupported-format'|'too-large'|'out-of-memory'|'run-failed'|'disposed'} AiErrorCode
 */
export const ERROR_CODES = Object.freeze([
  'store-unavailable', 'store-permission', 'store-quota', 'store-network', 'integrity', 'not-in-registry',
  'device-unsupported', 'webgpu-unavailable', 'runtime-mismatch', 'model-mismatch', 'aborted',
  'decode-failed', 'unsupported-format', 'too-large', 'out-of-memory', 'run-failed', 'disposed',
]);

/** Codes of errors about the input itself, raised before the model runs: the runtime is intact. */
export const INPUT_ERROR_CODES = Object.freeze(['decode-failed', 'unsupported-format', 'too-large']);

/**
 * True when an error says that memory could not be had: a C++ allocation that
 * failed inside the WebAssembly runtime (std::bad_alloc), a WebAssembly memory
 * that could not grow, or a buffer the browser would not allocate.
 */
export function isOutOfMemory(err) {
  const text = `${err?.name || ''} ${err instanceof Error ? err.message : String(err?.message ?? err)}`;
  return /bad_alloc|out of memory|Array buffer allocation failed|could not allocate memory|Cannot enlarge memory|failed to grow memory/i.test(text);
}

/** Error of the SDK. `code` is one of ERROR_CODES. */
export class AiError extends Error {
  /**
   * @param {AiErrorCode} code
   * @param {string} message
   * @param {{ cause?: unknown, details?: Record<string, unknown> }} [opts]
   */
  constructor(code, message, { cause, details } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    if (!ERROR_CODES.includes(code)) throw new TypeError('unknown AiError code: ' + code);
    this.name = 'AiError';
    /** @type {AiErrorCode} */
    this.code = code;
    /** @type {Record<string, unknown> | undefined} */
    this.details = details;
  }
}

/** True when `err` is an AiError (optionally with this code). */
export function isAiError(err, code) {
  return !!err && typeof err === 'object' && err.name === 'AiError' && ERROR_CODES.includes(err.code) && (code === undefined || err.code === code);
}

/** The error a model-store answer of type `tipo` stands for. */
const BROKER_TYPES = Object.freeze({
  permiso: 'store-permission',
  cuota: 'store-quota',
  red: 'store-network',
  http: 'store-network',
  integridad: 'integrity',
  cancelado: 'aborted',
});

/**
 * Turn an error answer of the model store into an AiError.
 * @param {{ tipo?: string, message?: string }} msg
 * @param {Record<string, unknown>} [details]
 */
export function fromStoreError(msg, details) {
  const code = BROKER_TYPES[msg?.tipo] || 'store-network';
  return new AiError(code, `model store: ${String(msg?.message || msg?.tipo || 'error')}`, { details: { ...details, storeType: msg?.tipo } });
}

/** Wrap anything thrown into an AiError, keeping AiErrors and aborts as they are. */
export function toAiError(err, fallback = 'run-failed') {
  if (isAiError(err)) return err;
  if (err && typeof err === 'object' && err.name === 'AbortError') return new AiError('aborted', 'cancelled', { cause: err });
  const message = err instanceof Error ? err.message : String(err);
  const code = fallback === 'run-failed' && isOutOfMemory(err) ? 'out-of-memory' : fallback;
  return new AiError(code, message || code, { cause: err });
}

/** A plain object that survives postMessage. */
export function serializeError(err) {
  const e = toAiError(err);
  const cause = e.cause instanceof Error ? { name: e.cause.name, message: e.cause.message } : (e.cause === undefined ? undefined : String(e.cause));
  return { name: 'AiError', code: e.code, message: e.message, details: e.details, cause };
}

/** Rebuild an AiError from serializeError's output. */
export function deserializeError(obj) {
  const code = ERROR_CODES.includes(obj?.code) ? obj.code : 'run-failed';
  const cause = obj?.cause && typeof obj.cause === 'object' ? Object.assign(new Error(obj.cause.message), { name: obj.cause.name }) : obj?.cause;
  return new AiError(code, String(obj?.message || code), { cause, details: obj?.details });
}

/** An AiError('aborted') for a signal, or null when the signal is not aborted. */
export function abortError(signal) {
  if (!signal?.aborted) return null;
  return new AiError('aborted', 'cancelled', { cause: signal.reason });
}

/** Throw AiError('aborted') if the signal is aborted. */
export function throwIfAborted(signal) {
  const e = abortError(signal);
  if (e) throw e;
}
