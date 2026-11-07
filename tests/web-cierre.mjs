// When a turn closes on web results (the model repeats the call, or runs out of steps), Claw says one sentence and
// the sources, never the page text the tools gave the model (measured with LFM3 in elffuss.com's chat, which has
// the same close). In Node, no GPU:  node tests/web-cierre.mjs
const almacen = new Map();
globalThis.localStorage = { getItem: (k) => almacen.get(k) ?? null, setItem: (k, v) => almacen.set(k, String(v)), removeItem: (k) => almacen.delete(k), clear: () => almacen.clear(), key: () => null, get length() { return almacen.size; } };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'es-ES' }, configurable: true });
const { closingLine, fuentesDe } = await import('../web/js/agent.js');
let fails = 0;
const ok = (n, c, x = '') => { console.log((c ? '✅ ' : '❌ ') + n + (c ? '' : '  — ' + String(x).slice(0, 300))); if (!c) fails++; };

const busqueda = 'Resultados de la web para «site:aemet.es olas de calor»:\n\n• España registra 61 días bajo ola de calor\n  https://www.aemet.es/es/noticias/2026/09/olas_de_calor_2026\n  09/09/2026 Se han repartido…\n\n• Olas de calor en España desde 1975\n  https://www.aemet.es/es/conocermas/olascalor\n\nLo que dicen las primeras páginas:\n[https://www.aemet.es/es/noticias/2026/09/olas_de_calor_2026] España registra 61 días\n§ Verano\nEl verano de 2026 ha sido el más cálido…';
const pagina = '[https://es.wikipedia.org/wiki/Alhambra] Alhambra - Wikipedia\nLo más relevante para la pregunta (3 de 70 fragmentos):\n§ Historia\nLa Alhambra es…';
const f = fuentesDe(busqueda);
ok('las fuentes de una búsqueda: sus resultados, sin repetir', f.length === 2 && f[0].url === 'https://www.aemet.es/es/noticias/2026/09/olas_de_calor_2026' && f[0].title === 'España registra 61 días bajo ola de calor', JSON.stringify(f));
ok('la fuente de una página leída', fuentesDe(pagina)[0]?.url === 'https://es.wikipedia.org/wiki/Alhambra' && /Alhambra - Wikipedia/.test(fuentesDe(pagina)[0].title));
const cierre = closingLine([], busqueda, f);
ok('el cierre sobre resultados web: una frase y las fuentes, nunca el texto de la página', /^Esto es lo que he encontrado; puedes leerlo en estas fuentes:\n- \[España registra 61 días bajo ola de calor\]\(https:\/\/www\.aemet\.es\//.test(cierre) && !/§|Lo que dicen/.test(cierre), cierre);
ok('sin fuentes, el cierre de siempre', closingLine([], 'Hecho: app creada', []) === 'Hecho: app creada' && closingLine([], 'ERROR: x', []) === 'Hecho. ¿Algo más?');
console.log(fails ? `\n❌ ${fails} FALLO(S)` : '\n✅ CIERRE WEB: una frase y las fuentes');
process.exit(fails ? 1 : 0);
