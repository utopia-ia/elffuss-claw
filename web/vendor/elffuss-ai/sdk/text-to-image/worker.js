// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The Worker of the text-to-image task.
import { serveTask } from '../core/worker-rpc.js';
import * as impl from './impl.js';

serveTask(impl);
