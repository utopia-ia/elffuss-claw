// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The Worker of the music task.
import { serveTask } from '../core/worker-rpc.js';
import * as impl from './music.impl.js';

serveTask(impl);
