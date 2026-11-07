// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The one Trusted Types policy of the sites, `elffuss-ai`. Their CSP requires
// Trusted Types for scripts, so a Worker can only be created from a URL this
// policy vouches for: same origin, under /v/ (a build) or /vendor/ (a runtime).
// Where the browser has no Trusted Types, the URL is checked the same way and
// passed on as a string.

let policy = null;

/** Paths a script URL may have. */
export const SCRIPT_PREFIXES = Object.freeze(['/v/', '/vendor/']);

/** True when `url` is a same-origin script under an allowed prefix. */
export function isAllowedScriptUrl(url, origin = globalThis.location?.origin) {
  let u;
  try { u = new URL(String(url), globalThis.location?.href); } catch { return false; }
  if (u.origin !== origin || u.search || u.hash) return false;
  if (u.pathname.split('/').some(s => s === '..' || s === '.')) return false;
  return SCRIPT_PREFIXES.some(p => u.pathname.startsWith(p)) && /\.m?js$/.test(u.pathname);
}

function getPolicy() {
  if (policy || !globalThis.trustedTypes?.createPolicy) return policy;
  policy = globalThis.trustedTypes.createPolicy('elffuss-ai', {
    createScriptURL(url) {
      if (!isAllowedScriptUrl(url)) throw new TypeError('script URL refused by the elffuss-ai policy');
      return url;
    },
  });
  return policy;
}

/**
 * A script URL the CSP accepts for `new Worker()`.
 * @param {string|URL} url
 * @returns {TrustedScriptURL|string}
 */
export function scriptUrl(url) {
  const s = String(url);
  const p = getPolicy();
  if (p) return p.createScriptURL(s);
  if (!isAllowedScriptUrl(s)) throw new TypeError('script URL refused');
  return s;
}
