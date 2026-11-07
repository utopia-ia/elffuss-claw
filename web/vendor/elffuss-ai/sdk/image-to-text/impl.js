// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The image-to-text task where the model runs (a Worker, or the page with worker: false): Florence-2 base (fine-tuned,
// MIT) through Transformers.js, loaded by class (it is not a pipeline there) and fed only by the model store at the
// pinned commit (ctx.modelFetch()). Two of its prompts: a detailed caption, and the visible text with one region per
// line (so the lines come apart instead of running together, as the plain OCR prompt writes them).

import { AiError, toAiError } from '../core/errors.js';
import { decodeImage } from '../core/image-input.js';

export const task = 'image-to-text';

// The variant's dtype in the registry names its mix of files: this is what Transformers.js reads per graph.
const DTYPES = {
  'fp16+q4': { vision_encoder: 'fp16', embed_tokens: 'fp16', encoder_model: 'q4', decoder_model_merged: 'q4' },
  q4: { vision_encoder: 'q4', embed_tokens: 'q4', encoder_model: 'q4', decoder_model_merged: 'q4' },
  q8: { vision_encoder: 'q8', embed_tokens: 'q8', encoder_model: 'q8', decoder_model_merged: 'q8' },
};
// The model looks at 768 × 768: a larger photo only costs decoding.
export const MAX_SIDE = 1024;
const CAPTION = '<MORE_DETAILED_CAPTION>';
const TEXT = '<OCR_WITH_REGION>';

export async function load(ctx) {
  const dtype = DTYPES[ctx.dtype];
  if (!dtype) throw new AiError('model-mismatch', `no file mix for dtype ${ctx.dtype}`);
  const tf = await ctx.modelFetch();
  const { repo, revision } = ctx.model.parts.main;
  try {
    const [model, processor] = await Promise.all([
      tf.Florence2ForConditionalGeneration.from_pretrained(repo, { revision, device: ctx.device, dtype }),
      tf.AutoProcessor.from_pretrained(repo, { revision }),
    ]);
    return { tf, model, processor };
  } catch (err) {
    throw toAiError(err, 'run-failed');
  }
}

async function ask(state, image, prompt, maxTokens) {
  const { model, processor } = state;
  const inputs = await processor(image, processor.construct_prompts(prompt));
  const ids = await model.generate({ ...inputs, max_new_tokens: maxTokens, num_beams: 1, do_sample: false });
  const raw = processor.batch_decode(ids, { skip_special_tokens: false })[0];
  return processor.post_process_generation(raw, prompt, image.size)[prompt];
}

// Lines of visible text, in reading order, without the one- and two-letter crumbs the model reads in a photo with no
// text («C»), and each line once.
export function cleanLines(labels) {
  const seen = new Set(), out = [];
  for (const l of Array.isArray(labels) ? labels : []) {
    const s = String(l || '').replace(/<\/?s>/g, '').replace(/\s+/g, ' ').trim();
    if (s.replace(/[^\p{L}\p{N}]/gu, '').length < 3 || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase()); out.push(s);
  }
  return out;
}

/**
 * `opts.want`: 'all' (default: caption and text), 'caption' or 'text'.
 * Resolves to { value: { caption, text, lines, width, height, device, dtype } }, as every task's run does.
 */
export async function run(state, input, opts = {}, ctx) {
  const img = await decodeImage(input, { maxSide: MAX_SIDE });
  const image = new state.tf.RawImage(img.data, img.width, img.height, 4).rgb();
  const want = opts.want || 'all';
  ctx.report('running');
  let caption = '', lines = [];
  if (want !== 'text') caption = String(await ask(state, image, CAPTION, 160) || '').replace(/<\/?s>/g, '').trim();
  if (want !== 'caption') lines = cleanLines((await ask(state, image, TEXT, 256))?.labels);
  ctx.report('done');
  return { value: { caption, text: lines.join(' · '), lines, width: img.width, height: img.height, device: ctx.device, dtype: ctx.dtype } };
}

export async function dispose(state) {
  await state?.model?.dispose?.();
}
