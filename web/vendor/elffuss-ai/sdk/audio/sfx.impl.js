// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The text-to-sfx task where the model runs: Stable Audio 3 Small SFX.
import { stableAudioImpl } from './stable-audio.js';

const impl = stableAudioImpl('text-to-sfx');
export const task = impl.task;
export const load = ctx => impl.load(ctx);
export const run = (state, input, opts, ctx) => impl.run(state, input, opts, ctx);
export const dispose = state => impl.dispose(state);
