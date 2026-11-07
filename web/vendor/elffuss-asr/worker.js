// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
// The Worker of the speech-to-text task (index.js): the SDK core serves impl.js here.
import { serveTask } from '../elffuss-ai/sdk/core/worker-rpc.js';
import * as impl from './impl.js';
serveTask(impl);
