// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// @elffuss/ai/core: the pieces every task module is built on, for sites and for
// anyone writing a new task. Importing it has no side effects.

export { AiError, ERROR_CODES, isAiError, toAiError, fromStoreError, serializeError, deserializeError } from './errors.js';
export { probeWebGPU, chooseVariant, variantFits, isShaderError, threadCount, ortVariantFor, canGrowWasmMemory } from './device.js';
export { createQueue } from './queue.js';
export { createProgress, missingBytes, STATUSES } from './progress.js';
export { HUB_ORIGIN, pinnedUrl, parsePinnedUrl, storeKey, repoPage } from './hub-url.js';
export { loadRegistry, getModel, defaultModelId, taskModule, modelBases, resolveRef, variantFiles, findFile, registryRepos, registryUrls } from './registry.js';
export { createStoreClient, DEFAULT_STORE_URL } from './store-client.js';
export { createWorkerStore, serveStore } from './store-bridge.js';
export { createVerifiedMemo, verifyFile, sha256Hex, gitBlobSha1 } from './integrity.js';
export { PINS, VENDOR_DIRS } from './runtime-pins.js';
export { ORT_VARIANTS, PDFJS_FILES, runtimeUrls, transformersDir, assertTransformersRuntime, assertOrtRuntime, assertPdfjsRuntime } from './runtimes.js';
export { sniffImageType, DECODABLE, MAX_INPUT_PIXELS, imageSize, checkPixelBudget, previewBitmap, previewImage, toTransferable, decodeImage, encodePng } from './image-input.js';
export { scriptUrl, isAllowedScriptUrl } from './tt.js';
export { loadTransformers, configureTransformers, createStoreFetch, createPipeline } from './tf-env.js';
export { loadOrt, createSession, releaseSession, tensor } from './ort-env.js';
export { Task, oneShot, TASK_OPTIONS } from './task.js';
export { loadTask, TaskContext } from './task-runtime.js';
export { serveTask, runResult } from './worker-rpc.js';
export { createWorkerHost } from './worker-host.js';
export { crc32, createZip, readZip, sanitizeZipPath, uniquePaths } from './zip.js';
export { encodePngSamples, decodePng } from './png.js';
