// Elffuss · escaparate de la pantalla de descarga.
// ─────────────────────────────────────────────────────────────────────────────
// Mientras baja el modelo (tiempo muerto), en vez de una barra sosa mostramos la
// galaxia del splash + un carrusel de mini-UIs auto-contenidas: «mira lo que se
// construye aquí». Vive en el panel Vista, así el progreso deja de ser la caja
// flotante que en móvil se solapaba con el compositor.
import { DEMOS } from './loading-demos.js';
import { setFrameHtml } from './sandbox-frame.js';

let root = null, galaxy = null, timer = null, idx = 0, frameA = null, frameB = null, showingA = true, mounted = false;

function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; }

export async function show(panel, emptyEl) {
  if (mounted) return;
  mounted = true;
  if (emptyEl) emptyEl.hidden = true;               // tapar el placeholder «hazme un reloj»
  root = el(`
    <div id="loading-stage">
      <div class="ls-galaxy"></div>
      <div class="ls-content">
        <div class="ls-window">
          <div class="ls-bar-top"><i class="d r"></i><i class="d y"></i><i class="d g"></i><span class="ls-badge">—</span></div>
          <div class="ls-frames">
            <iframe class="ls-frame on" sandbox="allow-scripts" title="demostración" scrolling="no"></iframe>
            <iframe class="ls-frame" sandbox="allow-scripts" title="demostración" scrolling="no"></iframe>
          </div>
        </div>
        <div class="ls-head">Preparando tu sistema operativo…</div>
        <div class="ls-sub">el cerebro se descarga una vez y corre <b>en tu máquina</b>. Mientras, mira lo que sabe construir:</div>
        <div class="ls-prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-labelledby="ls-progtext"><div class="ls-bar indet"></div></div>
        <div class="ls-progtext" id="ls-progtext">Descargando…</div>
      </div>
    </div>`);
  panel.appendChild(root);
  const frames = root.querySelectorAll('.ls-frame');
  frameA = frames[0]; frameB = frames[1]; showingA = true; idx = 0;
  paint(frameA, DEMOS[0]); badge(DEMOS[0].title);

  // galaxia de fondo (la misma del splash). Si no hay WebGL, queda el gradiente CSS.
  try { const m = await import('./splash-gl.js'); if (root) galaxy = m.startGalaxy(root.querySelector('.ls-galaxy')); } catch { /* opcional */ }

  clearInterval(timer);
  timer = setInterval(cycle, 5200);
}

function paint(frame, demo) { try { setFrameHtml(frame, demo.html); } catch { /* — */ } }
function badge(t) { const b = root?.querySelector('.ls-badge'); if (b) b.textContent = t; }

function cycle() {
  if (!root || DEMOS.length < 2) return;
  idx = (idx + 1) % DEMOS.length;
  const next = showingA ? frameB : frameA;
  const cur = showingA ? frameA : frameB;
  paint(next, DEMOS[idx]);
  // dar un instante a que el siguiente empiece a dibujar antes del crossfade
  setTimeout(() => {
    if (!root) return;
    next.classList.add('on'); cur.classList.remove('on');
    badge(DEMOS[idx].title);
    showingA = !showingA;
    // parar el rAF del que sale (menos presión de GPU en móvil)
    setTimeout(() => { if (root && !cur.classList.contains('on')) { try { setFrameHtml(cur, ''); } catch { /* — */ } } }, 900);
  }, 420);
}

// progreso: número (%) → barra determinada; string → barra indeterminada + texto.
// La barra es una barra de progreso también para un lector de pantalla
// (role=progressbar con aria-valuenow cuando se sabe el %).
export function setProgress(p) {
  if (!root) return;
  const bar = root.querySelector('.ls-bar'), txt = root.querySelector('.ls-progtext');
  const prog = root.querySelector('.ls-prog');
  const valor = v => { if (v == null) prog.removeAttribute('aria-valuenow'); else prog.setAttribute('aria-valuenow', String(Math.round(v))); };
  if (typeof p === 'number' && isFinite(p)) {
    bar.classList.remove('indet'); bar.style.width = Math.max(2, Math.min(100, p)) + '%';
    txt.textContent = `Descargando el cerebro · ${Math.round(p)}%`;
    valor(Math.min(100, p));
  } else if (typeof p === 'string') {
    // extraer un % si el string lo trae («… 42%…»), si no barra indeterminada
    const m = p.match(/(\d+)\s*%/);
    if (m) { bar.classList.remove('indet'); bar.style.width = m[1] + '%'; valor(+m[1]); }
    else { bar.classList.add('indet'); bar.style.width = ''; valor(null); }
    txt.textContent = p;
  }
}

export function isMounted() { return mounted; }

export function hide(emptyEl, appHidden) {
  if (!mounted) return;
  mounted = false;
  clearInterval(timer); timer = null;
  try { galaxy?.stop(); } catch { /* — */ }
  galaxy = null;
  root?.remove(); root = null; frameA = frameB = null;
  // si no hay app abierta, devolver el placeholder
  if (emptyEl && appHidden) emptyEl.hidden = false;
}
