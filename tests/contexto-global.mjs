// Que Claw use la conversación entera, y que una skill de internet se pueda instalar.
// ─────────────────────────────────────────────────────────────────────────────
// Tres fallos del arnés que se veían juntos en una sesión real con Gemma E4B
// (LiteRT): «usa poco el historial y no conecta el contexto global».
//   1. El estado vivo (CONTEXTO AHORA) se mandaba en CADA paso y, como LiteRT
//      guarda lo enviado en su KV, la conversación se llenaba de volcados de
//      estado y se compactaba antes de tiempo. Ahora solo va cuando cambia.
//   2. La conversación se reconocía por los primeros 200 caracteres del sistema;
//      las skills van al final, así que instalar una no llegaba al modelo.
//   3. Al compactar, el HTML de cada app competía con lo que dijo el usuario por
//      el mismo presupuesto. Ahora la app entra como una línea.
// Y 4: skill.install sabe leer las URLs que da una búsqueda (GitHub, skills.sh…).
//
// Sin GPU ni navegador: motor de mentira, como tests/litert-conversacion.mjs.
//   node tests/contexto-global.mjs
globalThis.__ELFFUSS_PRUEBAS__ = true;
const L = await import('../web/js/providers/litert.js');
const { resolverUrlSkill } = await import('../web/js/skills.js');

let fallos = 0;
const ok = (nombre, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${nombre}${extra ? '  — ' + extra : ''}`);
  if (!cond) fallos++;
};

function motor() {
  const conversaciones = [];
  return {
    conversaciones,
    async createConversation(cfg) {
      const c = {
        sistema: cfg.preface.messages.map(m => m.content).join('\n'), enviados: [],
        async getTokenCount() { return 50; },
        async delete() { this.borrada = true; },
        sendMessageStreaming(texto) {
          this.enviados.push(texto);
          return (async function* () { yield { content: [{ type: 'text', text: 'vale' }] }; })();
        },
      };
      conversaciones.push(c);
      return c;
    },
  };
}
const efimero = (content) => Object.defineProperty({ role: 'user', content }, 'efimero', { value: true });
const SISTEMA = 'Eres Elffuss: '.padEnd(200, '·') + '\nreglas…';

// 1. El estado vivo solo se manda cuando cambia.
{
  const m = motor(); L.__usarMotor(m, 32768);
  const h = [{ role: 'user', content: 'hazme un reloj' }];
  await L.chat([efimero('CONTEXTO AHORA\nApps: ninguna'), ...h], SISTEMA, () => {});
  h.push({ role: 'assistant', content: 'vale' }, { role: 'user', content: '[resultado app.create]\nhecho' });
  await L.chat([...h.slice(0, -1), efimero('CONTEXTO AHORA\nApps: ninguna'), h.at(-1)], SISTEMA, () => {});
  h.push({ role: 'assistant', content: 'vale' }, { role: 'user', content: 'ahora un calendario' });
  await L.chat([...h.slice(0, -1), efimero('CONTEXTO AHORA\nApps: reloj'), h.at(-1)], SISTEMA, () => {});
  const c = m.conversaciones[0];
  ok('una sola conversación en los tres pasos', m.conversaciones.length === 1, `${m.conversaciones.length}`);
  ok('el primer envío lleva el estado', /Apps: ninguna/.test(c.enviados[0]), JSON.stringify(c.enviados[0]));
  ok('el segundo, con el MISMO estado, no lo repite', !/CONTEXTO AHORA/.test(c.enviados[1]) && /\[resultado app\.create\]/.test(c.enviados[1]), JSON.stringify(c.enviados[1]));
  ok('el tercero, con el estado cambiado, sí lo lleva', /Apps: reloj/.test(c.enviados[2]) && /calendario/.test(c.enviados[2]), JSON.stringify(c.enviados[2]));
}

// 2. Una skill instalada a mitad de conversación llega al modelo.
{
  const m = motor(); L.__usarMotor(m, 32768);
  const h = [{ role: 'user', content: 'hola' }];
  await L.chat(h, SISTEMA, () => {});
  h.push({ role: 'assistant', content: 'vale' }, { role: 'user', content: 'mejora la interfaz' });
  const conSkill = SISTEMA + '\n\nSKILLS INSTALADAS — impeccable';
  await L.chat(h, conSkill, () => {});
  ok('con el sistema cambiado AL FINAL se rehace la conversación', m.conversaciones.length === 2, `${m.conversaciones.length}`);
  ok('  …y la nueva lleva la skill', /SKILLS INSTALADAS — impeccable/.test(m.conversaciones.at(-1)?.sistema || ''));
  ok('  …y lo hablado antes (en el prefacio)', /hola/.test(m.conversaciones.at(-1)?.sistema || ''));
  ok('  …y la vieja se borra', m.conversaciones[0].borrada === true);
}

// 3. Al compactar, una app entra como una línea y lo que dijo el usuario se queda.
{
  const m = motor(); L.__usarMotor(m, 32768);
  const html = '<!doctype html><html><head><title>Plan de comidas</title></head><body>' + 'x'.repeat(8000) + '</body></html>';
  const h = [
    { role: 'user', content: 'somos 4: mi chica, yo y dos hijos; dieta normal' },
    { role: 'assistant', content: '```tool\n{"tool":"app.create","args":{"name":"plan_comidas","html":' + JSON.stringify(html) + '}}\n```' },
    { role: 'user', content: '[resultado app.create]\nApp creada' },
    { role: 'assistant', content: '```html\n' + html + '\n```' },
    { role: 'user', content: 'añade la merienda' },
  ];
  await L.chat(h, SISTEMA, () => {});
  const s = m.conversaciones[0]?.sistema || '';
  ok('el prefacio no lleva el HTML de las apps', !/xxxxxxxxxx/.test(s), `${s.length} caracteres`);
  ok('  …sino una línea por app («creé la app …»)', /creé la app «plan_comidas»/.test(s) && /creé la app «Plan de comidas»/.test(s), s.slice(-300));
  ok('  …y conserva lo que dijo el usuario', /somos 4: mi chica, yo y dos hijos/.test(s));
}

// 4. Las URLs de skills que da una búsqueda.
{
  const casos = [
    ['https://github.com/pbakaus/impeccable', { repo: 'pbakaus/impeccable' }],
    ['https://github.com/pbakaus/impeccable/blob/main/.claude/skills/impeccable/SKILL.md', { repo: 'pbakaus/impeccable', branch: 'main', path: '.claude/skills/impeccable/SKILL.md' }],
    ['https://github.com/anthropics/skills/tree/main/skills/pdf', { repo: 'anthropics/skills', branch: 'main', path: 'skills/pdf/SKILL.md' }],
    ['https://raw.githubusercontent.com/o/r/main/a/SKILL.md', { repo: 'o/r', branch: 'main', path: 'a/SKILL.md' }],
    ['https://www.skills.sh/pbakaus/impeccable/impeccable', { repo: 'pbakaus/impeccable', name: 'impeccable' }],
    ['https://www.ui-skills.com/skills/pbakaus/impeccable', { repo: 'pbakaus/impeccable', name: null }],
    ['https://impeccable.style/', null],
    ['no es una url', null],
  ];
  for (const [url, esperado] of casos) {
    const r = resolverUrlSkill(url);
    const bien = esperado === null ? r === null : r && Object.entries(esperado).every(([k, v]) => r[k] === v);
    ok(`URL de skill: ${url}`, bien, JSON.stringify(r));
  }
}

console.log(fallos ? `\n❌ ${fallos} fallo(s)` : '\n✅ todo bien');
process.exit(fallos ? 1 : 0);
