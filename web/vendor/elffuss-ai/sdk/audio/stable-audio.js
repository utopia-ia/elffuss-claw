// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Stable Audio 3 Small (music or sound effects) where the model runs: the
// T5Gemma text encoder, the DiT and the SAME-S decoder of Stability AI's ONNX
// export, on ONNX Runtime Web (WebGPU). A run tokenises the prompt, encodes it
// once, draws the latent noise from the seed, takes the sampler's steps through
// the DiT and decodes the latent to 44.1 kHz stereo; the decoder's limiter keeps
// the peaks under full scale. The three sessions stay loaded between runs and
// are all released by dispose(). Never fetches and never touches the DOM.

import { AiError } from '../core/errors.js';
import { releaseSession } from '../core/ort-env.js';
import { parseModel, createTokenizer, encodeFixed } from './spm.js';
import { createRng, isSeed, randomSeed } from './rng.js';
import { SAMPLE_RATE, LATENT_CHANNELS, DEFAULT_STEPS, latentLength, decoderLength, schedule, pingpongStep, pcmToChannels } from './sampler.js';
import { encodeWav } from './wav.js';
import { fadeOut, measure } from './signal.js';
import { doubleScalarsToInt64 } from './graph-patch.js';

/** Tokens of the prompt the text encoder reads. */
export const PROMPT_TOKENS = 256;
/** Longest prompt accepted, in characters. */
export const MAX_PROMPT = 2000;
/** Durations each task offers, in seconds. */
export const DURATION = Object.freeze({
  'text-to-music': Object.freeze({ min: 2, max: 120, default: 30 }),
  'text-to-sfx': Object.freeze({ min: 0.5, max: 30, default: 5 }),
});
/** Steps a caller may ask for. */
export const STEPS = Object.freeze({ min: 4, max: 16, default: DEFAULT_STEPS });

/**
 * Check and complete the options of a run.
 * @param {string} task
 * @param {{ prompt?: string, seconds?: number, seed?: number, steps?: number }} input
 */
export function normalizeInput(task, input) {
  const d = DURATION[task];
  const prompt = String(input?.prompt ?? '').trim();
  if (!prompt) throw new AiError('unsupported-format', 'a prompt is needed');
  if (prompt.length > MAX_PROMPT) throw new AiError('too-large', `the prompt has ${prompt.length} characters, at most ${MAX_PROMPT}`);
  const seconds = input?.seconds == null ? d.default : Number(input.seconds);
  if (!Number.isFinite(seconds) || seconds < d.min || seconds > d.max) throw new AiError('too-large', `seconds must be between ${d.min} and ${d.max}`, { details: { min: d.min, max: d.max } });
  const seed = input?.seed == null ? randomSeed() : Number(input.seed);
  if (!isSeed(seed)) throw new AiError('unsupported-format', 'seed must be an integer from 0 to 2147483647');
  const steps = input?.steps == null ? STEPS.default : Number(input.steps);
  if (!Number.isInteger(steps) || steps < STEPS.min || steps > STEPS.max) throw new AiError('unsupported-format', `steps must be an integer from ${STEPS.min} to ${STEPS.max}`);
  return { prompt, seconds: Math.round(seconds * 100) / 100, seed, steps };
}

const refOf = (ctx, re) => {
  const f = ctx.files.find(x => re.test(x.path));
  if (!f) throw new AiError('model-mismatch', `the model has no file matching ${re}`);
  return f.ref;
};

/**
 * The decoder's session. Its limiter casts four double constants to float, and the
 * WebGPU build of ONNX Runtime Web has no Cast from double: they become int64 of
 * the same value first (graph-patch.js). The few nodes WebGPU lacks run on
 * WebAssembly inside the session.
 */
async function decoderSession(ctx, ort) {
  const bytes = new Uint8Array(await ctx.bytes(refOf(ctx, /same-s\/dec[^/]*\.onnx$/)));
  const n = doubleScalarsToInt64(bytes, { values: [-1, 1, -32767, 32767] });
  if (n !== 4) throw new AiError('model-mismatch', `the decoder has ${n} of its 4 double constants where they were expected`);
  const providers = ctx.device === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'];
  const s = await ort.InferenceSession.create(bytes, { executionProviders: providers, graphOptimizationLevel: 'all' });
  s.elffussProvider = providers[0];
  return s;
}

/** Implementation of one of the two tasks. */
export function stableAudioImpl(task) {
  return {
    task,
    async load(ctx) {
      const ort = await ctx.ort();
      const tok = createTokenizer(parseModel(await ctx.bytes(refOf(ctx, /tokenizer\.model$/))));
      const state = { ort, tok, enc: null, dit: null, dec: null };
      // The few nodes WebGPU does not take (casts of double constants, the decoder's
      // noise) run on WebAssembly inside the same session.
      const providers = ctx.device === 'webgpu' ? ['webgpu', 'wasm'] : undefined;
      try {
        state.enc = await ctx.session(refOf(ctx, /t5gemma\/encoder\.onnx$/), { providers });
        state.dit = await ctx.session(refOf(ctx, /\/dit[^/]*\.onnx$/), { providers });
        state.dec = await decoderSession(ctx, ort);
        if (ctx.test?.failLoad) throw new AiError('run-failed', 'test hook: the load fails after the sessions exist');
      } catch (err) {
        await this.dispose(state);
        throw err;
      }
      return state;
    },

    async run(state, input, opts, ctx) {
      const { ort } = state;
      const o = normalizeInput(task, input);
      const T = (type, data, dims) => new ort.Tensor(type, data, dims);
      if (opts?.test?.failRun) {
        // Test builds only: an input of an impossible shape, inside the runtime.
        await state.dit.run({ x: T('float32', new Float32Array(3), [1, 3, 1]) });
      }
      ctx.report('running', { stage: 'encode' });
      const { ids, mask, truncated } = encodeFixed(state.tok, o.prompt, PROMPT_TOKENS);
      const encOut = await state.enc.run({ input_ids: T('int64', ids, [1, PROMPT_TOKENS]), attention_mask: T('int64', mask, [1, PROMPT_TOKENS]) });
      const hidden = encOut[state.enc.outputNames[0]];
      const hiddenData = hidden.type === 'float32' ? hidden.data : Float32Array.from(hidden.data);
      const maskF = Float32Array.from(mask, v => Number(v));
      const L = latentLength(o.seconds);
      const x = createRng(o.seed).fillNormal(new Float32Array(LATENT_CHANNELS * L));
      const noise = createRng(o.seed + 1);
      const sigmas = schedule(o.steps);
      const fixed = {
        t5_hidden: T('float32', hiddenData, [1, PROMPT_TOKENS, 768]),
        t5_mask: T('float32', maskF, [1, PROMPT_TOKENS]),
        seconds_total: T('float32', new Float32Array([o.seconds]), [1]),
        local_add_cond: T('float32', new Float32Array(257 * L), [1, 257, L]),
      };
      hidden.dispose?.();
      for (let i = 0; i < o.steps; i++) {
        ctx.report('running', { stage: 'step', step: i + 1, steps: o.steps });
        const out = await state.dit.run({ x: T('float32', x, [1, LATENT_CHANNELS, L]), t: T('float32', new Float32Array([sigmas[i]]), [1]), ...fixed });
        const v = out[state.dit.outputNames[0]];
        const last = i === o.steps - 1;
        pingpongStep(x, v.data, sigmas[i], sigmas[i + 1], last ? null : noise.fillNormal(new Float32Array(x.length)));
        v.dispose?.();
      }
      ctx.report('running', { stage: 'decode' });
      const Ld = decoderLength(L);
      let lat = x;
      if (Ld !== L) {
        lat = new Float32Array(LATENT_CHANNELS * Ld);
        for (let c = 0; c < LATENT_CHANNELS; c++) {
          lat.set(x.subarray(c * L, (c + 1) * L), c * Ld);
          lat[c * Ld + L] = x[c * L + L - 1];
        }
      }
      const decOut = await state.dec.run({ latent: T('float32', lat, [1, LATENT_CHANNELS, Ld]) });
      const pcm = decOut[state.dec.outputNames[0]];
      const frames = Math.round(o.seconds * SAMPLE_RATE);
      const channels = pcmToChannels(pcm.data, frames, 2);
      pcm.dispose?.();
      // The cut at the asked length can fall in the middle of a sound: a short fade.
      for (const c of channels) fadeOut(c, Math.round(SAMPLE_RATE * 0.02));
      const stats = measure(channels, SAMPLE_RATE);
      const blob = new Blob([encodeWav(channels, SAMPLE_RATE)], { type: 'audio/wav' });
      ctx.report('done');
      return {
        value: {
          blob, mime: 'audio/wav', seconds: channels[0].length / SAMPLE_RATE, sampleRate: SAMPLE_RATE, channels: 2, seed: o.seed,
          model: ctx.modelId, device: ctx.device, dtype: ctx.dtype, decoder: state.dec.elffussProvider || ctx.device, steps: o.steps, prompt: o.prompt, truncated, stats,
        },
        transfer: [],
      };
    },

    async dispose(state) {
      if (!state) return;
      for (const k of ['enc', 'dit', 'dec']) { await releaseSession(state[k]); state[k] = null; }
    },
  };
}
