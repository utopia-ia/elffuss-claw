// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The Worker of the sfx task.
import { serveTask } from '../core/worker-rpc.js';
import * as impl from './sfx.impl.js';

serveTask(impl);
