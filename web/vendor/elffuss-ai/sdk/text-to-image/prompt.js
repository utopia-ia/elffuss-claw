// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// How SANA-Sprint reads a prompt, as diffusers' SanaSprintPipeline does: the prompt
// is lowercased and trimmed and put after a fixed instruction for the text model
// (the "complex human instruction" of the pipeline, written below as the pipeline
// has it), and the text model reads the whole text. The transformer is then given
// the first token's state and the states of the last 299 positions of the text
// padded to the instruction's length plus 298: in practice the prompt's own tokens.
// Padding positions carry no weight (the pipeline masks them out), so they are
// left out here instead of being computed.

/** The instruction the pipeline puts before every prompt, line by line. */
export const INSTRUCTION = Object.freeze([
  "Given a user prompt, generate an 'Enhanced prompt' that provides detailed visual descriptions suitable for image generation. Evaluate the level of detail in the user prompt:",
  '- If the prompt is simple, focus on adding specifics about colors, shapes, sizes, textures, and spatial relationships to create vivid and concrete scenes.',
  '- If the prompt is already detailed, refine and enhance the existing details slightly without overcomplicating.',
  'Here are examples of how to transform or refine prompts:',
  '- User Prompt: A cat sleeping -> Enhanced: A small, fluffy white cat curled up in a round shape, sleeping peacefully on a warm sunny windowsill, surrounded by pots of blooming red flowers.',
  '- User Prompt: A busy city street -> Enhanced: A bustling city street scene at dusk, featuring glowing street lamps, a diverse crowd of people in colorful clothing, and a double-decker bus passing by towering glass skyscrapers.',
  'Please generate only the enhanced description for the prompt below and avoid including any additional commentary or evaluations:',
  'User Prompt: ',
]);

/** The longest prompt the model reads, in tokens (the pipeline's max_sequence_length). */
export const MAX_PROMPT_TOKENS = 300;

/** The prompt as the pipeline reads it: lowercased and trimmed. */
export function normalizePrompt(prompt) {
  return String(prompt ?? '').toLowerCase().trim();
}

/**
 * The tokens the text model reads and which of its output states the transformer
 * is given.
 * @param {(text: string) => number[]} encode the Gemma tokenizer, with the
 *   beginning-of-text token first (as `add_special_tokens` gives it)
 * @param {string} prompt
 * @returns {{ ids: number[], keep: number[], promptTokens: number, truncated: boolean }}
 *   `ids`: the tokens to run (instruction and prompt, never padding); `keep`: the
 *   positions of `ids` whose states go to the transformer, in order;
 *   `promptTokens`: how many of the prompt's tokens it sees; `truncated`: the
 *   prompt was longer than the model reads and its end was cut
 */
export function captionTokens(encode, prompt) {
  const instruction = INSTRUCTION.join('\n');
  const head = encode(instruction).length;
  const length = head + MAX_PROMPT_TOKENS - 2;
  const all = encode(instruction + normalizePrompt(prompt));
  const ids = all.slice(0, length);
  const from = length - (MAX_PROMPT_TOKENS - 1);
  const keep = [0];
  for (let i = from; i < ids.length; i++) keep.push(i);
  return { ids, keep, promptTokens: keep.length - 1, truncated: all.length > length };
}
