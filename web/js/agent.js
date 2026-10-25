// Bucle agéntico mínimo: modelo → ¿tool call? → ejecutar → resultado → modelo.
import { runTool, toolHelp, snapshot, PARAM_EXACTO, PARAM_NUMERO, PARAM_BOOLEANO } from './tools/index.js';
import { skillsPromptBlock, installed } from './skills.js';
import { crearRouter, bloqueEjemplos } from './tool-router.js';
import { t } from './i18n.js';
import * as telemetry from './telemetry.js';

const MAX_STEPS = 6;

const LANGS = {
  es: 'español', en: 'English', uk: 'українська', ru: 'русский', fr: 'français',
  de: 'Deutsch', it: 'italiano', pt: 'português', pl: 'polski', ca: 'català',
  gl: 'galego', eu: 'euskera', nl: 'Nederlands', ro: 'română', tr: 'Türkçe',
};

export function userLang() {
  const code = (navigator.language || 'es').toLowerCase();
  return { code, name: LANGS[code.split('-')[0]] || code };
}

// Los ejemplos del prompt pueden viajar con su familia de herramientas
// (bloqueEjemplos, en tool-router.js), pero va APAGADO porque medido no gana.
// Gemma 4 E4B, banco ciego, 52 peticiones con herramienta:
//   · prompt entero                          42/52   1.283 tokens
//   · recortando solo el catálogo            44/52   1.033
//   · recortando catálogo y ejemplos         42/52     934
// Empata con el entero, pero acierta dos menos que recortar solo el catálogo, y
// en los casos que cambian entre esas dos, tres empeoran y uno mejora. Con 52
// casos es ruido en las dos direcciones, y ruido no basta para encender algo
// que toca lo que el modelo imita. Con false van los cinco siempre, como antes.
const RECORTAR_EJEMPLOS = false;

export function systemPrompt(context = '', { herramientas = null } = {}) {
  const lang = userLang();
  // Versión corta para modelos LENTOS. No es el prompt de siempre recortado: se
  // quitan prosa y ejemplos, NO capacidades.
  //
  // Antes decía «no tienes herramientas, no puedes crear apps». Tenía sentido
  // cuando el contexto de ese modelo era 2.048 y el catálogo no cabía: mentirle
  // al modelo sobre lo que puede hacer era mejor que dejarle prometer lo que iba
  // a fallar. Con el contexto en 65.536 la premisa desapareció, y lo que quedaba
  // era un Elffuss que se niega a hacer lo único que la gente viene a pedirle.
  //
  // El catálogo se conserva ENTERO a propósito, como en Code: un Elffuss sin
  // herramientas carga, responde y no sirve para nada, que es peor que fallar
  // fuerte. Lo que sí se sigue quitando es el CONTEXTO VIVO, que crece con el
  // estado del sistema y se paga en espera antes de la primera letra.
  // La rama de prompt COMPACTO se ha retirado. Recortarlo dejaba al modelo sin
  // saber hacer tareas —el motivo de ponerlo era que el completo tarda más en
  // procesarse— y un asistente que carga, responde y no sirve para nada es peor
  // que uno lento. El coste del prompt completo se ataca reutilizando el
  // prefijo entre turnos y guardando el estado entre sesiones, no recortándole
  // al modelo lo que sabe hacer.
  return `Eres Elffuss: un sistema operativo con alma que vive en el navegador del usuario. Cálida y luminosa, pero tremendamente resolutiva. Hablas SIEMPRE en el idioma del navegador del usuario: ${lang.name} (${lang.code}) — breve y con cariño. Si el usuario cambia de idioma, síguele. El chat es la única interfaz: las apps no existen, las creas tú.

HERRAMIENTAS (el sistema pide los permisos, tú solo llama):
${herramientas ? herramientas.join('\n') : toolHelp()}

Cómo actuar:
1) Para usar una herramienta responde SOLO con:
\`\`\`tool
{"tool": "fs.list", "args": {}}
\`\`\`
2) Para crear una app responde SOLO con el documento HTML completo (autocontenido, CSS/JS inline, fondo oscuro, en el idioma del usuario). Si la app es visual o creativa (juegos, arte, música, datos, ambientes), usa <canvas> con WebGL o efectos de partículas/glow — que luzca espectacular, no un formulario gris:
\`\`\`html
<!doctype html><html>…</html>
\`\`\`
3) Tras un [resultado] que EMPIEZA por ERROR: no te rindas ni digas que no se puede. REANALIZA el mensaje de error (suele decir qué hay o qué falta) y REINTENTA con la corrección (otra ruta, otros argumentos). Solo si vuelve a fallar de otra forma, explica al usuario qué pasó.
4) Tras un [resultado] correcto, o si no hace falta herramienta, responde texto normal en el idioma del usuario. No repitas una herramienta que YA salió bien (una app creada ya está hecha): responde y para.
5) SÍ PUEDES buscar y navegar por internet: usa web.search (texto) o web.images (fotos). NUNCA digas que no tienes acceso a internet — para eso están las herramientas.
6) TRANSFORMAR o CALCULAR sobre un fichero (escalar un modelo 3D, convertir un CSV, limpiar una lista) se hace AQUÍ. Un fichero son BYTES y fs.read/fs.write los leen y escriben, así que PROHIBIDO contestar «mis herramientas no sirven para esto» y parar. Dos caminos:
   · si cabe y es texto: fs.read, lo transformas tú y fs.write. Un STL ASCII, un CSV o un SVG es eso y nada más.
   · si hay que calcular de verdad o el usuario quiere repetirlo: app.create con una página que lo haga en el navegador. Esa ES tu consola: HTML, CSS y JavaScript.
7) ⛔ Aquí NO hay shell ni Python: no existe terminal.run ni nada que instale paquetes. Así que NUNCA propongas una librería de terceros («necesitarías numpy-stl»), ni preguntes si algo está instalado, ni te ofrezcas y esperes («¿quieres que te prepare un script?»). Resuélvelo con fs.* y app.create, que para esto alcanzan: escalar un STL es multiplicar números.
8) ANTES DE ACTUAR, mira qué pide el ÚLTIMO mensaje y conéctalo con TODA la conversación:
   · Lo dicho antes sigue valiendo (para quién es, cuántos son, gustos, lo que se buscó, las URLs que salieron): úsalo y no lo vuelvas a preguntar. «Eso», «esa», «instálala» señalan lo último de lo que se habló.
   · Si el usuario fija un orden («primero busca…», «búscala en internet»), tu PRIMER paso es ese.
   · Haz lo que pide AHORA: no retomes ni rehagas una tarea anterior (no vuelvas a crear una app ya hecha) si no te lo pide.
   · Si se entiende lo que quiere, hazlo; pregunta solo lo imprescindible que no puedas deducir.
9) Si quiere una skill CONCRETA de internet: si no tienes su URL, web.search; luego skill.install con la URL de GitHub. No la imites con skill.create ni digas que no se puede instalar.${bloqueEjemplos(RECORTAR_EJEMPLOS ? herramientas : null)}${skillsPromptBlock()}`;
}

export const ETIQUETA_CONTEXTO = 'CONTEXTO AHORA (estado real del sistema, úsalo al responder):';

// ── Dónde va el estado vivo, y por qué NO va en el prompt de sistema ────────
// El bloque «CONTEXTO AHORA» estaba dentro de `systemPrompt()`, y el motor monta
// el prompt poniendo el system ENTERO en la cabeza, delante de toda la historia
// (`montarPrompt` en provider.js). La reutilización de prefijo compara tokens
// desde el principio y se corta en la primera divergencia, así que cualquier
// cambio en ese bloque invalidaba el prefijo COMPLETO: el prompt de sistema
// entero más toda la conversación.
//
// Y ese bloque cambia constantemente —es estado vivo— así que en la práctica la
// caché de prefijo no servía casi nunca. Medido el 2026-10-10: con un prompt
// realista el prefill del modelo grande es la espera mas larga del producto,
// y un turno con
// herramientas pagaba eso EN CADA PASO del bucle, porque cada paso cambia el
// estado y por tanto la cabeza.
//
// Ahora el estado vivo viaja como un MENSAJE, colocado justo antes del último
// de la conversación. Así el prefijo común cubre el prompt de sistema y toda la
// historia anterior, y solo se reprocesa lo nuevo.
//
// ⚠️ Va antes del ÚLTIMO mensaje, no al final, a propósito: el empaquetador de
// contexto elige la «pregunta viva» como el último mensaje de usuario que no
// empiece por «[resultado», y si este bloque fuera el último se convertiría en
// la pregunta viva y la recuperación puntuaría contra un volcado de estado en
// vez de contra lo que ha pedido el usuario.
//
// Va marcado `efimero`: cambia en cada llamada y no es parte de la conversación.
// LiteRT, que guarda la conversación entre llamadas, lo salta al comprobar de
// qué conversación es un historial (ver dondeSigue en providers/litert.js). La
// marca no es enumerable: no viaja en el JSON que se manda a ninguna API.
export function mensajeContexto(context, etiqueta) {
  if (!context) return null;
  return Object.defineProperty({ role: 'user', content: `${etiqueta}\n${context}` }, 'efimero', { value: true });
}

// Inserta el estado vivo justo antes del último mensaje de la conversación.
export function conContexto(history, context, etiqueta) {
  const m = mensajeContexto(context, etiqueta);
  if (!m) return history;
  if (!history.length) return [m];
  return [...history.slice(0, -1), m, history[history.length - 1]];
}


// ── qué herramientas se le enseñan al modelo en cada turno ──────────────────
// Ver tool-router.js: se recuperan por familias según la petición y, si el
// recuperador duda, se manda el catálogo entero. Medido en un banco a ciegas de
// 60 peticiones (tests/enrutado-herramientas.mjs): la familia buena queda a la
// vista en 57, y el catálogo baja de 536 a 304 tokens de media.
//
// Las skills instaladas pueden llamar a herramientas de cualquier familia: las
// que nombra una skill se enseñan siempre, o la skill se quedaría a medias sin
// que el modelo supiera por qué.
//
// SOLO PARA LOS MODELOS QUE LO PIDEN. Enseñar menos herramientas no le sienta
// igual a todos los modelos, y la literatura que dice que ayuda no midió los
// nuestros. Medido con modelo de verdad (tests/enrutado-modelo.mjs, banco ciego,
// 52 peticiones que necesitan herramienta, temperatura 0):
//   · Gemma 4 E4B: 42 → 44 aciertos. Empate —gana 4, pierde 2— con unos 250
//     tokens menos de prompt, que en local es prefill que no se paga.
//   · Qwen3.5-0.8B: 29 → 23. Con menos herramientas a la vista contesta con una
//     app HTML o no llama a nada, aunque la herramienta buena esté delante.
// Por eso es opt-in: se enciende si el proveedor declara enrutaHerramientas()
// —como prefiereCompacto()—, y el que no dice nada recibe el catálogo entero,
// como antes de que esto existiera. Un modelo no entra sin medirlo.
//
// Y el banco mide peticiones SUELTAS, así que solo vale para proveedores que
// reconstruyen el prompt en cada llamada (motor propio, ONNX, API). Uno que
// guarda la conversación con su prompt de sistema dentro —LiteRT— congela el
// catálogo del primer mensaje: ese declara false, que significa «imposible».
// Hoy ningún proveedor lo declara true: E4B, el único que lo aguanta, va por
// LiteRT.
//
// Interruptor, como el del gestor de contexto:
//   localStorage.setItem('elffuss.router', 'off')   → catálogo entero siempre
//   localStorage.setItem('elffuss.router', 'on')    → recuperación con un modelo sin medir (para medirlo)
//   localStorage.removeItem('elffuss.router')        → lo que declare el proveedor (por defecto)
// Un proveedor que declara false no se fuerza ni con 'on'.
let router = null;
export function herramientasPara(consulta, provider = null) {
  try {
    const interruptor = typeof localStorage !== 'undefined' ? localStorage.getItem('elffuss.router') : null;
    const declara = provider?.enrutaHerramientas?.();
    if (interruptor === 'off' || declara === false) return null;
    if (interruptor !== 'on' && !declara) return null;
    router ||= crearRouter(toolHelp().split('\n'));
    const deSkills = new Set();
    for (const s of installed() || [])
      for (const m of String(s.content || '').matchAll(/\b(fs|app|vault|tasks|web|skill|memory)\.[a-z_]+/g)) deSkills.add(m[1]);
    const r = router.rutear(consulta, { ademas: [...deSkills] });
    console.debug('[herramientas]', r ? r.familias.join(', ') : 'todas (sin señal clara)');
    return r;
  } catch (e) {
    console.warn('[herramientas] el recuperador falló, va el catálogo entero:', e.message);
    return null;
  }
}

// Repara el JSON de modelos pequeños: coma final + saltos de línea/tab/CR
// LITERALES dentro de cadenas (rompen JSON.parse). Las comillas internas sin
// escapar las resuelve looseToolCall.
function repairJson(raw) {
  const s = raw.replace(/,(\s*[}\]])/g, '$1');
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') {
      // Una barra solo abre un escape si lo que sigue PUEDE escaparse. Un modelo
      // que escribe una continuación de línea de shell dentro del valor («echo
      // uno \» + salto de línea REAL) no está escapando nada, y tratarlo como si
      // lo fuera dejaba una barra pegada a un salto crudo —que no parsea— y más
      // abajo acababa convertido en barra más la letra «n», con el salto
      // perdido: un fichero roto escrito en silencio. Si no es un escape válido,
      // la barra se escapa a sí misma y del carácter siguiente ya se encargan
      // las ramas de abajo.
      if (inStr && !'"\\/bfnrtu'.includes(s[i + 1] ?? '')) { out += '\\\\'; continue; }
      out += ch; esc = true; continue;
    }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr && ch === '\n') { out += '\\n'; continue; }
    if (inStr && ch === '\r') { out += '\\r'; continue; }
    if (inStr && ch === '\t') { out += '\\t'; continue; }
    out += ch;
  }
  return out;
}

// Extractor tolerante dirigido por claves: localiza cada clave conocida y lee su
// valor hasta la comilla de cierre REAL (« seguida de , " o }} »), tolerando
// comillas y saltos sin escapar. Si una cadena NO cierra, es un truncado a media
// escritura → no recuperar (no inventar datos).
function looseToolCall(raw) {
  const tm = raw.match(/"tool"\s*:\s*"([\w.]+)"/);
  if (!tm) return null;
  const am = raw.match(/"args"\s*:\s*\{/);
  const body = am ? raw.slice(am.index + am[0].length) : raw;
  const args = {};
  for (const key of ['path', 'content', 'name', 'html', 'prompt', 'text', 'search', 'replace', 'query', 'key', 'value', 'url']) {
    const km = body.match(new RegExp('"' + key + '"\\s*:\\s*"'));
    if (!km) continue;
    // El cierre REAL se elige mirando todos los candidatos y quedándose con el
    // ÚLTIMO que deje el objeto bien cerrado detrás, no con el primero.
    //
    // El primero se equivoca en cuanto el valor lleva una comilla seguida de
    // «, "», que parece el final de un valor y el principio de la clave
    // siguiente. Con `"content": "console.log("a", "b")\n"` cortaba en
    // `console.log("a` y escribía ESE fichero diciendo «Escrito»: roto, en
    // silencio, con el aviso de éxito puesto. En Claw el mismo corte le puede
    // pasar al `html` de `app.create` o al `secret` del vault.
    //
    // Y no basta con coger el último: se exige que lo que venga después cierre
    // el objeto. Si ningún candidato lo consigue, no se recupera nada, que es lo
    // correcto cuando el mensaje se cortó a media escritura — completarlo sería
    // inventar un contenido que el modelo no escribió.
    const desde = km.index + km[0].length;
    const candidatos = [];
    for (let i = desde; i < body.length; i++) {
      const ch = body[i];
      if (ch === '\\') { i++; continue; }
      if (ch === '"' && /^\s*(,\s*"|\}\s*[}\]]|\}\s*$|$)/.test(body.slice(i + 1))) candidatos.push(i);
    }
    let val = null;
    for (let k = candidatos.length - 1; k >= 0; k--) {
      if (/^\s*(,|\})/.test(body.slice(candidatos[k] + 1))) { val = body.slice(desde, candidatos[k]); break; }
    }
    if (val === null) return null;
    try { val = JSON.parse('"' + val.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"'); } catch { /* crudo */ }
    args[key] = val;
  }
  for (const key of ['inMinutes', 'offset', 'limit', 'depth']) {
    const nm = body.match(new RegExp('"' + key + '"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)'));
    if (nm) args[key] = Number(nm[1]);
  }
  return { tool: tm[1], args };
}

function tryJson(raw) {
  for (const cand of [raw, repairJson(raw)]) {
    try {
      const obj = JSON.parse(cand);
      if (obj && typeof obj.tool === 'string') return { tool: obj.tool, args: obj.args || {} };
    } catch { /* siguiente capa */ }
  }
  return looseToolCall(raw);
}

// Formato NATIVO de LFM2.5 (y afines): <|tool_call_start|>[ name(k="v", n=3) ]<|tool_call_end|>
// o simplemente name(k="v") en su línea. Se parsea a {tool, args}.
export function parseNativeCall(text) {
  const m = text.match(/<\|tool_call_start\|>\s*\[?\s*([\w.]+)\s*\(([\s\S]*?)\)\s*\]?\s*<\|tool_call_end\|>/)
    || text.match(/^\s*\[\s*([\w.]+)\s*\(([\s\S]*?)\)\s*\]\s*$/m);
  if (!m) return null;
  const args = {};
  const re = /([\w]+)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,)]+)/g;
  let a;
  while ((a = re.exec(m[2]))) {
    let v = a[2].trim();
    if (/^["']/.test(v)) v = v.slice(1, -1).replace(/\\(.)/g, '$1');
    else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    else if (v === 'true' || v === 'false') v = v === 'true';
    args[a[1]] = v;
  }
  return { tool: m[1], args };
}

// Formato `<function name="X"><param name="k">v</param></function>`, que es el
// que emite MiniCPM5 y varios modelos más. No es el que pide nuestro prompt
// —bloque ```tool con JSON— pero un modelo entrenado con otro formato lo emite
// igual por mucho que se le pida el nuestro, y entonces la llamada se imprime
// como texto y no se ejecuta NADA: el usuario ve al modelo "contestar" con una
// etiqueta XML y no pasa nada más.
//
// Se acepta el formato en vez de pelearse con el modelo. El valor de cada
// `param` se intenta leer como JSON —para que un 3 sea el número 3 y no "3"—
// y si no es JSON válido se queda como texto, que es lo que hay que hacer con
// una ruta.
// Lectura segura de las excepciones del contrato.
// `PARAM_EXACTO['constructor']` no es undefined: es `Object.prototype.constructor`,
// o sea una función, así que `(mapa[x] || []).includes(...)` LANZA. Y el nombre de
// la herramienta sale del texto del modelo, que puede decir `constructor`,
// `toString` o `__proto__`.
const esDe = (mapa, herramienta, param) =>
  Object.hasOwn(mapa, herramienta) && Array.isArray(mapa[herramienta]) &&
  mapa[herramienta].includes(param);

// El cuerpo se saca con un grupo atómico emulado —el `(?=(…))\3`— para que un
// `</function>` DENTRO de un CDATA no cierre la llamada. Sin eso el cuerpo
// llegaba cortado, el <param> del contenido no casaba, y `fs.write` escribía un
// fichero VACÍO (content vale '' por defecto). Una llamada sin cerrar no casa
// nada, que es lo que se quiere: mejor no ejecutar que ejecutar a medias.
const RE_FUNCION = /<function\s+name=["']([\w.\-]+)["']\s*>((?:(?=(<!\[CDATA\[[\s\S]*?\]\]>(?=\s*<\/param\s*>)))\3|[\s\S])*?)<\/function\s*>/g;

export function parseFunctionTags(text) {
  const out = [];
  RE_FUNCION.lastIndex = 0;
  let m;
  while ((m = RE_FUNCION.exec(text))) {
    const herramienta = m[1];
    const args = {};
    // El `\s*` va DENTRO de la alternativa de CDATA, no antes: puesto fuera se
    // come la sangría de la primera línea del cuerpo normal.
    const pre = /<param\s+name=["']([\w.\-]+)["']\s*>(?:\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/param\s*>|([\s\S]*?)<\/param\s*>)/g;
    let p;
    while ((p = pre.exec(m[2]))) {
      const nombre = p[1];
      const enCdata = p[2] !== undefined;
      const crudo = enCdata ? p[2] : (p[3] || '');
      if (esDe(PARAM_EXACTO, herramienta, nombre)) {
        // El valor ES el contenido. Dentro de un CDATA, exacto. Fuera, se quita
        // UN salto de línea inicial y solo uno: el modelo abre el valor en su
        // propia línea y ese salto es formato suyo, no una primera línea en
        // blanco del fichero. El salto FINAL se conserva. Quien necesite que el
        // contenido empiece de verdad con una línea en blanco tiene el CDATA.
        args[nombre] = enCdata ? crudo : crudo.replace(/^\r?\n/, '');
      } else {
        // Escalar: se recorta y se le quita UN par de comillas que lo envuelva.
        // Sin esto, un `path` que el modelo entrecomilla crea una carpeta «"src»
        // y un numérico entrecomillado da NaN. Un valor de verdad no empieza y
        // acaba por comilla; el contenido de un fichero sí puede, y por eso esto
        // NO se aplica a los exactos.
        const v = crudo.trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
        if (esDe(PARAM_NUMERO, herramienta, nombre)) {
          const n = Number(v);
          // Si no es número se deja el texto: que el error salga donde se usa,
          // con el valor que mandó el modelo, y no un NaN callado.
          args[nombre] = (v !== '' && Number.isFinite(n)) ? n : v;
        } else if (esDe(PARAM_BOOLEANO, herramienta, nombre)) {
          args[nombre] = /^(true|1|s[ií]|yes)$/i.test(v);
        } else {
          args[nombre] = v;
        }
      }
    }
    out.push({ tool: herramienta, args });
  }
  return out;
}


export function parseToolCall(text) {
  const xml = parseFunctionTags(text);
  if (xml.length) return xml[0];
  const native = parseNativeCall(text);
  if (native) return native;

  const fences = [...text.matchAll(/```(\w*)[ \t]*\n?([\s\S]*?)```/g)]
    .map(m => ({ lang: (m[1] || '').toLowerCase(), body: m[2].trim() }));

  // 1) Cualquier fence con JSON {tool,args} vale: los modelos pequeños
  //    etiquetan mal el bloque (```javascript, ```json, sin etiqueta…).
  for (const f of fences) {
    if (f.lang === 'html') continue;
    const call = tryJson(f.body);
    if (call) return call;
  }
  if (text.trim().startsWith('{')) {
    const call = tryJson(text.trim());
    if (call) return call;
  }

  // 2) Atajo apps: un fence ```html (o una respuesta que ES un documento html)
  //    se convierte en app.create — mucho más fiable para modelos pequeños que
  //    escapar todo el HTML dentro de un string JSON.
  //    Un fence SIN CERRAR (el modelo agotó max_tokens a media app) también
  //    vale: los navegadores toleran HTML truncado.
  const openFence = text.match(/```html[ \t]*\n?([\s\S]*)$/i);
  const html = fences.find(f =>
    (f.lang === 'html' && /<\w+[\s>]/.test(f.body)) || /^(<!doctype|<html)/i.test(f.body))?.body
    || (/^(<!doctype html|<html)/i.test(text.trim()) ? text.trim() : null)
    || (!fences.length && openFence && /^(<!doctype|<html)/i.test(openFence[1].trim()) ? openFence[1].trim() : null);
  if (html) {
    const title = html.match(/<title>([^<]{1,40})<\/title>/i)?.[1]
      || html.match(/<h1[^>]*>([^<]{1,40})</i)?.[1] || 'app';
    const name = title.trim().toLowerCase().replace(/[^\wáéíóúñü -]/g, '').slice(0, 24).trim() || 'app';
    return { tool: 'app.create', args: { name, html } };
  }
  return null;
}

// Cierre amable cuando el bucle se corta: usa el último resultado útil.
function closingLine(done, lastResult) {
  if (lastResult && !lastResult.startsWith('ERROR')) return lastResult;
  return t('anythingElse');
}

// Espera a `p` salvo que paren el turno antes: entonces rechaza en el acto con
// un AbortError. Las herramientas no reciben la señal, y alguna puede tardar o
// no volver nunca (un permiso sin contestar, una web que no responde): sin
// esto, ■ abortaba el turno pero el bucle seguía colgado de la herramienta, sin
// llegar a ninguna comprobación. La herramienta puede terminar igualmente por
// detrás; su resultado ya no se usa.
function hastaQueParen(p, signal) {
  return new Promise((si, no) => {
    const alParar = () => no(Object.assign(new Error('parado'), { name: 'AbortError' }));
    if (signal.aborted) { alParar(); return; }
    signal.addEventListener('abort', alParar, { once: true });
    Promise.resolve(p).then(
      v => { signal.removeEventListener('abort', alParar); si(v); },
      e => { signal.removeEventListener('abort', alParar); no(e); });
  });
}

export class Agent {
  constructor(provider) {
    this.provider = provider;
    this.history = [];
  }

  setProvider(p) { this.provider = p; }

  // Parar el turno en marcha (mismo patrón que Elffuss Code): aborta la
  // generación en curso —los proveedores reciben la señal en el 4º argumento de
  // chat()— y el bucle no da ni un paso más. Parar NO es un error: se avisa
  // con un evento 'aborted' y no se reporta nada a la telemetría.
  stop() { try { this._aborter?.abort(); } catch { /* */ } }

  // `signal` (opcional) es el del turno de quien llama —el kernel, el cerebro
  // CEO…—: abortarlo para este agente igual que stop(). Si ya llega abortado,
  // ni se apunta el mensaje en el histórico ni se llama al modelo (igual que en
  // Elffuss Code).
  //
  // `permitir` (opcional): (nombre de herramienta) => bool. Lo que no pasa no se
  // ejecuta: el modelo recibe un ERROR que se lo explica. Lo usa el cerebro
  // autónomo, que solo puede leer (ver ceo.js `allowTool`).
  async handle(userText, onEvent, { signal: deFuera = null, permitir = null } = {}) {
    const aborter = (this._aborter = new AbortController());
    if (deFuera?.aborted) { onEvent({ type: 'aborted', text: t('stopped') }); return; }
    const alAbortar = () => aborter.abort();
    deFuera?.addEventListener?.('abort', alAbortar, { once: true });
    try { return await this._turno(userText, onEvent, aborter.signal, permitir); }
    finally { deFuera?.removeEventListener?.('abort', alAbortar); }
  }

  async _turno(userText, onEvent, signal, permitir = null) {
    const parado = () => onEvent({ type: 'aborted', text: t('stopped') });
    // La marca temporal se pone AL AÑADIR, que es el único momento en que se
    // sabe: el gestor de contexto resuelve «ayer» con la fecha del turno en que
    // se dijo, no con la de ahora (ver annotateDates en acer-core.js). Sin esto
    // la anotación se calla, que es lo correcto, pero no sirve para nada.
    this.history.push({ role: 'user', content: userText, ts: Date.now() });
    const done = [];            // firmas de tool calls ya ejecutadas este turno
    let lastResult = '';
    // Una sola decisión por turno, sobre lo que pidió el usuario. El prompt no
    // debe cambiar entre los pasos de un mismo turno: un resultado de herramienta
    // podría esconderle al modelo la herramienta que necesita en el paso siguiente.
    const ruta = herramientasPara(userText, this.provider);
    const herramientas = ruta?.lineas?.length ? ruta.lineas : null;
    for (let step = 0; step < MAX_STEPS; step++) {
      let out;
      if (signal.aborted) return parado();
      try {
        const context = await snapshot().catch(() => '');
        if (signal.aborted) return parado();
        // Los proveedores que saben cuánto contexto tienen lo dicen; los que no,
        // devuelven 0 y todo sigue igual que siempre. Sin esto, Elffuss le
        // mandaba sus 1.315 tokens de instrucciones al 27B —que tiene 512— y el
        // primer mensaje moría con la caché llena DESPUÉS de 7,6 GB de descarga.
        const contexto = this.provider.contextTokens?.() || 0;
        // Se habla en corto por DOS razones distintas, y conviene no confundirlas:
        //
        //
        // Aquí se decidía si mandar un prompt RECORTADO, por dos motivos: que el
        // modelo fuera lento, o que su contexto fuera pequeño. Se ha quitado
        // entero. Recortarlo dejaba al modelo sin saber hacer tareas, y eso es
        // peor que ser lento: un asistente que carga, responde y no sirve para
        // nada decepciona más que uno que tarda. El coste del prompt completo se
        // ataca reutilizando el prefijo entre turnos y guardando el estado entre
        // sesiones, no quitándole capacidades al modelo.
        // El 4º argumento de chat() es { signal, onPrefill }: la parada del
        // turno y el aviso de avance del prefill (el motor propio admite
        // también la señal sola).
        out = await this.provider.chat(conContexto(this.history, context, ETIQUETA_CONTEXTO),
          systemPrompt('', { herramientas }),
          t => { if (!signal.aborted) onEvent({ type: 'token', text: t }); },
          { signal, onPrefill: (hechos, total) => { if (!signal.aborted) onEvent({ type: 'prefill', hechos, total }); } });
      } catch (e) {
        // Un proveedor que corta con la señal puede LANZAR (fetch abortado,
        // stream cancelado): eso es la parada que se ha pedido, no un fallo.
        // Un AbortError con la señal del turno INTACTA también es una parada:
        // el motor propio corta el turno en marcha al descargarse (vigilante de
        // RAM, «liberar el modelo», cambiar de modelo a mitad) y rechaza así.
        // Antes eso salía como «El modelo falló» y se reportaba a telemetría.
        // Elffuss Code ya lo trataba como parada.
        if (signal.aborted || e?.name === 'AbortError') return parado();
        telemetry.reportError('agent.handle: ' + e.message, { stack: e.stack || '' });
        onEvent({ type: 'error', text: 'El modelo falló: ' + e.message });
        return;
      }

      // Lo generado después de parar no se usa: ni se responde ni se ejecuta.
      if (signal.aborted) return parado();
      const call = parseToolCall(out);
      if (!call) {
        this.history.push({ role: 'assistant', content: out, ts: Date.now() });
        onEvent({ type: 'text', text: out });
        return;
      }

      // Anti-bucle: los modelos pequeños repiten la misma herramienta. Si ya se
      // ejecutó esta llamada (misma firma) o ya se creó una app, se corta y se
      // cierra con una respuesta en vez de girar hasta agotar los pasos.
      const sig = call.tool + ':' + JSON.stringify(call.args || {});
      if (done.includes(sig)) {
        onEvent({ type: 'text', text: closingLine(done, lastResult) });
        return;
      }
      done.push(sig);

      onEvent({ type: 'tool', call });
      let result;
      if (permitir && !permitir(call.tool)) {
        result = `ERROR: aquí solo puedes leer; «${call.tool}» cambiaría cosas y no está permitida. Propón ese cambio en texto.`;
      } else {
        try { result = await hastaQueParen(runTool(call.tool, call.args, { signal }), signal); }
        catch (e) {
          // Parado con la herramienta en marcha: el turno acaba aquí y no apunta
          // nada de este paso (la herramienta puede acabar por detrás).
          if (signal.aborted) return parado();
          result = 'ERROR: ' + e.message;
        }
      }
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      lastResult = resultStr;
      onEvent({ type: 'tool_result', tool: call.tool, result: resultStr });

      this.history.push({ role: 'assistant', content: out, ts: Date.now() });
      const pista = resultStr.startsWith('ERROR')
        ? '\n(Reanaliza este error y reintenta con la corrección; no te rindas.)' : '';
      this.history.push({ role: 'user', content: `[resultado ${call.tool}]\n${resultStr}${pista}`, ts: Date.now() });

      // Tras crear/abrir una app, la tarea suele estar hecha: cierra ya.
      if ((call.tool === 'app.create' || call.tool === 'app.open') && !resultStr.startsWith('ERROR')) {
        onEvent({ type: 'text', text: t('done', { result: resultStr }) });
        return;
      }
    }
    if (signal.aborted) return parado();
    onEvent({ type: 'text', text: closingLine(done, lastResult) });
  }
}
