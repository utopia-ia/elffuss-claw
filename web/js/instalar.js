// Instalar Elffuss como app en el móvil. Es lo PRIMERO que se ofrece al entrar
// desde un teléfono si no está instalada (2-nov-2026), en cada visita: cerrarlo
// lo calla solo hasta la próxima.
//
// Por qué importa: el modelo pesa un giga y vive en el almacenamiento del
// navegador. Safari borra ese almacenamiento a una web que no se abre en siete
// días; a una app de la pantalla de inicio, no. Instalada, además, se abre a
// pantalla completa. Al arrancar instalada se pide almacenamiento persistente.
//
// Android/Chrome da el diálogo de instalar (`beforeinstallprompt`); iOS no lo
// tiene, así que allí se explica el gesto: Compartir → «Añadir a pantalla de inicio».

const instalada = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const esTelefono = () => navigator.userAgentData?.mobile === true ||
  (matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches);
const iOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const en = !/^es\b/i.test(navigator.language || 'es');
const T = en ? {
  titulo: 'Install it as an app',
  porque: 'It opens full screen, and your phone keeps the model saved instead of clearing it after a few days without use.',
  boton: 'Install',
  ios: 'Tap Share and then “Add to Home Screen”.',
  otro: 'Open the browser menu and choose “Add to Home screen”.',
  cerrar: 'Not now',
} : {
  titulo: 'Instálala como app',
  porque: 'Se abre a pantalla completa y el teléfono guarda el modelo en vez de borrarlo tras unos días sin usarla.',
  boton: 'Instalar',
  ios: 'Pulsa Compartir y luego «Añadir a pantalla de inicio».',
  otro: 'Abre el menú del navegador y elige «Añadir a pantalla de inicio».',
  cerrar: 'Ahora no',
};

let aviso = null;
let diferido = null;   // el evento de Chrome, para lanzar su diálogo desde el botón

function pinta() {
  if (aviso || !document.body) return;
  aviso = document.createElement('div');
  aviso.id = 'elffuss-instalar';
  aviso.setAttribute('role', 'dialog');
  aviso.setAttribute('aria-label', T.titulo);
  aviso.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));' +
    'z-index:2147483000;background:#fffdf7;color:#1d1b16;border:1px solid #e6dcc3;border-radius:14px;' +
    'box-shadow:0 8px 30px rgba(0,0,0,.25);padding:14px 16px;font:15px/1.4 system-ui,sans-serif';
  const b = document.createElement('b'); b.textContent = T.titulo; b.style.display = 'block';
  const p = document.createElement('p'); p.textContent = T.porque; p.style.margin = '6px 0 10px';
  const fila = document.createElement('div'); fila.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';
  if (diferido) {
    const ok = document.createElement('button'); ok.textContent = T.boton;
    ok.style.cssText = 'background:#c8962a;color:#fff;border:0;border-radius:10px;padding:9px 16px;font:inherit;font-weight:600';
    ok.onclick = async () => { const e = diferido; diferido = null; quita(); try { await e.prompt(); } catch { /* — */ } };
    fila.append(ok);
  } else {
    const ios = document.createElement('span'); ios.textContent = iOS() ? T.ios : T.otro; ios.style.fontWeight = '600';
    fila.append(ios);
  }
  const no = document.createElement('button'); no.textContent = T.cerrar;
  no.style.cssText = 'margin-left:auto;background:none;border:0;color:#6b6457;font:inherit;padding:9px 6px';
  no.onclick = () => { try { sessionStorage.setItem('elffuss.instalar.no', '1'); } catch { /* — */ } quita(); };
  fila.append(no);
  aviso.append(b, p, fila);
  document.body.append(aviso);
}
function quita() { aviso?.remove(); aviso = null; }

export function ofrecerInstalar() {
  if (instalada()) {
    navigator.storage?.persist?.().catch(() => {});
    return;
  }
  if (!esTelefono()) return;
  try { if (sessionStorage.getItem('elffuss.instalar.no') === '1') return; } catch { /* — */ }
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); diferido = e; quita(); pinta(); });
  addEventListener('appinstalled', quita);
  // iOS no avisa: se pinta ya. En Android se espera al evento de Chrome, y si no
  // llega (otro navegador) se pinta igual con la explicación.
  if (iOS()) pinta();
  else setTimeout(() => { if (!diferido) pinta(); }, 2500);
}
