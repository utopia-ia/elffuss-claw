// Qué orígenes acepta cada pieza, y a qué broker va cada modelo.
// ─────────────────────────────────────────────────────────────────────────────
// Sin navegador ni GPU: se prueba la lógica, con un `document` de mentira que
// imita lo justo del iframe del broker (contesta «listo» solo si su host sirve
// de verdad la página del broker, y descarta lo que no lleve SU origen como
// destino, igual que el navegador).
//
//   node tests/broker-origenes.mjs
//
// Por qué existe:
//   · El broker aceptaba todo *.utopiaia.com. Con el cambio a elffuss.com tiene
//     que aceptar las webs de Elffuss de los DOS dominios y nada más.
//   · Un modelo de Hugging Face embebía huggingface.co como si fuera el broker:
//     nadie contestaba y cada sesión se comía 8 s de espera.
//   · sharedUsage()/clearShared() usaban un `_iframe` que no existe y llamaban a
//     origin() sin argumento: el panel nunca sabía cuánto ocupa el almacén.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
let fallos = 0;
const ok = (nombre, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${nombre}${extra ? '  — ' + extra : ''}`);
  if (!cond) fallos++;
};

// ── 1. La lista de orígenes del broker (las dos copias de la página) ─────────
const ACEPTA = [
  'https://elffuss.com', 'https://claw.elffuss.com', 'https://code.elffuss.com',
  'https://translator.elffuss.com', 'https://copilot.elffuss.com', 'https://t2t.elffuss.com',
  'https://models.elffuss.com', 'https://m1.elffuss.com', 'https://m2.elffuss.com',
  'https://elffuss.utopiaia.com', 'https://claw.elffuss.utopiaia.com', 'https://code.elffuss.utopiaia.com',
  'https://copilot.elffuss.utopiaia.com', 'https://translator.elffuss.utopiaia.com', 'https://t2t.elffuss.utopiaia.com',
  'https://models.elffuss.utopiaia.com', 'https://m1.elffuss.utopiaia.com',
  'https://elffuss-claw.utopiaia.com', 'https://elffuss-code.utopiaia.com',
  // Burn My Computer sigue embebiendo la caché compartida (commit 2125fb0). La
  // copia de broker/ no lo aceptaba y la de server/ sí, y esta prueba no lo veía
  // porque el origen no estaba en ninguna de las dos listas.
  'https://burn-my-computer.utopiaia.com',
  // Las herramientas de elffuss-ai (solo con permiso de lectura: tests/broker-herramientas.mjs)
  'https://tools.elffuss.com', 'https://cutout.elffuss.com', 'https://ocr.elffuss.com',
  'https://detect.elffuss.com', 'https://depth.elffuss.com',
  'http://localhost', 'http://localhost:8642',
  'https://socio.example',                       // añadido por ?allow=
];
const RECHAZA = [
  'https://utopiaia.com', 'https://otra.utopiaia.com', 'https://bitacora.utopiaia.com',
  'https://evilelffuss.com', 'https://evil-elffuss.utopiaia.com', 'https://elffuss.com.evil.net',
  'https://claw.elffuss.com.evil.net', 'https://elffuss-claw.utopiaia.com.evil.net',
  'https://x.elffuss-claw.utopiaia.com', 'http://claw.elffuss.com', 'http://127.0.0.1:8642',
  'https://otro.example', 'null',
  // Hosts de Elffuss que no embeben el broker: git.* pinta markdown de cualquiera
  // y key.* no lo necesita. Tampoco nombres que no existen ni anidados.
  'https://git.elffuss.com', 'https://git.elffuss.utopiaia.com',
  'https://key.elffuss.com', 'https://key.elffuss.utopiaia.com',
  'https://www.elffuss.com', 'https://otra.elffuss.com', 'https://x.claw.elffuss.com',
  'https://models.git.elffuss.com', 'https://mx.elffuss.com',
  'https://burn-my-computer.utopiaia.com.evil.net', 'http://burn-my-computer.utopiaia.com',
  'https://x.burn-my-computer.utopiaia.com',
  // Las herramientas solo existen bajo elffuss.com, con https y con su nombre exacto.
  'https://ocr.elffuss.utopiaia.com', 'https://tools.elffuss.utopiaia.com',
  'http://ocr.elffuss.com', 'https://ocr.elffuss.com.evil.net', 'https://x.ocr.elffuss.com',
  'https://ocr2.elffuss.com', 'https://cutouts.elffuss.com', 'https://depth.elffuss.com:8443',
];
const veredictos = {};   // página → { origen: acepta? }
const codigos = {};      // página → el código de allowed() sin comentarios ni espacios
// Sin comentarios ni espacios: lo que cuenta es el código. (Un // detrás de «:»
// es una URL y una barra escapada es parte de una regex: eso no se quita.)
const soloCodigo = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"])\/\/.*$/gm, '$1').replace(/\s+/g, '');
for (const pagina of ['server/broker/index.html', 'broker/index.html']) {
  const html = readFileSync(join(RAIZ, pagina), 'utf8');
  const ini = html.indexOf('const extra =');
  const fin = html.indexOf('\n}\n', html.indexOf('function allowed(origin)'));
  if (ini < 0 || fin < 0) { ok(`${pagina}: se encuentra allowed()`, false); continue; }
  codigos[pagina] = soloCodigo(html.slice(ini, fin + 2));
  const allowed = new Function('location', html.slice(ini, fin + 2) + '\nreturn allowed;')(
    { search: '?allow=https://socio.example' });
  const malAceptados = RECHAZA.filter(o => allowed(o));
  const malRechazados = ACEPTA.filter(o => !allowed(o));
  ok(`${pagina}: acepta las webs de Elffuss de los dos dominios`, !malRechazados.length, malRechazados.join(' '));
  ok(`${pagina}: no acepta git, key, el resto de utopiaia.com ni imitaciones`, !malAceptados.length, malAceptados.join(' '));
  veredictos[pagina] = Object.fromEntries([...ACEPTA, ...RECHAZA].map(o => [o, allowed(o)]));
}
// Las dos copias tienen que decir LO MISMO de cada origen de las listas de
// arriba. Eso solo mira esos orígenes: una regla nueva en una sola copia, para
// un origen que no está en ninguna lista, pasaba sin que nadie lo viera (lo
// demostró un mutante: `https://foo.utopiaia.com` aceptado solo en broker/).
// Por eso, además, el CÓDIGO de allowed() tiene que ser el mismo en las dos,
// comentarios y espacios aparte.
{
  const [a, b] = ['server/broker/index.html', 'broker/index.html'].map(p => veredictos[p] || {});
  const distintos = Object.keys(a).filter(o => a[o] !== b[o]);
  ok('las dos copias del broker aceptan exactamente los mismos orígenes de las listas', Object.keys(a).length > 0 && !distintos.length,
    distintos.map(o => `${o} (server/: ${a[o]}, broker/: ${b[o]})`).join(' '));
  const [ca, cb] = ['server/broker/index.html', 'broker/index.html'].map(p => codigos[p] || '');
  let i = 0; while (i < ca.length && ca[i] === cb[i]) i++;
  ok('…y el código de allowed() es el mismo en las dos copias (comentarios aparte)', !!ca && ca === cb,
    ca === cb ? '' : `difieren desde «${ca.slice(i, i + 50)}» / «${cb.slice(i, i + 50)}»`);
}

// ── 2. Un `document` de mentira para el SDK del broker ───────────────────────
const bus = new EventTarget();
globalThis.addEventListener = (t, h) => bus.addEventListener(t, h);
globalThis.removeEventListener = (t, h) => bus.removeEventListener(t, h);
const entregar = (data, source) => bus.dispatchEvent(Object.assign(new Event('message'), { data, source }));
const SIRVE_BROKER = /^https:\/\/(models|m\d+)\.elffuss\.(com|utopiaia\.com)\/$/;
const iframes = [];
const RESPUESTA = {
  'elffuss-model-get': () => ({ kind: 'file', file: { size: 42 } }),
  'elffuss-model-has': () => ({ kind: 'has', cached: true, size: 42 }),
  'elffuss-broker-diag': () => ({ kind: 'diag', usado: 7200, quota: 20000 }),
  'elffuss-model-clear': () => ({ kind: 'cleared', liberado: 7200, restante: 0 }),
};
globalThis.document = {
  createElement() {
    const el = { src: '', style: {}, enviados: [], setAttribute() {}, addEventListener() {} };
    el.contentWindow = {
      postMessage(msg, destino) {
        el.enviados.push({ msg, destino });
        // El navegador descarta en silencio lo que no va al origen de la ventana.
        if (destino !== new URL(el.src).origin) return;
        const r = RESPUESTA[msg.type]?.();
        if (r) setTimeout(() => entregar({ id: msg.id, ...r }, el.contentWindow), 0);
      },
    };
    return el;
  },
  body: {
    appendChild(el) {
      iframes.push(el);
      if (SIRVE_BROKER.test(el.src)) setTimeout(() => entregar({ kind: 'elffuss-broker-ready' }, el.contentWindow), 0);
    },
  },
};
const embebidos = () => iframes.map(f => f.src);

const mb = await import('../web/js/runtime/model-broker.js');
const BROKER = 'https://models.elffuss.com/';
ok('el broker por defecto es models.elffuss.com', mb.BROKER_URL === BROKER, mb.BROKER_URL);

// ── 3. A qué broker va cada fichero ──────────────────────────────────────────
const CASOS = [
  ['https://huggingface.co/litert-community/x/resolve/main/m.litertlm', BROKER],
  ['https://m1.elffuss.com/bonsai-27b.p0', 'https://m1.elffuss.com/'],
  ['https://m2.elffuss.utopiaia.com/bonsai-27b.p1', 'https://m2.elffuss.utopiaia.com/'],
  ['https://models.elffuss.com/x.onnx', BROKER],
  ['https://claw.elffuss.com/models/qwen38-27b.gguf', BROKER],   // claw sirve la app, no el broker
  ['http://m1.elffuss.com/x', BROKER],
  ['https://m1.elffuss.com.evil.net/x', BROKER],
];
if (typeof mb.brokerFor !== 'function') ok('existe brokerFor()', false);
else {
  for (const [url, esperado] of CASOS) {
    const r = mb.brokerFor(url);
    ok(`brokerFor(${new URL(url).origin})`, r === esperado, r);
  }
  let lanzo = false;
  try { mb.brokerFor('models/x.gguf'); } catch { lanzo = true; }
  ok('una URL relativa lanza en vez de ir a un broker que la resolvería mal', lanzo);
}

// ── 4. Un modelo de Hugging Face no embebe huggingface.co ────────────────────
// Por el camino real: model-store.getModelParts, que es quien lo pide.
{
  const store = await import('../web/js/runtime/model-store.js');
  const t0 = Date.now();
  const partes = await Promise.race([
    store.getModelParts('https://huggingface.co/litert-community/x/resolve/main/m.litertlm'),
    new Promise(r => setTimeout(() => r('timeout'), 3000)),
  ]);
  ok('getModelParts(Hugging Face) sale del broker compartido', Array.isArray(partes) && partes[0]?.size === 42,
    `${typeof partes === 'string' ? partes : 'ok'} en ${Date.now() - t0} ms`);
  ok('  y no embebe huggingface.co', !embebidos().some(s => s.includes('huggingface.co')), embebidos().join(' '));
  const enviado = iframes.find(f => f.src === BROKER)?.enviados.at(-1);
  ok('  la petición va con models.elffuss.com como destino', enviado?.destino === 'https://models.elffuss.com', enviado?.destino);
}
{
  const f = await mb.getSharedModel('https://m1.elffuss.com/bonsai-27b.p0');
  ok('un fragmento de m1 lo guarda el broker de m1', f?.size === 42 && embebidos().includes('https://m1.elffuss.com/'));
  ok('isSharedCached(Hugging Face) pregunta al compartido', await mb.isSharedCached('https://huggingface.co/a/b'));
}

// ── 5. Lo que ocupa el almacén compartido, y vaciarlo ────────────────────────
// Solo existen en el árbol que los trae; en uno sin ellos no hay nada que probar.
if (typeof mb.sharedUsage !== 'function' || typeof mb.clearShared !== 'function') {
  console.log('— sharedUsage()/clearShared() no están en este árbol: se saltan');
} else {
  const uso = await mb.sharedUsage().catch(e => ({ error: e.message }));
  ok('sharedUsage() devuelve lo que dice el broker', uso.ok === true && uso.usage === 7200 && uso.quota === 20000, JSON.stringify(uso));
  const vac = await mb.clearShared().catch(e => ({ error: e.message }));
  ok('clearShared() devuelve lo liberado', vac.ok === true && vac.liberado === 7200, JSON.stringify(vac));
  const destinos = (iframes.find(f => f.src === BROKER)?.enviados || [])
    .filter(e => e.msg.type === 'elffuss-broker-diag' || e.msg.type === 'elffuss-model-clear').map(e => e.destino);
  ok('  las dos van al origen del broker', destinos.length === 2 && destinos.every(d => d === 'https://models.elffuss.com'), destinos.join(' '));
}

// ── 6. El Translator, del dominio nuevo y del anterior ───────────────────────
// kernel.js no se puede importar fuera del navegador: se lee la lista del fuente.
{
  const src = readFileSync(join(RAIZ, 'web/js/kernel.js'), 'utf8');
  const m = src.match(/const ALLOWED = (\[[^\]]*\]);/);
  const lista = m ? JSON.parse(m[1].replace(/'/g, '"')) : [];
  ok('kernel: acepta el Translator en elffuss.com y en el host anterior',
    lista.includes('https://translator.elffuss.com') && lista.includes('https://translator.elffuss.utopiaia.com') && lista.length === 2,
    lista.join(' '));
  ok('kernel: comprueba el origen contra la lista y contesta al que habló',
    src.includes('if (!ALLOWED.includes(e.origin)) return;') && src.includes('window.__copilotOpener = e.origin;'));
}

console.log(fallos ? `\n❌ ${fallos} fallo(s)` : '\n✅ orígenes y brokers OK');
process.exit(fallos ? 1 : 0);
