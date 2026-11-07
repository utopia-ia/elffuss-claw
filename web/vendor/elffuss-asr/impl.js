// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
// Speech to text where the model runs (a Worker): Whisper base (OpenAI, Apache-2.0; the ONNX export of
// onnx-community) as a Transformers.js pipeline, fed only by the Elffuss model store at the revision registry.json
// pins (the SDK core's ctx.pipeline()). The language is always given: Whisper without one is told English by
// Transformers.js and translates instead of writing down what was said.
import { AiError } from '../elffuss-ai/sdk/core/errors.js';

export const task = 'speech-to-text';

/** @param {import('../elffuss-ai/sdk/core/task-runtime.js').TaskContext} ctx */
export async function load(ctx) {
  return { asr: await ctx.pipeline() };
}

/**
 * @param {{ asr: any }} state
 * @param {Float32Array} input mono samples at 16 kHz
 * @param {{ language: string }} opts
 */
export async function run(state, input, opts, ctx) {
  if (!(input instanceof Float32Array)) throw new AiError('unsupported-format', 'speech-to-text takes 16 kHz mono samples');
  if (!opts?.language) throw new AiError('unsupported-format', 'the language is needed');
  ctx.report('running', { stage: 'transcribe' });
  const out = await state.asr(input, { language: opts.language, task: 'transcribe', temperature: 0, no_repeat_ngram_size: 3, chunk_length_s: 30, stride_length_s: 5 });
  ctx.report('done');
  const text = (Array.isArray(out) ? out.map((x) => x.text).join(' ') : out?.text || '').replace(/\s+/g, ' ').trim();
  return { value: { text } };
}

export async function dispose(state) {
  try { await state?.asr?.dispose?.(); } catch { /* releasing */ }
}
