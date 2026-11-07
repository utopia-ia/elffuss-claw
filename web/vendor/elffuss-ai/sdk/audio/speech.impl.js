// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The text-to-speech task where the model runs: Kokoro 82M on ONNX Runtime Web
// (WebGPU fp32 or WebAssembly q8). A run turns the text into phonemes (Spanish
// by the rules of g2p-es.js; English with misaki's word lists and, for a word
// they lack, misaki's small network, here on WebAssembly), reads it in chunks of
// whole sentences and joins them with the pause their punctuation asks for and a
// few milliseconds of fade at each edge, so no seam clicks. 24 kHz mono.

import { AiError } from '../core/errors.js';
import { createSession, releaseSession } from '../core/ort-env.js';
import { spanishToPhonemes } from './g2p-es.js';
import { createEnglish, englishToPhonemes } from './g2p-en.js';
import { sentences, packChunks } from './text.js';
import { VOICES, DEFAULT_VOICE, SPEED, SPEECH_SAMPLE_RATE, voiceInfo, readVocab, phonemeIds, styleFor } from './kokoro.js';
import { joinSpeech, measure } from './signal.js';
import { encodeWav } from './wav.js';

export const task = 'text-to-speech';
/** Longest text accepted, in characters. */
export const MAX_TEXT = 20000;

/**
 * Check and complete the options of a run.
 * @param {{ text?: string, voice?: string, lang?: 'es'|'en', speed?: number }} input
 */
export function normalizeSpeech(input) {
  const text = String(input?.text ?? '').trim();
  if (!text) throw new AiError('unsupported-format', 'a text is needed');
  if (text.length > MAX_TEXT) throw new AiError('too-large', `the text has ${text.length} characters, at most ${MAX_TEXT}`);
  let lang = input?.lang;
  if (lang != null && lang !== 'es' && lang !== 'en') throw new AiError('unsupported-format', 'lang must be es or en');
  let voice = input?.voice ?? null;
  if (voice != null && !voiceInfo(voice)) throw new AiError('unsupported-format', `unknown voice ${voice}`, { details: { voices: VOICES.map(v => v.id) } });
  lang ||= voice ? voiceInfo(voice).lang : 'es';
  voice ||= DEFAULT_VOICE[lang];
  const speed = input?.speed == null ? SPEED.default : Number(input.speed);
  if (!Number.isFinite(speed) || speed < SPEED.min || speed > SPEED.max) throw new AiError('unsupported-format', `speed must be between ${SPEED.min} and ${SPEED.max}`);
  return { text, lang, voice, speed };
}

const refOf = (ctx, re) => {
  const f = ctx.files.find(x => re.test(x.path));
  if (!f) throw new AiError('model-mismatch', `the model has no file matching ${re}`);
  return f;
};

/** Greedy decoding of misaki's grapheme-to-phoneme network for one word. */
async function fallbackWord(state, word) {
  if (state.cache.has(word)) return state.cache.get(word);
  const { ort, g2p, g2pInfo } = state;
  const gIndex = g2pInfo.graphemeIndex;
  const ids = [g2pInfo.start, ...[...word].map(c => gIndex.get(c) ?? g2pInfo.unknown), g2pInfo.eos].map(BigInt);
  const input = new ort.Tensor('int64', BigInt64Array.from(ids), [1, ids.length]);
  const dec = [BigInt(g2pInfo.start)];
  let out = '';
  for (let step = 0; step < g2pInfo.maxSteps; step++) {
    const r = await g2p.run({ input_ids: input, decoder_input_ids: new ort.Tensor('int64', BigInt64Array.from(dec), [1, dec.length]) });
    const logits = r.logits;
    const V = logits.dims[2], base = (dec.length - 1) * V;
    let best = 0;
    for (let k = 1; k < V; k++) if (logits.data[base + k] > logits.data[base + best]) best = k;
    logits.dispose?.();
    if (best === g2pInfo.eos) break;
    dec.push(BigInt(best));
    if (best > 3) out += g2pInfo.phonemes[best] || '';
  }
  input.dispose?.();
  state.cache.set(word, out);
  return out;
}

export async function load(ctx) {
  const ort = await ctx.ort();
  const vocab = readVocab(JSON.parse(await ctx.text(refOf(ctx, /^tokenizer\.json$/).ref)));
  const voices = new Map();
  for (const f of ctx.files.filter(x => /^voices\/[\w-]+\.bin$/.test(x.path))) {
    voices.set(f.path.slice(7, -4), new Float32Array(await ctx.bytes(f.ref)));
  }
  const lists = JSON.parse(await ctx.text(refOf(ctx, /misaki-en_us-g2p\.json$/).ref));
  const english = createEnglish(lists);
  const g2pInfo = {
    start: lists.start_id ?? lists.bos_id ?? 1, eos: lists.eos_id ?? 2, unknown: lists.unknown_id ?? 3, maxSteps: lists.max_steps || 64,
    graphemeIndex: new Map([...lists.graphemes].map((c, i) => [c, i]).filter(([, i]) => i > 3)),
    phonemes: [...lists.phonemes],
  };
  const state = { ort, vocab, voices, english, g2pInfo, cache: new Map(), g2p: null, model: null };
  try {
    state.g2p = await createSession(ort, await ctx.bytes(refOf(ctx, /misaki-en_us-g2p\.onnx$/).ref), 'wasm');
    state.model = await ctx.session(refOf(ctx, /^onnx\/model[^/]*\.onnx$/).ref);
    if (ctx.test?.failLoad) throw new AiError('run-failed', 'test hook: the load fails after the sessions exist');
  } catch (err) {
    await dispose(state);
    throw err;
  }
  return state;
}

export async function run(state, input, opts, ctx) {
  const o = normalizeSpeech(input);
  const { ort } = state;
  const voice = state.voices.get(o.voice);
  if (!voice) throw new AiError('not-in-registry', `the voice ${o.voice} is not loaded`);
  if (opts?.test?.failRun) {
    await state.model.run({ input_ids: new ort.Tensor('int64', new BigInt64Array(1), [1, 1]), style: new ort.Tensor('float32', new Float32Array(3), [1, 3]), speed: new ort.Tensor('float32', new Float32Array([1]), [1]) });
  }
  ctx.report('running', { stage: 'phonemes' });
  const items = [];
  for (const s of sentences(o.text)) {
    const ps = o.lang === 'es' ? spanishToPhonemes(s.text) : await englishToPhonemes(state.english, s.text, w => fallbackWord(state, w));
    items.push({ ps, pause: s.pause });
  }
  const chunks = packChunks(items);
  if (!chunks.length) throw new AiError('unsupported-format', 'the text has nothing to read');
  const pieces = [];
  for (let i = 0; i < chunks.length; i++) {
    ctx.report('running', { stage: 'chunk', chunk: i + 1, chunks: chunks.length });
    const { ids, count } = phonemeIds(state.vocab, chunks[i].ps);
    if (!count) continue;
    const out = await state.model.run({
      input_ids: new ort.Tensor('int64', ids, [1, ids.length]),
      style: new ort.Tensor('float32', styleFor(voice, count), [1, 256]),
      speed: new ort.Tensor('float32', new Float32Array([o.speed]), [1]),
    });
    const w = out[state.model.outputNames[0]];
    pieces.push({ samples: Float32Array.from(w.data), pause: chunks[i].pause / o.speed });
    w.dispose?.();
  }
  const samples = joinSpeech(pieces, SPEECH_SAMPLE_RATE);
  const stats = measure([samples], SPEECH_SAMPLE_RATE);
  const blob = new Blob([encodeWav([samples], SPEECH_SAMPLE_RATE)], { type: 'audio/wav' });
  ctx.report('done');
  return {
    value: {
      blob, mime: 'audio/wav', seconds: samples.length / SPEECH_SAMPLE_RATE, sampleRate: SPEECH_SAMPLE_RATE, channels: 1,
      model: ctx.modelId, device: ctx.device, dtype: ctx.dtype, voice: o.voice, lang: o.lang, speed: o.speed, chunks: chunks.length,
      phonemes: chunks.map(c => c.ps), stats,
    },
    transfer: [],
  };
}

export async function dispose(state) {
  if (!state) return;
  await releaseSession(state.model); state.model = null;
  await releaseSession(state.g2p); state.g2p = null;
  state.voices?.clear();
  state.cache?.clear();
}
