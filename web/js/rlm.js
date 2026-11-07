// RLM — Recursive Language Models (el modo «Hard Work» de Elffuss).
//
// Idea (Zhang et al., MIT, 2025): un modelo PEQUEÑO y local puede manejar
// entradas ENORMES si no las mete todas de golpe en su ventana, sino que
// TROCEA el material, pregunta a cada trozo (map = una sub-llamada al mismo
// modelo) y FUNDE las respuestas (reduce). Si lo fundido aún no cabe, se
// recurre. El modelo raíz nunca ve todo el contexto a la vez: trabaja por
// partes, como un humano leyendo un tocho capítulo a capítulo.
//
// Trade-off honesto: cambia LATENCIA por CAPACIDAD. Son muchas inferencias del
// modelo local (que es lento), así que es para tareas que PUEDEN esperar —
// auditar, resumir o revisar una carpeta/repo entero— no para tiempo real.
//
// El motor es agnóstico del proveedor: solo necesita algo con
// `chat(history, system, onToken)` (lo cumplen rules/onnx/litert/api).
//
// PARAR: hardWork() y deepCreate() aceptan `signal` (un AbortSignal). Viaja a
// cada llamada al modelo como 4º argumento de chat() —que es donde se va casi
// todo el tiempo— y además se comprueba ENTRE llamadas: entre trozos, grupos,
// tramos de continuación, candidatos y rondas. Al parar se lanza un error con
// name 'AbortError', que quien llama trata como parada y no como fallo. Sin
// señal, todo es exactamente igual que antes.
//
// Y una regla para cualquiera que llame a chat(): quien DEJA DE ESPERAR una
// llamada tiene que abortarla. Una llamada abandonada sigue ocupando el motor,
// y el motor propio atiende los turnos de uno en uno (ver sub()).

const CHARS_PER_TOK = 4; // misma estimación que context.js
const DEFAULTS = {
  chunkTokens: 1800,     // tamaño de cada trozo (deja hueco al prompt del modelo)
  overlapTokens: 120,    // solape para no cortar una idea a la mitad entre trozos
  maxDepth: 3,           // recursión máxima del reduce jerárquico
  maxChunks: 80,         // techo DURO de sub-llamadas del map (coste/tiempo)
  callTimeoutMs: 120000, // guarda por sub-llamada (un motor colgado no bloquea todo)
};

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

function siParado(signal) {
  if (!signal?.aborted) return;
  const e = new Error('Hard Work parado');
  e.name = 'AbortError';
  throw e;
}

// Trocea respetando límites de línea cuando es posible (no parte a mitad de
// palabra si hay un salto cerca del corte).
function chunk(text, chunkChars, overlapChars) {
  const step = Math.max(1, chunkChars - overlapChars);
  const out = [];
  for (let i = 0; i < text.length; i += step) {
    let end = Math.min(i + chunkChars, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > i + chunkChars * 0.6) end = nl; // corta en salto si cae en el último 40%
    }
    out.push(text.slice(i, end));
    if (end >= text.length) break;
  }
  return out;
}

// sub(): UNA inferencia del modelo local sobre un fragmento. Es la recursión.
// Cada sub-llamada lleva SU parada, enlazada a la de fuera, y no sobrevive a
// sub(): si salta la guarda de tiempo, la llamada se ABORTA en vez de quedarse
// abandonada y viva. Abandonada, un motor que atiende los turnos de uno en uno
// (el propio) la seguía generando, y la llamada del trozo siguiente esperaba
// detrás con su reloj ya en marcha: un solo trozo lento hacía caducar a los de
// después en la cola, Hard Work acababa en «no encontré nada» y el motor seguía
// ocupado con turnos que nadie iba a leer, retrasando el siguiente mensaje.
// `provider` es el proveedor, o una función con la forma de su `chat` (la de un
// hilo, ver `abreHilos`).
async function sub(provider, system, prompt, timeoutMs, signal = null) {
  siParado(signal);
  const ctl = new AbortController();
  const enlazar = () => ctl.abort();
  signal?.addEventListener?.('abort', enlazar, { once: true });
  let to;
  try {
    const llama = typeof provider === 'function' ? provider : (h, s, cb, sig) => provider.chat(h, s, cb, sig);
    const run = llama([{ role: 'user', content: prompt }], system, () => {}, ctl.signal);
    if (!timeoutMs) { const r = await run; siParado(signal); return r; }
    Promise.resolve(run).catch(() => {});   // si gana la guarda, el rechazo de la llamada abortada no queda suelto
    const guard = new Promise((_, rej) => { to = setTimeout(() => rej(new Error('sub-llamada agotó el tiempo')), timeoutMs); });
    const r = await Promise.race([run, guard]);
    siParado(signal);
    return r;
  } finally {
    clearTimeout(to);
    signal?.removeEventListener?.('abort', enlazar);
    ctl.abort();   // terminada no le hace nada; colgada tras la guarda, la para
  }
}

// HILOS: con el motor propio en la tarjeta (`abreHilo`), varias sub-llamadas
// escriben a la vez: un paso para varias conversaciones cuesta poco más que para
// una, y las que llevan el mismo sistema lo leen una sola vez. Con cualquier otro
// proveedor (remoto, la CPU, un motor sin hilos) devuelve null y todo va en serie,
// como siempre. `con(fn)` presta un hilo libre a `fn` (o espera a que lo haya).
async function abreHilos(provider) {
  if (typeof provider?.abreHilo !== 'function') return null;
  const n = provider.hilosRecomendados?.() || 0;
  if (n < 2) return null;
  const hs = [];
  for (let i = 0; i < n; i++) { try { hs.push(await provider.abreHilo({ contextLen: 4096 })); } catch { break; } }
  if (hs.length < 2) { hs.forEach((h) => h.close()); return null; }
  const libres = [...hs], esperan = [];
  return {
    n: hs.length,
    async con(fn) {
      const h = libres.pop() || await new Promise((r) => esperan.push(r));
      try { return await fn((hi, s, cb, sig) => h.chat(hi, s, cb, { signal: sig })); }
      finally { const w = esperan.shift(); if (w) w(h); else libres.push(h); }
    },
    cerrar() { hs.forEach((h) => h.close()); },
  };
}

// Cada elemento con `fn(elemento, índice, llama)`: en paralelo sobre los hilos si
// los hay, si no en serie con el proveedor. Devuelve los resultados en orden.
async function cadaUno(items, hilos, provider, fn) {
  if (!hilos) { const r = []; for (let i = 0; i < items.length; i++) r.push(await fn(items[i], i, provider)); return r; }
  return Promise.all(items.map((x, i) => hilos.con((llama) => fn(x, i, llama))));
}

const MAP_SYS = 'Eres un analista minucioso. Te doy UN fragmento de un material más grande y una pregunta. Responde SOLO con lo que ESTE fragmento aporte a la pregunta: datos concretos, en pocas frases, con cita textual breve si procede. No inventes lo que no esté en el fragmento. Si el fragmento no aporta nada a la pregunta, responde exactamente: NADA';
const REDUCE_SYS = 'Eres un sintetizador. Te doy una pregunta y varios hallazgos extraídos de fragmentos distintos del MISMO material. Fúndelos en una única respuesta, coherente y completa, a la pregunta. Resuelve solapes, no repitas, no inventes lo que no esté en los hallazgos. Responde en el idioma de la pregunta.';

// Motor RLM. Devuelve { answer, chunks, kept }.
export async function hardWork({ question, context, provider, onProgress = () => {}, opts = {}, signal = null }) {
  const o = { ...DEFAULTS, ...opts };
  if (!provider || typeof provider.chat !== 'function') throw new Error('Hard Work necesita un cerebro cargado (elige un modelo local o remoto arriba).');
  const q = String(question || '').trim();
  const ctx = String(context || '').trim();
  if (!q) throw new Error('Hard Work: dime qué quieres saber del material.');
  if (!ctx) throw new Error('Hard Work: no encontré material que procesar.');

  const chunkChars = o.chunkTokens * CHARS_PER_TOK;
  let parts = chunk(ctx, chunkChars, o.overlapTokens * CHARS_PER_TOK);
  const truncated = parts.length > o.maxChunks;
  if (truncated) parts = parts.slice(0, o.maxChunks);
  onProgress({ phase: 'plan', chunks: parts.length, chars: ctx.length, truncated });

  // MAP — con hilos, varios trozos a la vez en la tarjeta; sin ellos, en serie.
  const hilos = await abreHilos(provider);
  try {
    let empezados = 0;
    const respuestas = await cadaUno(parts, hilos, provider, async (part, i, llama) => {
      siParado(signal);
      onProgress({ phase: 'map', i: ++empezados, n: parts.length });
      let ans;
      try { ans = await sub(llama, MAP_SYS, `PREGUNTA:\n${q}\n\nFRAGMENTO ${i + 1}/${parts.length}:\n${part}`, o.callTimeoutMs, signal); }
      catch (e) {
        // Un trozo que falla no tumba el resto; parar, sí. También cuando la
        // parada viene del proveedor (AbortError sin que `signal` se abortara: el
        // motor propio corta así su turno al descargarse). Seguir pidiendo trozos
        // a un modelo descargado solo acumularía «no está cargado» hasta acabar
        // en «no encontré nada».
        siParado(signal);
        if (e?.name === 'AbortError') throw e;
        ans = 'NADA';
      }
      return String(ans || '').trim();
    });
    const findings = [];
    respuestas.forEach((ans, i) => { if (ans && !/^NADA\b/i.test(ans)) findings.push(`[${i + 1}] ${ans}`); });
    onProgress({ phase: 'mapped', kept: findings.length, of: parts.length });
    if (!findings.length) return { answer: 'Revisé el material por partes y no encontré nada relevante para eso.', chunks: parts.length, kept: 0, truncated };

    const answer = await reduce(provider, q, findings, o, onProgress, 0, signal, hilos);
    return { answer: String(answer || '').trim(), chunks: parts.length, kept: findings.length, truncated };
  } finally { hilos?.cerrar(); }
}

// REDUCE jerárquico: si los hallazgos caben, funde en uno; si no, agrupa,
// funde cada grupo y recurre con las respuestas parciales.
async function reduce(provider, q, findings, o, onProgress, depth, signal = null, hilos = null) {
  siParado(signal);
  const budget = o.chunkTokens * CHARS_PER_TOK * 2; // el reduce puede ver algo más que un trozo
  const joined = findings.join('\n');
  if (joined.length <= budget || depth >= o.maxDepth) {
    onProgress({ phase: 'reduce', depth, final: true });
    return sub(provider, REDUCE_SYS, `PREGUNTA:\n${q}\n\nHALLAZGOS:\n${clip(joined, budget)}`, o.callTimeoutMs, signal);
  }
  const groups = [];
  let cur = [];
  let len = 0;
  for (const f of findings) {
    if (len + f.length + 1 > budget && cur.length) { groups.push(cur); cur = []; len = 0; }
    cur.push(f); len += f.length + 1;
  }
  if (cur.length) groups.push(cur);
  onProgress({ phase: 'reduce', depth, groups: groups.length, final: false });
  // Los grupos de un mismo nivel no se ven entre sí: con hilos, a la vez.
  const partials = await cadaUno(groups, hilos, provider, async (grupo, g, llama) => {
    siParado(signal);
    onProgress({ phase: 'reduce-group', depth, g: g + 1, n: groups.length });
    const p = await sub(llama, REDUCE_SYS, `PREGUNTA:\n${q}\n\nHALLAZGOS (grupo ${g + 1}/${groups.length}):\n${grupo.join('\n')}`, o.callTimeoutMs, signal);
    return `[g${g + 1}] ${String(p || '').trim()}`;
  });
  return reduce(provider, q, partials, o, onProgress, depth + 1, signal, hilos);
}

// ── Hard Work · CREACIÓN: borrador → autocrítica → reescritura ──────────────
// El hermano creativo de RLM. RLM gasta cómputo LEYENDO material enorme; esto
// lo gasta MEJORANDO lo que el modelo crea: en vez de una sola pasada, el
// modelo pequeño hace un borrador, se autocritica sin piedad y se reescribe
// corrigiendo sus propios fallos. Sube la calidad de un modelo modesto sin
// cambiar de modelo — solo pensando más veces.
const CREATE_SYS = 'Eres Elffuss creando una app web. Respondes SOLO con un documento HTML completo y autocontenido (CSS y JS inline, fondo oscuro). Si es un juego o algo visual, usa <canvas> y que se vea vivo (color, movimiento, efectos). Nada de texto fuera del HTML.';
const CRITIQUE_SYS = 'Eres un crítico de videojuegos y front-end, implacable pero útil. Te doy el código de una app/juego web. Enumera 3 a 6 defectos CONCRETOS y accionables: bugs de lógica, controles que faltan, colisiones mal hechas, falta de condición de fin o de puntuación, jugabilidad sosa y pobreza visual (sin color, sin efectos, estático). Sé específico y breve. NO reescribas el código: solo la lista de defectos.';
const REWRITE_SYS = 'Eres Elffuss mejorando tu propia app. Te doy el HTML actual y una crítica. Devuelve SOLO el HTML completo y autocontenido MEJORADO que corrige TODOS los puntos de la crítica, conservando lo que ya funcionaba y subiendo el nivel visual (color, brillo, partículas si encaja). Sin explicaciones fuera del HTML.';

// Saca el documento HTML de la respuesta del modelo (fence ```html o directo).
export function extractHtml(text) {
  const s = String(text || '');
  const fence = s.match(/```html\s*([\s\S]*?)```/i) || s.match(/```\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : s;
  const m = body.match(/<!doctype[\s\S]*<\/html>/i) || body.match(/<html[\s\S]*<\/html>/i);
  return (m ? m[0] : body).trim();
}

const CONT_SYS = 'Continúas un documento HTML/JS que se cortó a media escritura. Devuelve SOLO la continuación EXACTA desde donde termina —sin repetir nada de lo ya escrito, sin reabrir <html> ni <script>, sin explicaciones— hasta cerrar todas las etiquetas y </html>.';

// Genera y, si el modelo se quedó sin tokens a media escritura (el HTML no
// cierra </html>), pide la continuación desde la cola y la cose. Así el techo
// de 1024 tokens deja de truncar apps grandes: se completan por tramos.
async function genComplete(provider, system, prompt, { maxCont = 4, signal = null } = {}) {
  siParado(signal);
  let full = String(await provider.chat([{ role: 'user', content: prompt }], system, () => {}, signal) || '');
  for (let i = 0; i < maxCont && !/<\/html>/i.test(full); i++) {
    siParado(signal);
    const tail = full.slice(-1400);
    let cont = String(await provider.chat(
      [{ role: 'user', content: `FINAL de lo escrito hasta ahora (continúa desde aquí, sin repetirlo):\n${tail}` }],
      CONT_SYS, () => {}, signal) || '');
    // Defensa: si el modelo reabre el documento en vez de continuar, recórtalo.
    cont = cont.replace(/^[\s\S]*?<!doctype html>/i, '').replace(/^[\s\S]*?<html[^>]*>/i, '');
    if (!cont.trim()) break;
    full += cont;
  }
  siParado(signal);
  return full;
}


// ── Jurado deliberante (Reasoning Jury, arXiv 2608.12585) ───────────────────
// Un juez único detecta mal los defectos: se inventa unos y se le escapan
// otros (lo vimos con el crítico único de Hard Work). El paper sustituye al
// juez por un JURADO que delibera: cada jurado propone defectos, luego ve los
// de los demás y VOTA cuáles son reales, y un moderador se queda con los que
// tienen apoyo. Aquí el jurado es un mismo modelo con lentes distintas —no
// modelos distintos, que no caben en el navegador—, así que el efecto es
// menor que en el paper; por eso se mide, no se asume.
const JURY_LENSES = [
  { key: 'logica', name: 'lógica', ask: 'errores de lógica y de estado: variables sin definir, condiciones al revés, bucles que no avanzan, una condición de fin que nunca se cumple, cuentas mal hechas' },
  { key: 'interaccion', name: 'interacción', ask: 'controles y respuesta: entradas que no hacen nada, colisiones que no detectan, falta de arranque o de reinicio, nada que indique al usuario qué pasa' },
  { key: 'visual', name: 'presentación', ask: 'lo que se ve: elementos con tamaño cero o fuera de pantalla, todo del mismo color, nada dibujado, texto ilegible' },
];

const asLines = t => String(t || '').split('\n')
  .map(l => l.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s*/, '').trim())
  .filter(l => l.length > 12 && l.length < 220);

const normDefect = d => d.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3).slice(0, 6).join(' ');

// Devuelve { defects:[{text,votes,jurors}], rounds } sobre un artefacto.
// Normaliza espacios para comparar una cita con el código real.
const flat = t => String(t).replace(/\s+/g, ' ').trim();

// Elige las lentes que TIENEN algo que mirar en este artefacto. Pasarle
// «presentación» a una función pura de cálculo no aporta nada: ese jurado o
// calla o repite lo que dijo el de lógica, y los repetidos se comían las
// plazas de candidatos.
function lensesFor(material) {
  const tieneUI = /<canvas|<button|<input|<form|document\.|addEventListener|innerHTML|querySelector/i.test(material);
  const tienePintado = /<canvas|getContext|fillRect|drawImage|style\.|css/i.test(material);
  const out = [JURY_LENSES[0]];                                  // lógica: siempre
  if (tieneUI) out.push(JURY_LENSES[1]);                         // interacción
  if (tienePintado) out.push(JURY_LENSES[2]);                    // presentación
  if (out.length === 1) out.push(JURY_LENSES_EXTRA[0], JURY_LENSES_EXTRA[1]);  // código puro
  else if (out.length === 2) out.push(JURY_LENSES_EXTRA[0]);
  return out;
}

// Lentes para código sin interfaz, donde «interacción» y «presentación» no pintan nada.
const JURY_LENSES_EXTRA = [
  { key: 'datos', name: 'datos y tipos', ask: 'tipos y datos: conversiones implícitas, valores que llegan como texto cuando se esperan números, undefined/NaN, claves que cambian de tipo' },
  { key: 'bordes', name: 'casos límite', ask: 'casos límite y validación: entradas vacías, negativas o fuera de rango, ausencia de comprobaciones, resultados absurdos que nadie detiene' },
];

export async function juryReview({ artifact, provider, onProgress = () => {}, lenses = null, requireEvidence = true, signal = null }) {
  const dropped = [];
  if (!provider?.chat) throw new Error('el jurado necesita un cerebro cargado');
  const material = String(artifact || '').slice(0, 6000);
  lenses = lenses || lensesFor(material);
  onProgress({ phase: 'jury-lenses', lenses: lenses.map(l => l.name) });

  // Ronda 1 — cada jurado propone defectos desde SU lente, sin ver a los demás.
  const proposals = [];
  for (const L of lenses) {
    siParado(signal);
    onProgress({ phase: 'jury-propose', lens: L.name });
    const sys = `Eres un revisor especializado en ${L.ask}. Te doy el código de una app web. Enumera SOLO los defectos REALES que veas desde tu especialidad. Por cada uno escribe DOS líneas seguidas:
DEFECTO: <qué está mal, en una línea>
PRUEBA: <copia LITERAL del fragmento de código que lo demuestra, tal cual aparece>
Máximo 4 defectos. Si no ves ninguno, escribe NINGUNO. La PRUEBA debe estar copiada del código palabra por palabra; si no puedes copiarla, no incluyas ese defecto.`;
    const out = await provider.chat([{ role: 'user', content: 'CÓDIGO:\n' + material }], sys, () => {}, signal);
    // Emparejar DEFECTO con su PRUEBA y COMPROBAR que la cita existe de verdad
    // en el código. Es un filtro determinista: si el modelo no sabe citar, se
    // lo ha inventado. (El modelo verifica mucho mejor de lo que propone, pero
    // esto ni siquiera necesita al modelo.)
    const raw = String(out).split('\n').map(x => x.trim());
    const found = [];
    for (let i = 0; i < raw.length; i++) {
      const dm = raw[i].match(/^DEFECTO:\s*(.+)/i);
      if (!dm) continue;
      const pm = (raw[i + 1] || '').match(/^PRUEBA:\s*(.+)/i);
      const texto = dm[1].trim();
      if (texto.length < 12) continue;
      if (!requireEvidence) { found.push({ texto, cita: pm ? pm[1].trim() : '' }); continue; }
      const cita = pm ? pm[1].trim().replace(/^[`'"]|[`'"]$/g, '') : '';
      if (cita.length >= 8 && flat(material).includes(flat(cita))) found.push({ texto, cita });
      else dropped.push({ lens: L.name, texto, cita: cita.slice(0, 60) });
    }
    proposals.push({ lens: L, found });
  }

  // Candidatos únicos (los jurados repiten el mismo defecto con otras palabras).
  // Deduplicar por la CITA de código, no por las palabras: dos jurados describen
  // el mismo fallo con frases distintas («el bucle empieza en 1» y «ignora el
  // primer elemento») y el deduplicador léxico los dejaba pasar como dos, con lo
  // que la lista de candidatos se llenaba de repetidos. Si señalan el mismo
  // fragmento de código, es el mismo defecto.
  const seen = new Map();
  for (const p of proposals) for (const d of p.found) {
    const k = d.cita && d.cita.length >= 8 ? 'c:' + flat(d.cita).slice(0, 80) : 't:' + normDefect(d.texto);
    if (k && !seen.has(k)) seen.set(k, d.texto);
  }
  const candidates = [...seen.values()].slice(0, 12);
  onProgress({ phase: 'jury-candidates', n: candidates.length });
  if (!candidates.length) return { defects: [], candidates: 0, dropped };

  // Ronda 2 — DELIBERACIÓN: cada jurado ve TODOS los candidatos (incluidos los
  // ajenos) y vota cuáles son de verdad. Aquí es donde puede retirar el suyo.
  const votes = candidates.map(() => 0);
  for (const L of lenses) {
    siParado(signal);
    onProgress({ phase: 'jury-vote', lens: L.name });
    const list = candidates.map((c, i) => `${i + 1}. ${c}`).join('\n');
    // OJO con el formato: poner "N: SI" como plantilla hacía que el modelo
    // escribiera literalmente la letra N y no se parseara NINGÚN voto (el
    // jurado parecía rechazarlo todo). Los modelos pequeños copian el ejemplo
    // tal cual: hay que darles números de verdad.
    const sys = `Eres un revisor riguroso (especialidad: ${L.name}). Te doy el código y una lista numerada de defectos propuestos por otros revisores. Para CADA número, mira el código y di si el defecto es REAL. Responde SOLO con una línea por defecto, con su número y SI o NO. Así:
1: SI
2: NO
3: SI
Nada más: ni explicaciones ni texto extra. Ante la duda, NO.`;
    const out = await provider.chat(
      [{ role: 'user', content: 'CÓDIGO:\n' + material + '\n\nDEFECTOS PROPUESTOS:\n' + list }], sys, () => {}, signal);
    const txt = String(out);
    let parsed = 0;
    for (const m of txt.matchAll(/(\d+)\s*[:.)\-]\s*(S[IÍ]|YES|NO)\b/gi)) {
      const i = +m[1] - 1;
      parsed++;
      if (i >= 0 && i < votes.length && /^(s[ií]|yes)$/i.test(m[2])) votes[i]++;
    }
    // Respaldo: si el modelo ignoró el formato numerado, leer los SI/NO en orden.
    if (!parsed) {
      const seq = [...txt.matchAll(/\b(S[IÍ]|YES|NO)\b/gi)].map(m => m[1]);
      seq.slice(0, votes.length).forEach((v, i) => { if (/^(s[ií]|yes)$/i.test(v)) votes[i]++; });
    }
    onProgress({ phase: 'jury-parsed', lens: L.name, parsed });
  }

  siParado(signal);
  // Moderador — se queda con los que tienen apoyo de la mayoría del jurado.
  const need = Math.ceil(lenses.length / 2);
  const defects = candidates.map((text, i) => ({ text, votes: votes[i] }))
    .filter(d => d.votes >= need)
    .sort((a, b) => b.votes - a.votes);
  onProgress({ phase: 'jury-verdict', kept: defects.length, of: candidates.length });
  onProgress({ phase: 'jury-evidence', dropped: dropped.length });
  return { defects, candidates: candidates.length, jurors: lenses.length, dropped };
}


// ── Edición QUIRÚRGICA en vez de reescritura completa ───────────────────────
// Reescribir el documento entero para corregir tres cosas hace que el modelo
// regenere de cero lo que ya funcionaba, y por el camino rompe la mecánica.
// Aquí solo se le piden los CAMBIOS, y los aplica este código: si el fragmento
// a buscar no está tal cual en el documento, ese cambio se descarta. El modelo
// propone, el código decide — igual que con las citas del jurado.
const PATCH_SYS = `Eres Elffuss arreglando tu propia app. Te doy el HTML actual y una lista de defectos COMPROBADOS ejecutandola.

Arregla ESOS defectos y nada mas. No reescribas el documento. Devuelve solo los cambios, asi:

BUSCAR
<las lineas actuales, copiadas LITERALES del HTML de arriba>
CAMBIAR
<las lineas nuevas que las sustituyen>
FIN

Puedes usar VARIAS lineas en cada parte: si hace falta anadir codigo nuevo (por ejemplo unos addEventListener de teclado), copia en BUSCAR una linea de referencia que exista y ponla en CAMBIAR seguida del codigo nuevo.

Reglas: lo de BUSCAR debe existir palabra por palabra en el HTML y aparecer una sola vez. BUSCAR y CAMBIAR nunca pueden ser iguales, eso no arregla nada. Maximo 4 parches, todos dirigidos a los defectos de la lista. No toques colores, textos ni nada que ya funcione.`;

export function applyPatches(html, respuesta) {
  const texto = String(respuesta || '');
  let out = html;
  const aplicados = [], fallidos = [];

  // Los parches se recogen en los DOS formatos. El de una línea era el único
  // que había, y con él los defectos importantes son INARREGLABLES por
  // construcción: añadir unos listeners de teclado necesita varias líneas, así
  // que el modelo solo podía hacer retoques cosméticos (medido: cambiaba el
  // verde de la serpiente mientras el defecto era que no responde a las teclas).
  const parches = [];
  // bloque multilínea:  BUSCAR \n …líneas… \n CAMBIAR \n …líneas… \n FIN
  const bloque = /^[ \t]*BUSCAR[ \t]*$\r?\n([\s\S]*?)^[ \t]*CAMBIAR[ \t]*$\r?\n([\s\S]*?)^[ \t]*FIN[ \t]*$/gim;
  for (const m of texto.matchAll(bloque))
    parches.push({ buscar: m[1].replace(/\s+$/, ''), cambiar: m[2].replace(/\s+$/, '') });
  // de una línea: BUSCAR: … / CAMBIAR: …
  const lineas = texto.split('\n').map(x => x.trim());
  for (let i = 0; i < lineas.length; i++) {
    const b = lineas[i].match(/^BUSCAR:\s*(.+)/i); if (!b) continue;
    const c = (lineas[i + 1] || '').match(/^CAMBIAR:\s*(.+)/i); if (!c) continue;
    parches.push({ buscar: b[1].trim(), cambiar: c[1].trim() });
  }

  const norm = t => t.replace(/[ \t]+/g, ' ').trim();
  for (const { buscar, cambiar } of parches) {
    if (buscar.length < 6) continue;
    // Un parche que no cambia nada se contaba como aplicado y gastaba uno de
    // los seis huecos. Medido: el modelo los emite (BUSCAR y CAMBIAR idénticos).
    if (buscar === cambiar) { fallidos.push({ buscar: buscar.slice(0, 60), motivo: 'no cambia nada' }); continue; }

    const veces = out.split(buscar).length - 1;
    if (veces === 1) { out = out.replace(buscar, cambiar); aplicados.push(buscar.slice(0, 60)); continue; }
    if (veces > 1) { fallidos.push({ buscar: buscar.slice(0, 60), veces, motivo: 'aparece varias veces' }); continue; }

    // No está literal: puede ser solo la sangría o los espacios, que es el
    // error de cita más común. Se busca por líneas normalizadas, y solo se
    // sustituye si el bloque es ÚNICO — nunca una coincidencia dudosa.
    const bl = buscar.split('\n').map(norm);
    const hl = out.split('\n'), hn = hl.map(norm);
    const donde = [];
    for (let i = 0; i + bl.length <= hn.length; i++) {
      let igual = true;
      for (let j = 0; j < bl.length; j++) if (hn[i + j] !== bl[j]) { igual = false; break; }
      if (igual) { donde.push(i); if (donde.length > 1) break; }
    }
    if (donde.length === 1) {
      hl.splice(donde[0], bl.length, ...cambiar.split('\n'));
      out = hl.join('\n');
      aplicados.push(buscar.slice(0, 60));
    } else fallidos.push({ buscar: buscar.slice(0, 60), veces: donde.length, motivo: donde.length ? 'ambiguo ignorando espacios' : 'no existe en el HTML' });
  }
  return { html: out, aplicados, fallidos };
}


// ── Evaluador OBJETIVO: ejecuta el artefacto y mide, no opina ───────────────
// fast-agent (evalstate/fast-agent) usa un LLM como evaluador y refina hasta
// una nota mínima. La idea es buena, pero preguntarle al modelo qué nota se
// pone es preguntarle a la parte que ya demostró alucinar. Aquí el artefacto
// se EJECUTA en un iframe aislado y se comprueba qué hace de verdad:
//
//   pinta      dibuja algo
//   vivo       lo que dibuja cambia solo (hay bucle)
//   responde   cambia al recibir teclas y ratón
//   arranca    no aparece ya terminado
//   completo   el documento cierra
//
// Medir esto costó descubrir que contar píxeles premiaba una pantalla de
// «GAME OVER» a toda página por encima de un juego jugable.
export async function rateArtifact(html, { ms = 2600 } = {}) {
  if (typeof document === 'undefined') return { nota: 0, detalle: {}, medible: false };
  // El iframe va SIN allow-same-origin a propósito: dentro corre código que ha
  // escrito el modelo y no debe poder tocar la página que lo aloja. Eso hace su
  // documento ilegible desde fuera, así que se le inyecta una sonda que se mide
  // a sí misma y devuelve NÚMEROS por postMessage. Nada entra; solo salen datos.
  const sonda = `<script>(function(){
    var W=window, P=function(m){try{parent.postMessage(m,'*')}catch(e){}};
    // Un juego que revienta al mover el ratón se puntuaba 5/5: la sonda medía
    // que pintaba y que cambiaba, pero era ciega a las excepciones. Se recogen
    // aquí dentro porque desde fuera el sandbox no deja verlas.
    var errores=[];
    // «responde» se medía como «el dibujo cambió tras pulsar», pero un juego que
    // anima continuamente cambia igual sin tocar nada: un juego SORDO pasaba.
    // Ahora se mira si llega a registrar algún escuchador de entrada, que es la
    // propiedad de verdad. Se puede porque la sonda entra ANTES que su código.
    var escucha = {};
    var ENTRADA = /^(keydown|keyup|keypress|mousemove|mousedown|mouseup|click|pointerdown|pointermove|touchstart|touchmove)$/;
    function espia(obj, nombre){
      if(!obj || !obj.addEventListener) return;
      var orig = obj.addEventListener;
      obj.addEventListener = function(tipo){ if(ENTRADA.test(String(tipo))) escucha[tipo]=1; return orig.apply(this, arguments); };
    }
    espia(W,'window'); espia(document,'document');
    if(W.HTMLElement && W.HTMLElement.prototype) espia(W.HTMLElement.prototype,'elementos');
    // los manejadores puestos como propiedad (onkeydown = ...) no pasan por ahí
    ['onkeydown','onkeyup','onclick','onmousemove','onmousedown'].forEach(function(k){
      [W, document].forEach(function(o){
        try{ var v; Object.defineProperty(o,k,{configurable:true,
          get:function(){return v;}, set:function(f){ if(f) escucha[k]=1; v=f; }}); }catch(e){}
      });
    });
    W.addEventListener('error',function(e){ errores.push(String((e&&e.message)||e).slice(0,120)); });
    W.addEventListener('unhandledrejection',function(e){ errores.push('promesa: '+String((e&&e.reason&&e.reason.message)||e.reason).slice(0,110)); });
    function leer(){ var c=document.querySelector('canvas'); if(!c) return null;
      var x=c.getContext('2d'); if(!x) return null;
      try{ var d=x.getImageData(0,0,c.width,c.height).data, nb=0, h=0;
        for(var i=0;i<d.length;i+=16){ if(d[i]||d[i+1]||d[i+2]) nb++;
          h=(h*31+d[i]+d[i+1]*3+d[i+2]*7)>>>0; }
        return {nb:nb,h:h,txt:(document.body.innerText||'').slice(0,400).toLowerCase(),err:errores[0]||null,nerr:errores.length,escucha:Object.keys(escucha)};
      }catch(e){ return {nb:0,h:0,txt:'',err:errores[0]||('canvas: '+e.message),nerr:errores.length+1,escucha:Object.keys(escucha)}; } }
    W.addEventListener('message',function(e){
      if(!e.data) return;
      if(e.data.__sonda){ P({__sonda:1,r:leer()}); return; }
      // Las pulsaciones hay que despacharlas DENTRO: desde fuera no cruzan el
      // sandbox, y sin esto «responde» medía simplemente que seguía animando.
      if(e.data.__tecla){ var k=e.data.__tecla;
        try{ var ev={key:k,code:k===' '?'Space':k,keyCode:k===' '?32:0,bubbles:true};
          document.dispatchEvent(new KeyboardEvent('keydown',ev));
          W.dispatchEvent(new KeyboardEvent('keydown',ev));
          var c=document.querySelector('canvas');
          if(c){ var r=c.getBoundingClientRect();
            var mv=new MouseEvent('mousemove',{clientX:r.left+r.width*0.7,clientY:r.top+r.height/2,bubbles:true});
            document.dispatchEvent(mv); c.dispatchEvent(mv);
            c.dispatchEvent(new MouseEvent('click',{bubbles:true})); }
        }catch(e2){}
      }
    });
    P({__sonda:'lista'});
  })();<\/script>`;
  const marco = document.createElement('iframe');
  marco.setAttribute('sandbox', 'allow-scripts');
  // DENTRO del viewport a propósito: fuera de pantalla Chrome estrangula
  // requestAnimationFrame y el juego no anima, así que se medía como muerto un
  // juego que funciona. Invisible por opacidad, no por posición.
  marco.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:600px;border:0;' +
    'opacity:.01;pointer-events:none;z-index:-1';
  const doc = String(html || '');
  // La sonda va lo ANTES posible: puesta antes de </body> se registraba después
  // de que el artefacto ya hubiera corrido, así que era ciega al fallo más
  // común —el de arranque o parseo— y esos juegos salían «sin errores».
  // Detrás de <head> y no antes del doctype: delante, el documento cae en modo
  // quirks y cambia el tamaño del canvas, o sea que cambiaría lo que medimos.
  marco.srcdoc = /<head[^>]*>/i.test(doc) ? doc.replace(/<head[^>]*>/i, m => m + sonda)
    : /<html[^>]*>/i.test(doc) ? doc.replace(/<html[^>]*>/i, m => m + sonda)
    : sonda + doc;

  const respuestas = [];
  const oir = e => { if (e.data && e.data.__sonda === 1) respuestas.push(e.data.r); };
  window.addEventListener('message', oir);
  document.body.appendChild(marco);

  const esperar = t => new Promise(r => setTimeout(r, t));
  const pedir = async () => {
    const n = respuestas.length;
    try { marco.contentWindow.postMessage({ __sonda: 1 }, '*'); } catch { /* */ }
    for (let i = 0; i < 40 && respuestas.length === n; i++) await esperar(50);
    // Al expirar el plazo, respuestas.length sigue valiendo n y esto devolvía
    // LA LECTURA ANTERIOR. Entonces b===a daba «no está vivo» y c===b daba «no
    // responde» sobre un juego que funciona. Y como el evaluador se usa MIENTRAS
    // el modelo genera, el iframe llega tarde justo cuando más se le mide: un
    // juego jugable se puntuaba 0 por no haber contestado a tiempo.
    return respuestas.length > n ? respuestas[respuestas.length - 1] : null;
  };

  await esperar(1300);
  const a = await pedir();
  await esperar(ms);
  const b = await pedir();
  try {
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', ' ', 'w', 's'])
      marco.contentWindow.postMessage({ __tecla: k }, '*');
  } catch { /* */ }
  await esperar(1200);
  const c = await pedir();
  // Cuarta lectura, SIN mandar nada más. Hace falta porque «sobrevive» empuja al
  // modelo a que el juego no arranque hasta la primera pulsación —que es lo
  // correcto— y entonces «vivo», medido solo ANTES de tocar nada, lo castigaba
  // justo por hacerlo bien. Las dos señales se contradecían. Ahora vale con que
  // se mueva solo en algún momento: antes de la entrada, o después de ella.
  await esperar(1400);
  const d = await pedir();

  window.removeEventListener('message', oir);
  marco.remove();

  if (!a || !b || !c || !d) return { nota: -1, detalle: { medible: false }, medible: false,
    error: 'el artefacto no contestó a tiempo (no es un fallo suyo: no se pudo medir)' };
  // Las mismas cinco señales que mide el arnés externo, para que la nota de
  // dentro y la de fuera signifiquen lo mismo y se puedan contrastar.
  const fallo = [a, b, c, d].map(x => x && x.err).find(Boolean) || null;
  // El snake generado arrancaba ya moviéndose y chocaba contra la pared en un
  // segundo y medio: cuando lo abres ya ha terminado. Gráficamente impecable y
  // pasaba las cinco señales anteriores. «arranca» mira el primer instante;
  // esto mira si SIGUE vivo unos segundos después sin que nadie juegue.
  const seAcabo = t => /game\s*over|has perdido|fin del juego|puntuaci[óo]n final/.test(t || '');
  const detalle = {
    pinta: a.nb > 0,
    vivo: !!(a.h !== b.h || c.h !== d.h),
    // escuchar Y reaccionar. Solo lo segundo daba por bueno un juego sordo que
    // simplemente seguía animando; solo lo primero daría por bueno uno que
    // registra el escuchador y no hace nada con él.
    responde: !!((c && c.escucha && c.escucha.length) && (c && b && b.h !== c.h)),
    arranca: !seAcabo(a.txt),
    // Se comprueba en la ÚLTIMA lectura, no en la segunda. Al pedirle al modelo
    // que no arranque hasta la primera pulsación, mirar antes de tocar nada
    // daba «sobrevive» por bueno trivialmente: el juego aún no había empezado.
    // Snake pasó de morir en segundo y medio a esperar y MORIR IGUAL de rápido
    // en cuanto arrancaba, y así puntuaba 6/6.
    sobrevive: !seAcabo(d && d.txt) && !seAcabo(b && b.txt),
    sinErrores: !fallo,
  };
  // «pinta» es puerta: sin dibujar nada, un HTML en blanco se llevaba puntos
  // gratis por «no muestra game over» y «sin errores», ciertos por vacuidad.
  const nota = detalle.pinta ? Object.values(detalle).filter(Boolean).length : 0;
  return { nota, maximo: Object.keys(detalle).length, detalle, medible: true, error: fallo, cerrado: /<\/html>/i.test(doc) };
}

// Pedirle a un modelo de 4B «encuentra los defectos de este HTML» es pedirle lo
// que peor hace: leer código largo y juzgarlo. Pero tras ejecutarlo YA sabemos
// objetivamente qué falla. Esto convierte la medición en la lista de defectos,
// que es información dura y no una opinión del propio modelo sobre sí mismo.
function defectosMedidos(detalle, error) {
  if (!detalle) return [];
  const d = [];
  if (!detalle.pinta) d.push('No se dibuja NADA en el canvas: revisa que exista el <canvas>, que se coja su contexto 2d y que algo se pinte al arrancar.');
  if (!detalle.vivo) d.push('La pantalla no cambia sola: falta el bucle de animación. Tiene que haber un requestAnimationFrame que se llame a sí mismo y repinte cada fotograma.');
  if (!detalle.responde) d.push('No reacciona a la entrada: al pulsar las flechas, W/S o la barra, y al mover el ratón, no cambia nada. Los listeners de teclado deben estar en document o window (no en el canvas, que no tiene foco).');
  if (!detalle.arranca) d.push('Arranca ya en pantalla de fin de partida: el estado inicial debe ser «jugando», no «game over».');
  if (!detalle.sobrevive) d.push('La partida se acaba SOLA a los pocos segundos sin que el jugador haga nada, así que es injugable. Arréglalo de las dos formas: (1) que no empiece a moverse hasta la primera pulsación del jugador, y (2) que empiece lejos de los bordes y con velocidad más lenta, para que dé tiempo a reaccionar.');
  if (!detalle.sinErrores) d.push('Lanza este error en ejecución y hay que corregirlo: ' + (error || 'error desconocido'));
  return d;
}

export async function deepCreate({ brief, provider, rounds = 1, onProgress = () => {}, useJury = false,
                                   editMode = 'rewrite', notaMinima = null, evaluar = null, bestOf = 1,
                                   signal = null }) {
  if (!provider || typeof provider.chat !== 'function') throw new Error('Hard Work necesita un cerebro cargado (elige un modelo arriba).');
  if (!String(brief || '').trim()) throw new Error('Hard Work: dime qué quieres que cree.');
  siParado(signal);
  onProgress({ phase: 'draft' });
  let html = extractHtml(await genComplete(provider, CREATE_SYS, String(brief), { signal }));
  const trace = [{ round: 0, html }];

  // Varias tiradas y nos quedamos con la que MEJOR puntúa al ejecutarla.
  // A este tamaño de modelo, pedirle que se critique y se parchee empeora
  // (medido: una ronda dejó un juego jugable sin pintar). Volver a tirar y
  // juzgar por fuera no depende de que el modelo se juzgue bien a sí mismo.
  // Requiere muestreo con temperatura: con decodificado voraz las N tiradas
  // salen idénticas y esto sería pagar N veces por lo mismo.
  const puedeMuestrear = typeof provider.setSampling === 'function';
  if (bestOf > 1 && (evaluar || rateArtifact) && puedeMuestrear) {
    const juzga = evaluar || rateArtifact;
    let mejorHtml = html, mejorV = await juzga(html);
    onProgress({ phase: 'candidato', i: 0, nota: mejorV.nota });
    // El muestreo vuelve a voraz también si se para a mitad: si no, el
    // proveedor se quedaría con temperatura para todo lo que venga después.
    try {
      for (let i = 1; i < bestOf; i++) {
        siParado(signal);
        provider.setSampling({ temperature: 0.85, seed: 1000 + i * 137 });
        const otro = extractHtml(await genComplete(provider, CREATE_SYS, String(brief), { signal }));
        const v = otro ? await juzga(otro) : { nota: -1 };
        onProgress({ phase: 'candidato', i, nota: v.nota });
        trace.push({ candidato: i, html: otro, nota: v.nota });
        if (v.nota > mejorV.nota) { mejorHtml = otro; mejorV = v; }
      }
    } finally { provider.setSampling(null); }   // dejarlo como estaba: voraz
    html = mejorHtml; trace[0].html = html; trace[0].nota = mejorV.nota;
    onProgress({ phase: 'mejorCandidato', nota: mejorV.nota });
  }
  // Con criterio de nota: se guarda la MEJOR versión, no la última. Medimos que
  // una ronda de más puede empeorar (un juego jugable acabó en pantalla de fin),
  // así que devolver «lo último» es devolver a veces lo peor.
  const juez = notaMinima != null ? (evaluar || rateArtifact) : null;
  let mejor = html, mejorNota = -1, ultimoDetalle = null, ultimoError = null;
  if (juez) {
    siParado(signal);
    const v = await juez(html);
    mejorNota = v.nota; ultimoDetalle = v.detalle; ultimoError = v.error;
    trace[0].nota = v.nota; trace[0].detalle = v.detalle;
    onProgress({ phase: 'rated', round: 0, nota: v.nota, detalle: v.detalle });
    if (v.nota >= notaMinima) { onProgress({ phase: 'done', rounds: 0, motivo: 'ya cumplía' }); return { html, trace, nota: v.nota }; }
  }
  for (let r = 1; r <= rounds; r++) {
    siParado(signal);
    onProgress({ phase: 'critique', round: r });
    let critique;
    // Si hemos ejecutado el artefacto, lo MEDIDO manda: son defectos
    // comprobados, no sospechas. La crítica del modelo va detrás, como apoyo.
    const medidos = juez ? defectosMedidos(ultimoDetalle, ultimoError) : [];
    if (medidos.length) {
      critique = 'DEFECTOS COMPROBADOS EJECUTANDO EL JUEGO (corrige estos, son seguros):\n'
        + medidos.map(x => '- ' + x).join('\n');
      onProgress({ phase: 'critique', round: r, medidos: medidos.length });
    } else if (useJury) {
      const v = await juryReview({ artifact: html, provider, onProgress, signal });
      critique = v.defects.length
        ? v.defects.map(d => `- ${d.text} (${d.votes} de ${v.jurors} revisores)`).join('\n')
        : 'Sin defectos con apoyo suficiente del jurado.';
    } else {
      critique = String(await provider.chat([{ role: 'user', content: `APP/JUEGO:\n${html}` }], CRITIQUE_SYS, () => {}, signal)).trim();
    }
    siParado(signal);
    onProgress({ phase: 'rewrite', round: r, modo: editMode });
    if (editMode === 'patch') {
      const resp = await provider.chat(
        [{ role: 'user', content: `HTML ACTUAL:\n${html}\n\nDEFECTOS A CORREGIR:\n${critique}` }], PATCH_SYS, () => {}, signal);
      siParado(signal);
      const { html: nuevo, aplicados, fallidos } = applyPatches(html, resp);
      onProgress({ phase: 'patched', round: r, aplicados: aplicados.length, fallidos: fallidos.length });
      if (aplicados.length) { html = nuevo; trace.push({ round: r, critique, html, aplicados, fallidos }); }
      else trace.push({ round: r, critique, html, aplicados: [], fallidos });
    } else {
      const improved = extractHtml(await genComplete(provider, REWRITE_SYS, `HTML ACTUAL:\n${html}\n\nCRÍTICA A CORREGIR:\n${critique}`, { signal }));
      if (improved && /<\w+[\s>]/.test(improved)) { html = improved; trace.push({ round: r, critique, html }); }
    }
    if (juez) {
      siParado(signal);
      const v = await juez(html);
      ultimoDetalle = v.detalle; ultimoError = v.error;
      trace[trace.length - 1].nota = v.nota; trace[trace.length - 1].detalle = v.detalle;
      onProgress({ phase: 'rated', round: r, nota: v.nota, detalle: v.detalle });
      if (v.nota > mejorNota) { mejorNota = v.nota; mejor = html; }
      if (v.nota >= notaMinima) { onProgress({ phase: 'done', rounds: r, motivo: 'alcanzó la nota' }); return { html: mejor, trace, nota: mejorNota }; }
      // Antes se paraba en cuanto una ronda puntuaba por debajo de la mejor. Con
      // eso una lectura floja tiraba las rondas que quedaban, y como siempre se
      // devuelve la MEJOR, seguir no puede empeorar el resultado: solo cuesta
      // tiempo. Se gasta el presupuesto y se elige al final.
      if (v.nota < mejorNota) onProgress({ phase: 'peor', round: r, nota: v.nota, mejor: mejorNota });
    }
  }
  siParado(signal);
  onProgress({ phase: 'done', rounds: trace.length - 1 });
  return juez ? { html: mejor, trace, nota: mejorNota } : { html, trace };
}

// ── Recolección de material desde una carpeta autorizada (File System Access) ──
// Camina el árbol, concatena ficheros de texto con cabecera de ruta, y corta a
// maxBytes para no reventar la memoria. Mismo código sirve a Claw (carpeta
// autorizada) y a Code (proyecto abierto): ambos entregan un directory handle.
const TEXT_EXT = new Set(('txt md markdown js mjs cjs ts tsx jsx json html htm css scss sass ' +
  'py rb php go rs java kt swift c h cpp hpp cc cs sh bash zsh yml yaml toml ini cfg conf ' +
  'xml csv tsv sql vue svelte astro lua r pl pm ex exs erl clj tex org rst gradle properties').split(' '));
// Lo que huele a secreto NO se lee, aunque sea texto: Hard Work manda lo leído
// al cerebro activo, que puede ser un proveedor externo. Antes .env estaba
// incluido a propósito (y 'env' entre las extensiones de texto).
const SECRETO = /^\.env(\..*)?$|\.env$|\.(pem|key|p12|pfx|jks|keystore|asc|gpg|kdbx)$|^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|^\.(npmrc|netrc|pgpass|pypirc|htpasswd)$|(^|[._-])(secrets?|credentials?|passwords?|passwd|tokens?)([._-]|$)/i;
export const pareceSecreto = nombre => SECRETO.test(nombre);
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'target', 'vendor', '.cache', 'coverage', '__pycache__', '.venv', 'venv']);

export async function gatherFolder(rootHandle, { maxBytes = 1.5e6, maxFiles = 400 } = {}) {
  if (!rootHandle || typeof rootHandle.entries !== 'function') throw new Error('no hay carpeta que leer');
  const out = [];
  let bytes = 0;
  let files = 0;
  async function walk(dir, prefix) {
    if (bytes >= maxBytes || files >= maxFiles) return;
    const entries = [];
    for await (const e of dir.entries()) entries.push(e);
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    for (const [name, handle] of entries) {
      if (bytes >= maxBytes || files >= maxFiles) return;
      if (name.startsWith('.') && handle.kind === 'directory') continue;
      if (handle.kind !== 'directory' && pareceSecreto(name)) continue;
      const path = prefix ? prefix + '/' + name : name;
      if (handle.kind === 'directory') {
        if (SKIP_DIR.has(name)) continue;
        await walk(handle, path);
      } else {
        const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
        if (!TEXT_EXT.has(ext)) continue;
        try {
          const file = await handle.getFile();
          if (file.size > 400000) continue; // un fichero enorme suelto no monopoliza
          const text = await file.text();
          const block = `\n\n===== ${path} =====\n${text}`;
          out.push(block);
          bytes += block.length;
          files++;
        } catch { /* ilegible: se salta */ }
      }
    }
  }
  await walk(rootHandle, '');
  return out.join('').slice(0, maxBytes);
}
