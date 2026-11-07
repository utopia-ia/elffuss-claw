// SPDX-License-Identifier: Apache-2.0 AND MIT
// Copyright (c) 2026 UtopiaIA
// Portions Copyright (c) 2026 Miguel Ángel Durán (runonweb.ai, MIT; see LICENSES/MIT-runonweb.txt):
//   the turn queue is takeOrtTurn of packages/runonweb/src/core/device.ts:61-70.
//
// A queue of turns. ONNX Runtime Web cannot run two sessions of one instance at
// the same time on WebGPU ("Session already started"), and Transformers.js keeps
// its own chains that break after a failure, so every run of a task goes through
// one of these. A rejected turn does not stop the next one.

/**
 * @returns {{ run<T>(fn: () => Promise<T>): Promise<T>, readonly pending: number, idle(): Promise<void> }}
 */
export function createQueue() {
  let tail = Promise.resolve();
  let pending = 0;
  return {
    run(fn) {
      pending++;
      const next = tail.then(fn, fn);
      tail = next.then(() => undefined, () => undefined).finally(() => { pending--; });
      return next;
    },
    get pending() { return pending; },
    idle() { return tail; },
  };
}
