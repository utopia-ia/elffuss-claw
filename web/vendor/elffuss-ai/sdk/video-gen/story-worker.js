// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
import { serveTask } from '../core/worker-rpc.js';
import * as impl from './story-impl.js';

serveTask(impl);
