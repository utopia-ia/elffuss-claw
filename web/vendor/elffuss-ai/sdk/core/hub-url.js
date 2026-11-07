// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Hugging Face URLs. This is the only module of the repo that spells the Hub's
// host or its resolve path: everything else asks here.
//
// A pinned URL is https://huggingface.co/<owner>/<repo>/resolve/<40-hex commit>/<path>.
// Every path segment must start with a letter, digit, `_` or `-` and contain only
// those and dots: no `..`, no percent-escapes, no backslashes. URLs are normalised
// when fetched, so `…/resolve/<sha>/../../../other/repo/resolve/<branch>/x` would end
// up in another repository; the model store refuses those and so does this module.

/** Origin of the Hugging Face Hub. */
export const HUB_ORIGIN = 'https://huggingface.co';

const SEG = '[\\w\\-][\\w.\\-]*';
const REPO = `${SEG}/${SEG}`;
const PATH = `(?:${SEG}/)*${SEG}`;

/** A URL of a file pinned to a commit, as the model store accepts it. Groups: repo, revision, path. */
export const PINNED_URL_RE = new RegExp(`^https://huggingface\\.co/(${REPO})/resolve/([0-9a-f]{40})/(${PATH})$`);
const RESOLVE_URL_RE = new RegExp(`^https://huggingface\\.co/(${REPO})/resolve/([^/?#]+)/(${PATH})$`);
const REPO_RE = new RegExp(`^${REPO}$`);
const PATH_RE = new RegExp(`^${PATH}$`);
const SHA_RE = /^[0-9a-f]{40}$/;

/** True when `repo` looks like `owner/name` with safe characters. */
export function isRepoId(repo) {
  return typeof repo === 'string' && REPO_RE.test(repo);
}

/** True when `path` is a relative path whose segments are all safe. */
export function isSafePath(path) {
  return typeof path === 'string' && PATH_RE.test(path);
}

/** True when `revision` is a full 40-hex commit. */
export function isCommit(revision) {
  return typeof revision === 'string' && SHA_RE.test(revision);
}

/**
 * The pinned URL of one file.
 * @param {string} repo `owner/name`
 * @param {string} revision 40-hex commit
 * @param {string} path path inside the repository
 */
export function pinnedUrl(repo, revision, path) {
  if (!isRepoId(repo)) throw new TypeError('bad repo id: ' + repo);
  if (!isCommit(revision)) throw new TypeError('revision must be a 40-hex commit: ' + revision);
  if (!isSafePath(path)) throw new TypeError('unsafe path: ' + path);
  return `${HUB_ORIGIN}/${repo}/resolve/${revision}/${path}`;
}

/**
 * Split a pinned URL.
 * @returns {{ repo: string, revision: string, path: string } | null}
 */
export function parsePinnedUrl(url) {
  const m = PINNED_URL_RE.exec(String(url ?? ''));
  return m ? { repo: m[1], revision: m[2], path: m[3] } : null;
}

/**
 * Split any resolve URL of the Hub (revision may be a branch name, as the ones
 * Transformers.js builds for `main`). Unsafe paths, queries and fragments give null.
 * @returns {{ repo: string, revision: string, path: string } | null}
 */
export function parseResolveUrl(url) {
  const s = String(url ?? '');
  const m = RESOLVE_URL_RE.exec(s);
  if (!m) return null;
  let revision;
  try { revision = decodeURIComponent(m[2]); } catch { return null; }
  if (!/^[\w.\-]+$/.test(revision)) return null;
  return { repo: m[1], revision, path: m[3] };
}

/** True for any URL on the Hub's origin (used to refuse what is not pinned). */
export function isHubUrl(url) {
  try { return new URL(String(url)).origin === HUB_ORIGIN; } catch { return false; }
}

/**
 * The key the model store gives a URL: the URL without query or fragment, with
 * every run of other characters turned into `_`, keeping the last 180.
 */
export function storeKey(url) {
  return String(url).replace(/[?#].*$/, '').replace(/[^\w.\-]+/g, '_').slice(-180);
}

/** Link to the page of a repository on the Hub, at a revision. */
export function repoPage(repo, revision) {
  if (!isRepoId(repo)) throw new TypeError('bad repo id: ' + repo);
  return revision ? `${HUB_ORIGIN}/${repo}/tree/${revision}` : `${HUB_ORIGIN}/${repo}`;
}
