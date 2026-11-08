// Frames that show a page made here (the apps, the loading demos, the game checker): the page is written into
// /sandbox/run.html instead of being set as `srcdoc`. A srcdoc document inherits this page's Content-Security-Policy,
// which runs no inline script; run.html is served with its own policy and a `sandbox` directive (opaque origin), so
// the page runs as before and still cannot reach this origin's storage. See deploy/headers.json, «sandbox».
//
// The handshake: the frame loads run.html?n=<id>, run.html says {sbx:'ready', n} to its parent (this origin only),
// and gets {sbx:'html', n, html} back. The frame's origin is opaque, so the reply goes to '*'; it is only sent to
// the window that said ready with that id, and only once.
const SHELL = new URL('../sandbox/run.html', import.meta.url).href;
const contenido = new WeakMap();
const escuchas = new WeakMap();
let cuenta = 0;

/** The page a frame is showing (what setFrameHtml was given last), '' when none. */
export const frameHtml = (frame) => (frame && contenido.get(frame)) || '';

/** Show `html` in `frame` (an <iframe> with a sandbox attribute); '' empties it. */
export function setFrameHtml(frame, html) {
  if (!frame) return;
  const texto = String(html ?? '');
  contenido.set(frame, texto);
  const antes = escuchas.get(frame);
  if (antes) { window.removeEventListener('message', antes); escuchas.delete(frame); }
  frame.removeAttribute('srcdoc');
  if (!texto) { frame.src = 'about:blank'; return; }
  const n = `${++cuenta}-${Math.random().toString(36).slice(2, 10)}`;
  const on = (e) => {
    if (e.source !== frame.contentWindow || !e.data || e.data.sbx !== 'ready' || e.data.n !== n) return;
    window.removeEventListener('message', on);
    escuchas.delete(frame);
    try { frame.contentWindow.postMessage({ sbx: 'html', n, html: texto }, '*'); } catch { /* el marco se fue */ }
  };
  escuchas.set(frame, on);
  window.addEventListener('message', on);
  frame.src = `${SHELL}?n=${encodeURIComponent(n)}`;
}
