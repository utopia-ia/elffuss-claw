// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The Worker of the speech task with Elffuss's own voice (MOSS-TTS-Nano).
import { serveTask } from '../core/worker-rpc.js';
import * as impl from './speech-moss.impl.js';

serveTask(impl);
