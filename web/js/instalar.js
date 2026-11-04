// Instalar Elffuss como app. El mismo fichero en Claw y en Code.
//
// Por qué importa: el modelo pesa un giga y vive en el almacenamiento del
// navegador. Safari borra ese almacenamiento a una web que no se abre en siete
// días; a una app instalada, no. Instalada, además, se abre en su propia
// ventana. Al arrancar instalada se pide almacenamiento persistente.
//
// Dos caminos:
// - El aviso automático: solo en el teléfono, lo PRIMERO al entrar si no está
//   instalada. «Ahora no» lo calla hasta que se cierre la pestaña.
// - La entrada del menú («Instalar … como app»): siempre que no esté instalada,
//   también tras «Ahora no» y en el ordenador. Si el navegador tiene su diálogo
//   (`beforeinstallprompt`, Chrome/Edge) lo abre; si no, enseña los pasos:
//   iPhone/iPad, Compartir → «Añadir a pantalla de inicio»; Safari en el Mac,
//   Archivo → «Añadir al Dock»; el resto, el menú del navegador.
//
// «Instalada» es cualquier modo que no sea el de pestaña: mirar solo
// `standalone` dejaba fuera ventanas de app reales (minimal-ui, window-controls-overlay).

const instalada = () => !matchMedia('(display-mode: browser)').matches || navigator.standalone === true;
const enMarco = () => { try { return window.top !== window; } catch { return true; } };
const esTelefono = () => navigator.userAgentData?.mobile === true ||
  (matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches);
const iOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const safariMac = () => !iOS() && /Macintosh/.test(navigator.userAgent) && /Version\/\d+.*Safari/.test(navigator.userAgent) &&
  !/Chrome|Chromium|Edg|Firefox/.test(navigator.userAgent);
const NO = 'elffuss.instalar.no';

const TEXTOS = {
  es: {
    entrada: 'Instalar {app} como app',
    titulo: 'Instala {app} como app',
    porque: 'Se abre en su propia ventana, y el navegador guarda el modelo en vez de borrarlo tras unos días sin usarla.',
    boton: 'Instalar',
    ios: 'Pulsa Compartir y luego «Añadir a pantalla de inicio».',
    mac: 'En el menú Archivo, elige «Añadir al Dock».',
    otro: 'Abre el menú del navegador y elige «Instalar app» o «Añadir a pantalla de inicio».',
    cerrar: 'Ahora no',
  },
  en: {
    entrada: 'Install {app} as an app',
    titulo: 'Install {app} as an app',
    porque: 'It opens in its own window, and the browser keeps the model saved instead of clearing it after a few days without use.',
    boton: 'Install',
    ios: 'Tap Share and then “Add to Home Screen”.',
    mac: 'In the File menu, choose “Add to Dock”.',
    otro: 'Open the browser menu and choose “Install app” or “Add to Home screen”.',
    cerrar: 'Not now',
  },
  pt: {
    entrada: 'Instalar {app} como app',
    titulo: 'Instala {app} como app',
    porque: 'Abre na sua própria janela, e o navegador guarda o modelo em vez de o apagar após uns dias sem uso.',
    boton: 'Instalar',
    ios: 'Toca em Partilhar e depois em «Adicionar ao ecrã principal».',
    mac: 'No menu Ficheiro, escolhe «Adicionar à Dock».',
    otro: 'Abre o menu do navegador e escolhe «Instalar app» ou «Adicionar ao ecrã principal».',
    cerrar: 'Agora não',
  },
  fr: {
    entrada: 'Installer {app} comme app',
    titulo: 'Installez {app} comme app',
    porque: 'Elle s’ouvre dans sa propre fenêtre, et le navigateur garde le modèle au lieu de l’effacer après quelques jours sans usage.',
    boton: 'Installer',
    ios: 'Touchez Partager, puis « Sur l’écran d’accueil ».',
    mac: 'Dans le menu Fichier, choisissez « Ajouter au Dock ».',
    otro: 'Ouvrez le menu du navigateur et choisissez « Installer l’application » ou « Ajouter à l’écran d’accueil ».',
    cerrar: 'Pas maintenant',
  },
  de: {
    entrada: '{app} als App installieren',
    titulo: '{app} als App installieren',
    porque: 'Sie öffnet sich in einem eigenen Fenster, und der Browser behält das Modell, statt es nach ein paar Tagen ohne Nutzung zu löschen.',
    boton: 'Installieren',
    ios: 'Tippe auf Teilen und dann auf „Zum Home-Bildschirm“.',
    mac: 'Wähle im Menü Ablage „Zum Dock hinzufügen“.',
    otro: 'Öffne das Browsermenü und wähle „App installieren“ oder „Zum Startbildschirm hinzufügen“.',
    cerrar: 'Nicht jetzt',
  },
  uk: {
    entrada: 'Встановити {app} як застосунок',
    titulo: 'Встановіть {app} як застосунок',
    porque: 'Він відкривається у власному вікні, а браузер зберігає модель, замість стирати її після кількох днів без використання.',
    boton: 'Встановити',
    ios: 'Натисніть «Поділитися», а потім «На початковий екран».',
    mac: 'У меню «Файл» виберіть «Додати на Dock».',
    otro: 'Відкрийте меню браузера й виберіть «Встановити застосунок» або «Додати на головний екран».',
    cerrar: 'Не зараз',
  },
};

let app = 'Elffuss';
let idioma = () => 'es';
let aviso = null;
let diferido = null;   // el evento de Chrome, para lanzar su diálogo desde el botón
let hecho = false;     // `appinstalled` llegó en esta página
const entradas = new Set();

const T = () => {
  const l = String(idioma() || '').slice(0, 2).toLowerCase();
  const x = TEXTOS[l] || TEXTOS.en;
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, v.replace('{app}', app)]));
};

function pinta() {
  if (aviso || !document.body) return;
  const t = T();
  aviso = document.createElement('div');
  aviso.id = 'elffuss-instalar';
  aviso.setAttribute('role', 'dialog');
  aviso.setAttribute('aria-label', t.titulo);
  aviso.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));' +
    'z-index:2147483000;background:#fffdf7;color:#1d1b16;border:1px solid #e6dcc3;border-radius:14px;' +
    'box-shadow:0 8px 30px rgba(0,0,0,.25);padding:14px 16px;font:15px/1.4 system-ui,sans-serif;max-width:560px;margin:0 auto';
  const b = document.createElement('b'); b.textContent = t.titulo; b.style.display = 'block';
  const p = document.createElement('p'); p.textContent = t.porque; p.style.margin = '6px 0 10px';
  const fila = document.createElement('div'); fila.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';
  if (diferido) {
    const ok = document.createElement('button'); ok.type = 'button'; ok.textContent = t.boton;
    ok.style.cssText = 'background:#c8962a;color:#fff;border:0;border-radius:10px;padding:9px 16px;font:inherit;font-weight:600;cursor:pointer';
    ok.onclick = () => abreDialogo();
    fila.append(ok);
  } else {
    const como = document.createElement('span'); como.className = 'instalar-pasos';
    como.textContent = iOS() ? t.ios : safariMac() ? t.mac : t.otro; como.style.cssText = 'font-weight:600;flex:1 1 12rem';
    fila.append(como);
  }
  const no = document.createElement('button'); no.type = 'button'; no.textContent = t.cerrar;
  no.style.cssText = 'margin-left:auto;background:none;border:0;color:#6b6457;font:inherit;padding:9px 6px;cursor:pointer';
  no.onclick = () => { try { sessionStorage.setItem(NO, '1'); } catch { /* — */ } quita(); };
  fila.append(no);
  aviso.append(b, p, fila);
  document.body.append(aviso);
}
function quita() { aviso?.remove(); aviso = null; }

async function abreDialogo() {
  const e = diferido; diferido = null; quita();
  try { await e.prompt(); } catch { /* el navegador no quiso enseñarlo */ }
}

/** ¿Tiene sentido ofrecer instalarla ahora? (no instalada, no dentro de otra página) */
export function puedeInstalarse() {
  return !hecho && !instalada() && !enMarco();
}

/** Lo que hace la entrada del menú: el diálogo del navegador, o los pasos. */
export function instalar() {
  if (!puedeInstalarse()) return;
  if (diferido) { abreDialogo(); return; }
  quita(); pinta();
  aviso?.querySelector('button')?.focus({ preventScroll: true });
}

/** Texto de la entrada del menú, en el idioma de la app. */
export const textoEntrada = () => T().entrada;

/**
 * Cablea un botón como entrada «Instalar … como app»: se ve solo mientras
 * se pueda instalar y desaparece al instalarla. Vale para botones que la app
 * vuelve a pintar (se puede llamar las veces que haga falta).
 */
export function entradaInstalar(boton) {
  if (!boton) return boton;
  if (!boton.dataset.instalarCableada) {
    boton.dataset.instalarCableada = '1';
    boton.addEventListener('click', instalar);
  }
  if (!boton.textContent.trim()) boton.textContent = T().entrada;
  boton.hidden = !puedeInstalarse();
  entradas.add(boton);
  return boton;
}

/**
 * Arranque: pide almacenamiento persistente si ya está instalada; si no,
 * prepara la entrada y, en el teléfono, el aviso automático.
 * @param {{ app?: string, idioma?: () => string }} [o]
 */
export function ofrecerInstalar(o = {}) {
  if (o.app) app = o.app;
  if (o.idioma) idioma = o.idioma;
  // Dentro de otra página (elffuss.com la abre en un marco) instalar no le toca a ella: lo ofrece la de fuera.
  if (enMarco()) return;
  if (instalada()) {
    navigator.storage?.persist?.().catch(() => {});
    return;
  }
  for (const b of document.querySelectorAll('[data-instalar]')) entradaInstalar(b);
  let callado = false;
  try { callado = sessionStorage.getItem(NO) === '1'; } catch { /* — */ }
  const auto = esTelefono() && !callado;
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); diferido = e; if (auto) { quita(); pinta(); } });
  addEventListener('appinstalled', () => {
    hecho = true; quita();
    for (const b of entradas) b.hidden = true;
    navigator.storage?.persist?.().catch(() => {});
  });
  if (!auto) return;
  // iOS no avisa: se pinta ya. En Android se espera al evento de Chrome, y si no
  // llega (otro navegador) se pinta igual con la explicación.
  if (iOS()) pinta();
  else setTimeout(() => { if (!diferido) pinta(); }, 2500);
}
