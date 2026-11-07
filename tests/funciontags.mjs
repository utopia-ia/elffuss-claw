// Guardia: las etiquetas <function> no pueden estropear lo que escribe el modelo.
// ─────────────────────────────────────────────────────────────────────────────
// El parser recortaba cada <param> y, si el valor parecía JSON, lo parseaba. En
// producción desde b7d7db0, con MiniCPM5 ofrecido en la app. Tres daños:
//
//   · un fichero de `fs.write` o un HTML de `app.create` pierden la sangría de
//     la primera línea y el salto final;
//   · un valor entrecomillado pierde las comillas, y un contenido que parece
//     JSON llega como OBJETO —y quien lo escribe espera texto—;
//   · `vault.set.secret`: un secreto recortado o parseado se corrompe de una
//     forma que el usuario no puede depurar.
//
// Y un cuarto que aparece al ARREGLAR los otros tres: `skill.edit.append` es un
// booleano que funcionaba por accidente, porque `JSON.parse` convertía
// "true"/"false". Sin ese parseo, la cadena "false" sería verdadera y la skill
// se añadiría en vez de reemplazarse. Por eso el contrato tiene tres clases y no
// dos: quitar el parseo a ciegas rompía esto.
//
// `localStorage` se simula porque el árbol de módulos de Claw lo toca al
// importar; así esta guardia corre en Node y no pelea por la GPU con nadie.
const almacen = new Map();
globalThis.localStorage = {
  getItem: (k) => (almacen.has(k) ? almacen.get(k) : null),
  setItem: (k, v) => almacen.set(k, String(v)),
  removeItem: (k) => almacen.delete(k),
  clear: () => almacen.clear(),
  key: (i) => [...almacen.keys()][i] ?? null,
  get length() { return almacen.size; },
};

const { parseFunctionTags } = await import('../web/js/agent.js');
const { TOOLS, PARAM_EXACTO, PARAM_NUMERO, PARAM_BOOLEANO } = await import('../web/js/tools/index.js');

let fallos = 0;
const ok = (n, c, e = '') => { console.log((c ? '✅' : '❌') + ' ' + n + (e ? '  — ' + e : '')); if (!c) fallos++; };
const uno = (t) => parseFunctionTags(t)[0] || { tool: null, args: {} };
const ver = (s) => JSON.stringify(s);

// ── 1. El contenido de un fichero, tal cual.
const CUERPO = '  const a = 1\nexport { a }\n';
let c = uno(`<function name="fs.write"><param name="path">a.js</param><param name="content">${CUERPO}</param></function>`);
ok('1 · content conserva la sangría de la 1ª línea y el \\n final', c.args.content === CUERPO, ver(c.args.content));

// ── 2. Un HTML de app.create, igual: la primera línea importa.
const HTML = '  <!doctype html>\n  <h1>Hola</h1>\n';
c = uno(`<function name="app.create"><param name="name">demo</param><param name="html">${HTML}</param></function>`);
ok('2 · el html de app.create llega íntegro', c.args.html === HTML, ver(c.args.html));

// ── 3. Un contenido que PARECE JSON sigue siendo texto.
const JSONF = '{\n  "a": 1\n}\n';
c = uno(`<function name="fs.write"><param name="path">p.json</param><param name="content">${JSONF}</param></function>`);
ok('3 · un contenido con forma de JSON llega como TEXTO',
   typeof c.args.content === 'string' && c.args.content === JSONF, `${typeof c.args.content} ${ver(c.args.content)}`);

// ── 4. Un secreto, byte a byte: es lo que peor falla si se toca.
const SECRETO = '  sk-ABC "con comillas" y espacio final  ';
c = uno(`<function name="vault.set"><param name="name">api</param><param name="secret">${SECRETO}</param></function>`);
ok('4 · un secreto del vault llega EXACTO', c.args.secret === SECRETO, ver(c.args.secret));

// ── 5. El booleano se convierte de verdad, y "false" es falso.
c = uno('<function name="skill.edit"><param name="name">x</param><param name="instructions">y</param><param name="append">false</param></function>');
ok('5 · append="false" es FALSO (sin esto, la skill se añade en vez de reemplazarse)',
   c.args.append === false, ver(c.args.append));
c = uno('<function name="skill.edit"><param name="name">x</param><param name="instructions">y</param><param name="append">true</param></function>');
ok('5b · append="true" es verdadero', c.args.append === true, ver(c.args.append));

// ── 6. El numérico, número.
c = uno('<function name="tasks.add"><param name="inMinutes">30</param><param name="prompt">riega</param></function>');
ok('6 · inMinutes es un número', c.args.inMinutes === 30, ver(c.args.inMinutes));
c = uno('<function name="tasks.add"><param name="inMinutes">pronto</param><param name="prompt">x</param></function>');
ok('6b · un numérico no numérico NO se vuelve NaN en silencio', !Number.isNaN(c.args.inMinutes), ver(c.args.inMinutes));

// ── 7. Un escalar sí se recorta.
c = uno('<function name="fs.read"><param name="path">\n  notas.txt\n</param></function>');
ok('7 · path se recorta', c.args.path === 'notas.txt', ver(c.args.path));

// ── 8. CDATA.
c = uno('<function name="fs.write"><param name="path">a.md</param><param name="content"><![CDATA[usa </param> aquí]]></param></function>');
ok('8 · con CDATA el contenido puede llevar </param>', c.args.content === 'usa </param> aquí', ver(c.args.content));

// ── 9. El contrato no puede derivar.
const huerfanos = [];
for (const [mapa, nombre] of [[PARAM_EXACTO, 'PARAM_EXACTO'], [PARAM_NUMERO, 'PARAM_NUMERO'], [PARAM_BOOLEANO, 'PARAM_BOOLEANO']]) {
  for (const [herr, params] of Object.entries(mapa)) {
    if (!TOOLS[herr]) { huerfanos.push(`${nombre}: la herramienta ${herr} no existe`); continue; }
    for (const p of params) if (!(p in TOOLS[herr].params)) huerfanos.push(`${nombre}: ${herr}.${p} no es un parámetro`);
  }
}
ok('9 · cada excepción del contrato apunta a un parámetro real', huerfanos.length === 0, huerfanos.join(' · '));

// ─────────────────────────────────────────────────────────────────────────────
// Lo que encontró el fuzz de T2T el 2026-10-12.

// ── 10. `</function>` dentro de CDATA no cierra la llamada. Sin esto el cuerpo
// llegaba cortado, el <param> del contenido no casaba y `fs.write` escribía un
// fichero VACÍO, porque content vale '' por defecto.
c = uno('<function name="fs.write"><param name="path">q.mjs</param><param name="content">'
  + '<![CDATA[const c = \'<function name="x"></function>\'\n]]></param></function>');
ok('10 · un </function> dentro de CDATA no corta la llamada',
   c.args.content === 'const c = \'<function name="x"></function>\'\n', ver(c.args.content));

// ── 11. Un nombre de herramienta que pisa Object.prototype no tumba el turno.
for (const n of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
  let bien = true, det = '';
  try { parseFunctionTags(`<function name="${n}"><param name="x">1</param></function>`); }
  catch (e) { bien = false; det = e.message; }
  ok(`11 · «${n}» como nombre de herramienta no lanza`, bien, det);
}

// ── 12. Un escalar entrecomillado no se lleva las comillas puestas.
c = uno('<function name="fs.read"><param name="path">"notas/a.txt"</param></function>');
ok('12 · un path entrecomillado no crea una carpeta «"notas»', c.args.path === 'notas/a.txt', ver(c.args.path));
c = uno('<function name="tasks.add"><param name="inMinutes">"30"</param><param name="prompt">x</param></function>');
ok('12b · un numérico entrecomillado sigue siendo número', c.args.inMinutes === 30, ver(c.args.inMinutes));

// ── 13. El valor exacto abierto en su propia línea no mete una línea en blanco.
c = uno('<function name="fs.write"><param name="path">a.js</param><param name="content">\nconst a = 1\n</param></function>');
ok('13 · un content abierto en su línea no empieza el fichero en blanco',
   c.args.content === 'const a = 1\n', ver(c.args.content));
c = uno('<function name="fs.write"><param name="path">a.js</param><param name="content"><![CDATA[\nx\n]]></param></function>');
ok('13b · con CDATA el salto inicial se respeta', c.args.content === '\nx\n', ver(c.args.content));

// ── 14. Y una llamada CITADA dentro de un valor no se ejecuta. En Claw esto ya
// se cumplía —`parseToolCall` devuelve la PRIMERA etiqueta y no llega a la
// pasada de JSON—, pero queda fijado para que un futuro «ejecuta todas» no lo
// rompa en silencio, que es como se rompió en Code.
const { parseToolCall } = await import('../web/js/agent.js');
const DOC = '<function name="fs.write"><param name="path">R.md</param><param name="content">ej:\n'
  + '{"tool":"vault.get","args":{"name":"api"}}\n</param></function>';
const sola = parseToolCall(DOC);
ok('14 · una llamada citada dentro de un <param> NO se ejecuta',
   sola && sola.tool === 'fs.write', sola ? sola.tool : 'nada');

// ─────────────────────────────────────────────────────────────────────────────
// Las dos respuestas del fuzz que estropeaban el valor en las capas de
// RECUPERACIÓN de JSON, no en las etiquetas. Las dos escribían y decían
// «Escrito». En Claw el mismo corte le puede tocar al `html` de `app.create` o
// al `secret` del vault.

// ── 15. Una comilla sin escapar seguida de «, "» parecía el fin del valor.
const C1 = '```tool\n{"tool": "fs.write", "args": {"path": "f.js", "content": "console.log("a", "b")\n"}}\n```';
let r = parseToolCall(C1);
ok('15 · una comilla sin escapar no trunca el valor',
   r?.args?.content === 'console.log("a", "b")\n', ver(r?.args?.content));

// ── 16. Una barra justo antes de un salto REAL (continuación de línea de shell)
// se convertía en barra + la letra «n», y el salto se perdía.
const C2 = '```tool\n{"tool": "fs.write", "args": {"path": "s.sh", "content": "echo one \\\n  two\n"}}\n```';
r = parseToolCall(C2);
ok('16 · una continuación de línea de shell sobrevive',
   r?.args?.content === 'echo one \\\n  two\n', ver(r?.args?.content));

// ── 17. Y lo que NO puede perderse al arreglar lo de arriba: un mensaje cortado
// a media escritura se sigue rechazando. Completarlo sería inventar contenido.
r = parseToolCall('```tool\n{"tool": "fs.write", "args": {"path": "a.js", "content": "empieza y se corta');
ok('17 · un mensaje truncado de verdad NO se recupera', !r?.args?.content, ver(r?.args?.content));

// ── 18-21. La forma de LFM3 (el cerebro de arranque desde el 2-nov-2026), tal cual la escribe su plantilla.
let fs3 = parseFunctionTags('<tool_call>\n<function=image.generate>\n<parameter=prompt>\nA fox in an autumn forest\n</parameter>\n<parameter=aspect>\n1:1\n</parameter>\n</function>\n</tool_call>');
ok('18 · LFM3: <function=…><parameter=…> se lee', fs3.length === 1 && fs3[0].tool === 'image.generate' && fs3[0].args.prompt === 'A fox in an autumn forest' && fs3[0].args.aspect === '1:1', ver(fs3));
r = parseToolCall('<tool_call> <function=image.generate> <parameter=prompt> A fox in an autumn forest </parameter> </function> </tool_call>');
ok('19 · LFM3 en una línea: parseToolCall la ejecuta', r?.tool === 'image.generate' && r?.args?.prompt === 'A fox in an autumn forest', ver(r));
const L3 = 'export const a = 1\n';
fs3 = parseFunctionTags(`<tool_call>\n<function=fs.write>\n<parameter=path>\nsrc/a.js\n</parameter>\n<parameter=content>\n${L3}\n</parameter>\n</function>\n</tool_call>`);
ok('20 · LFM3: el contenido sale exacto (sin los dos saltos de la plantilla)', fs3[0]?.args?.content === L3, ver(fs3[0]?.args?.content));
fs3 = parseFunctionTags('<tool_call>\n<function=fs.write>\n<parameter=path>\na.js\n</parameter>\n<parameter=content>\nse corta');
ok('21 · LFM3: una llamada sin cerrar NO se ejecuta', fs3.length === 0, ver(fs3));

console.log(fallos ? `\n❌ ${fallos} FALLO(S)` : '\n✅ las etiquetas <function> no estropean lo que escribe el modelo');
process.exit(fallos ? 1 : 0);
