// Service worker del broker: que la página del broker abra SIN RED.
// ─────────────────────────────────────────────────────────────────────────────
// Los modelos están en la OPFS de este origen, y solo esta página puede
// leerlos. Sin red, el iframe no cargaba y la web que lo embebe se quedaba sin
// sus modelos aunque estuvieran en el disco. Aquí solo se guarda la página
// (red primero: con red siempre se sirve la última).
// Cambiar VERSION si cambia lo que se guarda: un despliegue la renueva.
const VERSION = 'broker-2';
const RAIZ = new URL('./', self.registration.scope).href;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.add(RAIZ)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('broker-') && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.mode !== 'navigate' || new URL(r.url).origin !== location.origin) return;
  e.respondWith((async () => {
    try {
      // Al servidor de verdad, no a la caché HTTP: la página se servía sin Cache-Control y Safari se quedó con una
      // copia de días (sin el arreglo de WebKit) aunque la del servidor ya era otra. Medido en un iPhone, 8-nov.
      const res = await fetch(r.url, { cache: 'no-cache', credentials: 'same-origin' });
      if (res.ok) { const copia = res.clone(); caches.open(VERSION).then(c => c.put(RAIZ, copia)).catch(() => {}); }
      return res;
    } catch (err) {
      const guardada = await caches.match(RAIZ);
      if (guardada) return guardada;
      throw err;
    }
  })());
});
