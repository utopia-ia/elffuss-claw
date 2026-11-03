// tool-router.js — enseñarle al modelo solo las herramientas que vienen a cuento
// ─────────────────────────────────────────────────────────────────────────────
// POR QUÉ. El catálogo son 27 herramientas y se mandaba ENTERO en cada turno,
// junto con cinco ejemplos fijos: 847 de los 1.261 tokens del prompt fijo, el
// 67 %, medido con el tokenizador real. En un modelo local el prompt no sale
// gratis: el prefill es el cuello de botella (en el 27B, el prompt completo tarda
// unas catorce veces más en dar el primer token que el compacto), y un modelo
// pequeño se confunde más cuantas más herramientas tiene delante. En los harnesses de 2026 esto se llama «tool
// search» o «progressive disclosure»: recuperar por petición solo lo necesario.
//
// POR QUÉ POR FAMILIAS Y NO POR HERRAMIENTA. Las de una familia se usan juntas:
// fs.read sin fs.list deja al modelo leyendo a ciegas. Son 7 familias.
//
// LA REGLA QUE NO SE NEGOCIA: si no hay señal clara, se manda el catálogo entero.
// Un recuperador que se equivoca en silencio es peor que no tener recuperador,
// porque el modelo no puede llamar a lo que no ve y tampoco avisa de que le
// falta: inventa. Por eso rutear() devuelve null cuando duda, y null significa
// «todo, como siempre». Nunca peor que antes de existir esto.
//
// POR QUÉ SE PLIEGAN LAS TILDES ANTES DEL BM25. terms() de acer-core ya parte por
// letras de cualquier alfabeto, pero NO pliega tildes a propósito (en un
// historial largo, plegar convierte «qué» y «está» en las palabras más comunes y
// meten ruido; ver su comentario). Aquí el problema no existe —el corpus son
// siete descripciones escritas a mano y las palabras vacías se quitan de la
// consulta— y lo que sí importa es que «recuerdame» sin tilde case con la pista
// «recuérdame». Por eso se pliega la consulta y los documentos antes de llamarlo.
// El cirílico sí da términos, pero no hay pistas en esas lenguas: casi siempre
// no pasa el umbral → catálogo entero.
//
// POR QUÉ HAY PALABRAS VACÍAS AQUÍ Y NO EN ACER-CORE. acer-core no usa lista de
// parada a propósito: sobre cientos de líneas de historial la IDF endógena hunde
// solas las palabras ubicuas. Aquí el corpus son SIETE documentos, y con siete
// la IDF no llega a hundirlas: «una», «que», «con», «las» aportan ~0,4 cada una y
// se suman. En el banco, «hazme una app con las fotos de gatos que encuentres»
// daba skill 4,13 por delante de web, solo porque las descripciones de skill son
// las más largas y están llenas de esas palabras. Se filtran de la CONSULTA —el
// BM25 solo suma términos de la consulta—, sin tocar acer-core.
import { buildBM25, terms } from './acer-core.js';

// Cómo lo PIDE la gente, no cómo se llama la herramienta. El catálogo dice
// «Programar una tarea futura»; nadie escribe eso, escribe «recuérdame» o
// «avísame dentro de media hora». Sin estas palabras el BM25 solo acierta cuando
// el usuario habla igual que el catálogo. Español e inglés, que son las dos más
// usadas; el resto de lenguas latinas casan en parte por las descripciones, y lo
// que no casa cae al catálogo entero. Se escriben con tildes o sin ellas: se
// pliegan igual que la consulta.
export const PISTAS = {
  fs: 'archivo archivos fichero ficheros carpeta carpetas documento documentos disco directorio ruta leer lee léeme abrir guardar guarda escribir escribe copiar copia mover pdf txt csv excel xlsx descargas automatización vigilar file files folder folders directory read open save write copy',
  app: 'app apps aplicación aplicaciones hazme haz crea créame crear construye juego juegos reloj calculadora temporizador pomodoro contador tablero panel dibuja dibujo animación animado visualiza gráfico interfaz make build game timer clock calculator tracker dashboard draw',
  vault: 'secreto secretos contraseña contraseñas clave claves password passwords token tokens api key cifrado cifrada seguro segura vault secret credentials',
  tasks: 'recuérdame recordatorio recordatorios avísame avisa aviso avisos alarma programa programar programado tarea tareas minutos minuto hora horas mañana luego después dentro cancela cancelar remind reminder reminders alarm schedule scheduled later tomorrow minutes hour',
  web: 'busca buscar búsqueda internet web google navega noticias noticia fotos foto imágenes imagen clima precio cuesta vale página url enlace última últimas actualidad ganador search find images photos pictures news weather price page link online',
  skill: 'skill skills habilidad habilidades instrucciones enséñate aprende especialízate guion copiloto automatiza rol personalidad comportamiento teach learn behave',
  memory: 'recuerda recordar acuérdate olvida olvidar olvides memoria sabes soy llamo gustos prefiero odio alérgico remember forget memory prefer allergic',
};

// Solo palabras funcionales (artículos, preposiciones, pronombres, auxiliares),
// ya plegadas. Ninguna palabra de contenido: «todo» se queda fuera a propósito,
// porque en inglés es «todo list».
export const VACIAS = new Set((
  'de la el en los las un una unos unas que se del al por con para lo le les me te nos os mi tu su sus ' +
  'es son era eran esta estan este esto ese esa eso esos esas como mas pero ni si no ya muy tambien ' +
  'donde cuando quien cual cuales hay ha he han has sin sobre entre hasta desde ' +
  'the an and or of to in on at for with by from is are was were be been it its this that these those ' +
  'my your you we they he she his her as but not do does did can will would should could have had ' +
  'just about into over up out so than then there their what which who whom when where how ' +
  'le les des du une et dans pour sur avec est il elle je nous vous qui ' +
  'os as do da dos das um uma em no na nas com ' +
  'lo gli di della che els amb ' +
  'der die das und ein eine von zu mit ist den dem des fur auf mir mich'
).split(/\s+/).filter(Boolean));

export const DEFAULTS = {
  // Puntuación mínima de la mejor familia para fiarse. Con 7 documentos, un
  // término que solo aparece en una familia aporta ~1,6 y uno que aparece en
  // dos, ~1,1; uno repartido en tres ya no llega. O sea: hace falta al menos
  // una palabra que distinga de verdad.
  umbral: 1.0,
  // Se suman las familias que puntúan al menos la mitad que la mejor: cubre las
  // peticiones compuestas («busca recetas y guárdalas») y las ambiguas
  // («recuerda» es memoria; «recuérdame en diez minutos», tareas).
  ratio: 0.5,
  maxFamilias: 3,
  // Normalización por longitud floja: los documentos no son texto natural sino
  // descriptores escritos a mano, y castigar a fs por tener 8 herramientas no
  // tiene sentido.
  b: 0.3,
  // Filtrar palabras vacías de la consulta (ver arriba). Medido en el banco
  // CIEGO —60 casos que escribió un modelo sin ver las pistas—: 46/60 → 56/60.
  // Ojo a POR QUÉ mejora: sin el filtro, las palabras vacías empujaban por encima
  // del umbral peticiones sin señal real, y el recuperador elegía seguro y MAL.
  // Con el filtro esas peticiones caen al catálogo entero (del 13 % al 38 % de las
  // veces). Cambia errores silenciosos por respaldos honestos y lo paga en ahorro
  // (del 55 % al 49 %). Es el cambio correcto aunque ahorre menos.
  vacias: true,
  // Familias que se enseñan SIEMPRE, además de las recuperadas. Web, porque las
  // preguntas sobre el mundo son las más comunes y las que menos se marcan: nadie
  // escribe «busca en internet el tiempo», escribe «¿qué tiempo hará?». Cuesta
  // 58 tokens y en el banco ciego suma: 56/60 → 57/60. Y la regla 5 del prompt ya
  // le promete al modelo que SIEMPRE puede buscar en internet: enseñarle web es
  // coherente con lo que se le dice.
  siempre: ['web'],
  // Qué hacer cuando hay términos pero ninguna familia pasa el umbral:
  //   'todo' → catálogo entero (por defecto: nunca peor que hoy)
  //   'nada' → solo las familias de `siempre`. Existe para MEDIR su coste, y el
  //            coste es alto: en el banco propio parecía casi gratis (59/61) y
  //            en el ciego se hunde a 44/60, PEOR que no filtrar nada. Falla
  //            peticiones corrientes sin vocabulario de herramienta, como «el
  //            viernes a las nueve pregúntame si mandé el informe».
  sinSenal: 'todo',
};

export const fold = s => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
export const familiaDe = linea => (String(linea).match(/^-\s*([a-z]+)\./) || [])[1] || null;

// lineasCatalogo: las líneas de toolHelp(), «- fs.list(path): Listar archivos…».
// Se reciben de fuera en vez de importar tools/index.js para que esto se pueda
// probar en node: tools/index.js toca localStorage al cargarse.
export function crearRouter(lineasCatalogo, opciones = {}) {
  const o = { ...DEFAULTS, ...opciones };
  const porFamilia = new Map();
  for (const l of lineasCatalogo) {
    const f = familiaDe(l);
    if (!f) continue;
    if (!porFamilia.has(f)) porFamilia.set(f, []);
    porFamilia.get(f).push(l);
  }
  const familias = [...porFamilia.keys()];
  const docs = familias.map(f => fold(`${f} ${porFamilia.get(f).join(' ')} ${PISTAS[f] || ''}`));
  // Sin raíces: aquí confunden familias vecinas (ver terms() en acer-core).
  const bm = buildBM25(docs, { b: o.b, raices: false });

  // ademas: familias extra que hay que enseñar en ESTA consulta (p. ej. las que
  // nombran las skills instaladas). Solo se añaden cuando hay recuperación: con
  // null ya va el catálogo entero.
  function rutear(consulta, { ademas = [] } = {}) {
    const brutos = terms(fold(consulta), { raices: false });
    if (!brutos.length) return null;                   // alfabeto que el BM25 no ve
    const qt = o.vacias ? brutos.filter(t => !VACIAS.has(t)) : brutos;
    const puntuaciones = familias
      .map((familia, i) => ({ familia, s: qt.length ? bm.scoreDoc(i, qt) : 0 }))
      .sort((a, b) => b.s - a.s);
    const mejor = puntuaciones[0]?.s || 0;
    let elegidas;
    if (mejor < o.umbral) {
      if (o.sinSenal !== 'nada') return null;
      elegidas = [];
    } else {
      elegidas = puntuaciones.filter(p => p.s >= mejor * o.ratio).slice(0, o.maxFamilias).map(p => p.familia);
    }
    for (const f of [...o.siempre, ...ademas]) if (porFamilia.has(f) && !elegidas.includes(f)) elegidas.push(f);
    return { familias: elegidas, lineas: elegidas.flatMap(f => porFamilia.get(f)), puntuaciones };
  }

  return { rutear, familias, porFamilia };
}

// LOS EJEMPLOS DEL PROMPT VIAJAN CON SU FAMILIA. Recortado el catálogo, lo más
// caro que quedaba del prompt fijo eran cinco ejemplos que iban siempre: 291
// tokens, y solo el de skill.create pesa 129. Un ejemplo de una herramienta que
// el modelo no ve no le enseña a usar ninguna de las que sí ve, y puede tentarle
// a llamar a la que no está. Así que van con su familia: si el recuperador
// enseña web y tasks, van los ejemplos de web y de tasks.
//
// Con null —el recuperador dudó y va el catálogo entero— van los cinco, en el
// mismo orden y con el mismo texto de antes, byte a byte.
//
// La familia se lee del propio ejemplo («"tool": "web.images"») y no de una
// etiqueta aparte, que se desincronizaría el día que alguien cambie el ejemplo.
// Viven aquí y no en agent.js porque los bancos de tests/ los necesitan en node.
export const EJEMPLOS = [
  'Usuario: busca fotos de perros\nTú:\n```tool\n{"tool": "web.images", "args": {"query": "perros"}}\n```',
  'Usuario: busca en internet quién ganó la Champions 2026\nTú:\n```tool\n{"tool": "web.search", "args": {"query": "ganador Champions 2026"}}\n```',
  'Usuario: créame una skill para revisar mis finanzas cada mes\nTú:\n```tool\n{"tool": "skill.create", "args": {"name": "Revisor de finanzas", "description": "Ayuda a revisar finanzas mensuales", "instructions": "Cuando el usuario hable de finanzas: 1) pide o lee su archivo de gastos, 2) resume ingresos/gastos por categoría, 3) señala gastos inusuales, 4) propone un ahorro. Sé concreto y usa tablas."}}\n```',
  'Usuario: ¿qué archivos tengo?\nTú:\n```tool\n{"tool": "fs.list", "args": {}}\n```',
  'Usuario: recuérdame en 10 minutos beber agua\nTú:\n```tool\n{"tool": "tasks.add", "args": {"inMinutes": 10, "prompt": "beber agua"}}\n```',
  // Memoria (v2): un hecho corto, en tercera persona, y solo porque el usuario
  // lo pide. Va detrás del de tareas para que «recuérdame en 10 minutos» y
  // «recuerda que» se vean juntos y se distingan.
  'Usuario: recuerda que soy alérgica a los frutos secos\nTú:\n```tool\n{"tool": "memory.save", "args": {"fact": "Es alérgica a los frutos secos"}}\n```',
];
const familiaEjemplo = e => (e.match(/"tool":\s*"([a-z]+)\./) || [])[1];

// lineas: las que va a ver el modelo (rutear().lineas), o null si va el catálogo
// entero. Devuelve el bloque listo para el prompt, o '' si no queda ninguno.
export function bloqueEjemplos(lineas) {
  const vistas = lineas && new Set(lineas.map(familiaDe));
  const elegidos = vistas ? EJEMPLOS.filter(e => vistas.has(familiaEjemplo(e))) : EJEMPLOS;
  return elegidos.length ? `\n\nEjemplos:\n${elegidos.join('\n')}` : '';
}
