// «Modo básico»: cerebro determinista sin modelo — cubre las demos clave sin
// descargar nada. Para lenguaje libre, carga un modelo en el selector de modelo.
// `tr` y no `t`: dentro de chat() `t` es el texto en minúsculas.
import { t as tr, chipEnEspanol } from '../i18n.js';
export const name = 'Básico (sin modelo)';
export async function load() {}

const call = obj => '```tool\n' + JSON.stringify(obj) + '\n```';

const SHELL = (title, body, script) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title}</title><style>
body{font-family:system-ui;background:#0d1117;color:#e6edf3;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;gap:16px}
button{cursor:pointer}
</style></head><body>${body}<script>${script}<\/script></body></html>`;

const APPS = {
  reloj: () => SHELL('Reloj',
    '<h1 id="t" style="font-size:14vw;margin:0;font-variant-numeric:tabular-nums"></h1><p id="d" style="color:#8b949e;font-size:1.2rem"></p>',
    "const f=()=>{const n=new Date();document.getElementById('t').textContent=n.toLocaleTimeString('es-ES');document.getElementById('d').textContent=n.toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long',year:'numeric'})};f();setInterval(f,1000);"),
  notas: () => SHELL('Notas',
    '<h2>📝 Notas</h2><textarea id="n" style="width:82vw;height:60vh;background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:10px;padding:14px;font-size:16px;resize:none" placeholder="Escribe aquí…"></textarea><p id="s" style="color:#8b949e;font-size:.85rem"></p>',
    "let mem={};let store;try{store=localStorage;store.getItem('x')}catch(e){store={getItem:k=>mem[k],setItem:(k,v)=>mem[k]=v}}const n=document.getElementById('n'),s=document.getElementById('s');n.value=store.getItem('elffuss.notas')||'';n.oninput=()=>{store.setItem('elffuss.notas',n.value);s.textContent='guardado '+new Date().toLocaleTimeString('es-ES')};"),
  arte: () => SHELL('Arte',
    '<canvas id="g" style="position:fixed;inset:0;width:100vw;height:100vh"></canvas><p style="position:fixed;bottom:12px;left:0;right:0;text-align:center;color:#8b949e;font-size:.8rem">mueve el ratón ✨</p>',
    "const c=document.getElementById('g'),gl=c.getContext('webgl',{alpha:false});" +
    "const N=9000,S=new Float32Array(N*2);for(let i=0;i<N*2;i++)S[i]=Math.random();" +
    "const vs='attribute vec2 s;uniform float t,a;uniform vec2 m;varying vec3 C;varying float G;" +
    "void main(){float r=0.1+1.2*pow(s.y,0.7);float g=s.x*6.283+r*3.0+t*(0.2+0.4/(r+0.2));" +
    "vec2 p=vec2(cos(g),sin(g))*r;p.y*=0.7;p+=m*(0.05+r*0.08);gl_Position=vec4(p.x/a,p.y,0.,1.);" +
    "float w=0.5+0.5*sin(t*(2.+s.x*4.)+s.y*30.);G=w;" +
    "C=mix(vec3(1.,.3,.55),vec3(.49,.36,1.),smoothstep(.1,1.2,r));gl_PointSize=1.5+3.*w;}';" +
    "const fs='precision mediump float;varying vec3 C;varying float G;" +
    "void main(){float m2=smoothstep(.5,0.,length(gl_PointCoord-.5));gl_FragColor=vec4(C*G,m2*G);}';" +
    "function sh(t2,s2){const x=gl.createShader(t2);gl.shaderSource(x,s2);gl.compileShader(x);return x}" +
    "const P=gl.createProgram();gl.attachShader(P,sh(gl.VERTEX_SHADER,vs));gl.attachShader(P,sh(gl.FRAGMENT_SHADER,fs));" +
    "gl.linkProgram(P);gl.useProgram(P);const B=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,B);" +
    "gl.bufferData(gl.ARRAY_BUFFER,S,gl.STATIC_DRAW);const L=gl.getAttribLocation(P,'s');" +
    "gl.enableVertexAttribArray(L);gl.vertexAttribPointer(L,2,gl.FLOAT,false,0,0);" +
    "gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE);gl.clearColor(0.04,0.05,0.08,1);" +
    "let mx=0,my=0;addEventListener('pointermove',e=>{mx=(e.clientX/innerWidth-.5)*2;my=-(e.clientY/innerHeight-.5)*2});" +
    "(function F(n){c.width=innerWidth;c.height=innerHeight;gl.viewport(0,0,c.width,c.height);" +
    "gl.clear(gl.COLOR_BUFFER_BIT);gl.uniform1f(gl.getUniformLocation(P,'t'),n/1000);" +
    "gl.uniform1f(gl.getUniformLocation(P,'a'),c.width/c.height);gl.uniform2f(gl.getUniformLocation(P,'m'),mx,my);" +
    "gl.drawArrays(gl.POINTS,0,N);requestAnimationFrame(F)})(0);"),
  calculadora: () => SHELL('Calculadora',
    '<div><input id="p" readonly style="width:288px;font-size:1.6rem;text-align:right;background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:10px;padding:10px;margin-bottom:10px;box-sizing:border-box"><div id="k" style="display:grid;grid-template-columns:repeat(4,64px);gap:8px"></div></div>',
    "const p=document.getElementById('p'),k=document.getElementById('k');'789/456*123-0.=+C'.split('').forEach(c=>{const b=document.createElement('button');b.textContent=c;b.style.cssText='font-size:1.3rem;padding:14px;border-radius:10px;border:1px solid #30363d;background:#21262d;color:#e6edf3';b.onclick=()=>{if(c==='C')p.value='';else if(c==='='){try{p.value=/^[-+*/.() 0-9]+$/.test(p.value)?String(Function('return ('+p.value+')')()):'error'}catch(e){p.value='error'}}else p.value+=c};k.appendChild(b)});"),
};

// CSV → app de gráfico de barras (canvas, sin librerías): primera columna =
// etiqueta, primera columna numérica = valor.
function chartApp(fileName, csv) {
  const lines = csv.trim().split(/\r?\n/).filter(l => l.trim() && !l.startsWith('['));
  const rows = lines.map(l => l.split(/[,;\t]/).map(c => c.trim()));
  const head = rows.shift() || [];
  let valCol = head.findIndex((_, i) =>
    i > 0 && rows.length && rows.every(r => r[i] !== undefined && r[i] !== '' && !isNaN(parseFloat(r[i]))));
  if (valCol < 1) valCol = 1;
  const data = rows.slice(0, 24).map(r => ({ label: r[0], value: parseFloat(r[valCol]) || 0 }));
  return SHELL('Gráfico ' + fileName,
    `<h2 style="margin:10px">📊 ${fileName}${head[valCol] ? ' — ' + head[valCol] : ''}</h2><canvas id="c" width="760" height="430" style="max-width:94vw"></canvas>`,
    `const data=${JSON.stringify(data)};const c=document.getElementById('c'),x=c.getContext('2d');
const W=c.width,H=c.height,p=48,max=Math.max(...data.map(d=>d.value))||1,bw=(W-p*2)/data.length;
x.strokeStyle='#30363d';x.beginPath();x.moveTo(p,12);x.lineTo(p,H-p);x.lineTo(W-12,H-p);x.stroke();
data.forEach((d,i)=>{const h=(H-p-24)*d.value/max,bx=p+8+i*bw;
const g=x.createLinearGradient(0,H-p-h,0,H-p);g.addColorStop(0,'#ff4d8d');g.addColorStop(1,'#7c5cff');
x.fillStyle=g;x.fillRect(bx,H-p-h,Math.max(bw-16,4),h);
x.fillStyle='#e6edf3';x.font='12px system-ui';x.textAlign='center';
x.fillText(String(d.value),bx+(bw-16)/2,H-p-h-7);
x.save();x.translate(bx+(bw-16)/2,H-p+13);x.rotate(.5);x.fillStyle='#8b949e';x.textAlign='left';
x.fillText(String(d.label).slice(0,14),0,0);x.restore();});`);
}

const generic = desc => SHELL('Boceto',
  `<div style="max-width:560px;text-align:center;padding:20px"><h2>✳ Boceto de app</h2><p style="color:#8b949e">Esto es un boceto del modo básico. Pediste:</p><blockquote style="background:#161b22;border-left:3px solid #ff4d8d;padding:12px;border-radius:8px;text-align:left">${desc.replace(/</g, '&lt;')}</blockquote><p style="color:#8b949e">Carga un modelo (en el selector de modelo, arriba) y Elffuss generará esta app de verdad, a medida.</p></div>`, '');

// La ayuda va en el idioma de la página (i18n: basicHelp). Las órdenes que
// entiende este motor son en español, y en inglés se dice así, con su traducción
// al lado. (El selector de modelo es el desplegable de la cabecera; 🧠 es la
// Mente. El enlace #/modelo lo enfoca: ver rutas.js.)
const HELP = () => tr('basicHelp');

export async function chat(history) {
  const last = history[history.length - 1];
  // Una sugerencia de la página (chip) en otro idioma se entiende como la misma
  // en español, que es como entiende las órdenes este motor. Solo el texto exacto
  // de una sugerencia: lo que se escribe a mano sigue tal cual.
  const text = (chipEnEspanol(last?.content) || last?.content || '').trim();

  // Tras una herramienta: convertir su resultado en la respuesta…
  if (text.startsWith('[resultado')) {
    const body = text.slice(text.indexOf('\n') + 1).trim();
    if (body.startsWith('ERROR:')) return tr('basicCouldNot', { err: body.slice(6).trim() });
    // …o encadenar: si lo leído era para un gráfico, generar la app ahora.
    if (text.startsWith('[resultado fs.read')) {
      const prevUser = [...history].reverse().find(m => m.role === 'user' && !m.content.startsWith('['));
      if (prevUser && /(grafic|visualiza|gr[aá]fico|chart|barras)/i.test(prevUser.content)) {
        const file = prevUser.content.match(/(\S+\.(?:csv|tsv|xlsx?))/i)?.[1] || 'datos';
        return call({ tool: 'app.create', args: { name: 'gráfico ' + file, html: chartApp(file, body) } });
      }
    }
    return body;
  }

  const t = text.toLowerCase();

  // web (antes que «abre <app>» para que gane la URL)
  const url = text.match(/https?:\/\/[^\s"'<>]+/);
  if (url && /(abre|visita|entra|descarga|mira|lee|busca|ve a)/.test(t))
    return call({ tool: 'web.fetch', args: { url: url[0] } });

  // crear skill (modo básico: plantilla a partir de la descripción)
  const mSkill = text.match(/(?:cr[eé]a(?:me)?|hazme|genera)\s+una\s+skill\s+(?:para|de|que)\s+(.+)/i);
  if (mSkill) {
    const what = mSkill[1].replace(/[?.!]+$/, '').trim();
    return call({ tool: 'skill.create', args: { name: what.slice(0, 40), description: 'Skill para ' + what,
      instructions: 'Cuando el usuario pida «' + what + '», ayúdale paso a paso, sé concreto y usa las herramientas disponibles (archivos, web, apps) cuando aporten.' } });
  }
  if (/(lista|ver|muestra|qué|que).*skills/.test(t)) return call({ tool: 'skill.list', args: {} });

  // búsqueda de imágenes
  const mImg = text.match(/(?:busca(?:r)?|encuentra|ens[eé]ñame|muestra|quiero)\b.*?\b(?:fotos?|im[aá]genes?|gr[aá]ficos?|dibujos?|fotograf[ií]as?)\s+(?:de\s+)?(.+)/i);
  if (mImg && !url) return call({ tool: 'web.images', args: { query: mImg[1].replace(/[?.!]+$/, '').trim() } });
  // búsqueda web (texto)
  const mSearch = text.match(/(?:busca(?:r)?|buscame|google(?:a)?|encuentra|investiga)\s+(?:en\s+(?:internet|la\s+web|google)\s+)?(.+)/i);
  if (mSearch && !url && /(busca|google|encuentra|investiga)/.test(t))
    return call({ tool: 'web.search', args: { query: mSearch[1].replace(/[?.!]+$/, '').trim() } });

  // tareas
  const mTask = text.match(/dentro de (\d+)\s*min(?:uto)?s?\s*(?:que\s*)?(.*)/i);
  if (mTask && /(recu[eé]rdame|av[ií]same|programa|dentro de \d+ *min)/.test(t))
    return call({ tool: 'tasks.add', args: { inMinutes: Number(mTask[1]), prompt: mTask[2].trim() || text } });
  if (/(lista|ver|muestra|qué|que).*(tareas)/.test(t) || t === 'tareas')
    return call({ tool: 'tasks.list', args: {} });

  // memoria persistente
  const mRemember = text.match(/\brecuerda (?:que )?(.+)/i);
  if (mRemember) return call({ tool: 'memory.save', args: { fact: mRemember[1].trim() } });
  if (/(qué|que) recuerdas|tu memoria|mis recuerdos/.test(t))
    return call({ tool: 'memory.list', args: {} });
  const mForget = text.match(/\bolvida (?:el )?(m[a-z0-9]{4,10})\b/i);
  if (mForget) return call({ tool: 'memory.forget', args: { id: mForget[1] } });
  // «olvida (que) X» por el texto: la memoria busca el hecho y pregunta con una
  // tarjeta antes de olvidar nada (memoria v2). Con la v1 solo se olvidaba por id.
  const mForgetTexto = text.match(/^(?:olvida|olv[ií]date de|forget)(?:\s+(?:que|that))?\s+(.+)/i);
  if (mForgetTexto) return call({ tool: 'memory.forget', args: { query: mForgetTexto[1].replace(/[?.!]+$/, '').trim() } });

  // vault
  const mSecret = text.match(/guarda (?:el |la )?(?:secreto|contraseña) ([\w.@-]+)\s*[:=]\s*(\S+)/i);
  if (mSecret) return call({ tool: 'vault.set', args: { name: mSecret[1], secret: mSecret[2] } });
  if (/(lista|ver|muestra).*(secretos|contraseñas)/.test(t))
    return call({ tool: 'vault.list', args: {} });
  const mGet = text.match(/(?:dame|lee|cu[aá]l es) (?:el |la )?(?:secreto|contraseña)(?: de)? ([\w.@-]+)/i);
  if (mGet) return call({ tool: 'vault.get', args: { name: mGet[1] } });

  // datos → gráfico (lee el archivo; el [resultado] de arriba crea la app)
  const mViz = text.match(/(?:grafica|graficar|visualiza|visualizar|gr[aá]fico|chart|barras)\b.*?(\S+\.(?:csv|tsv|xlsx?))/i);
  if (mViz) return call({ tool: 'fs.read', args: { path: mViz[1] } });

  // automatización entre carpetas
  const mWatch = text.match(/(?:vigila|automatiza|observa|monitoriza|cuando\s+(?:deje|ponga|caiga)\s+(?:un\s+)?(?:archivo|fichero)?\s*(?:en)?)\s+(?:la\s+carpeta\s+)?([\w.-]+).*?\b(?:en|a|hacia)\s+(?:la\s+carpeta\s+)?([\w.-]+)/i);
  if (mWatch && /(vigila|automatiza|observa|monitoriza|cuando)/.test(t) && /(procesa|deja|salida|convierte|→|copia)/.test(t))
    return call({ tool: 'fs.watch', args: { from: mWatch[1], to: mWatch[2] } });
  if (/(lista|ver|muestra|qué|que).*(automatizaciones|vigilancias)/.test(t))
    return call({ tool: 'fs.watch_list', args: {} });

  // copia one-shot entre carpetas
  const mCopy = text.match(/copia(?:r)?\s+(?:todos\s+)?(?:los\s+)?([\w*.]+)\s+de\s+([\w.-]+)\s+a\s+([\w.-]+)/i);
  if (mCopy) {
    let pattern = mCopy[1];
    if (!pattern.includes('*')) pattern = '*' + (pattern.startsWith('.') ? pattern : '.' + pattern);
    return call({ tool: 'fs.copy', args: { pattern, from: mCopy[2], to: mCopy[3] } });
  }

  // archivos
  if (/(autoriza|elige|selecciona|añade|conecta).*(carpeta|directorio)/.test(t))
    return call({ tool: 'fs.pick_folder', args: {} });
  if (/(lista|muestra|qué hay|que hay|enséñame|ver).*(archivos|ficheros|carpeta|directorio)/.test(t))
    return call({ tool: 'fs.list', args: {} });
  const mRead = text.match(/lee (?:el (?:archivo|fichero) )?([\w./ -]+\.\w+)/i);
  if (mRead) return call({ tool: 'fs.read', args: { path: mRead[1].trim() } });
  const mWrite = text.match(/escribe (?:en )?([\w./-]+\.\w+)\s*[:=]\s*([\s\S]+)/i);
  if (mWrite) return call({ tool: 'fs.write', args: { path: mWrite[1], content: mWrite[2] } });

  // apps
  if (/(crea|hazme|haz|genera|quiero|móntame|montame)/.test(t) || /^(reloj|notas|calculadora)$/.test(t)) {
    const kind = /reloj|hora/.test(t) ? 'reloj' : /nota/.test(t) ? 'notas' : /calcul/.test(t) ? 'calculadora'
      : /(arte|part[ií]culas|galaxia|aurora|webgl)/.test(t) ? 'arte' : null;
    if (kind) return call({ tool: 'app.create', args: { name: kind, html: APPS[kind]() } });
    if (/(app|aplicaci|web|página|pagina|juego|dashboard|panel)/.test(t))
      return call({ tool: 'app.create', args: { name: 'boceto', html: generic(text) } });
  }
  const mOpen = t.match(/abre (?:la app )?([\wáéíóúñ-]+)/);
  if (mOpen && !url) return call({ tool: 'app.open', args: { name: mOpen[1] } });
  if (/(lista|ver|muestra|qué|que).*apps/.test(t)) return call({ tool: 'app.list', args: {} });

  if (/^(hola|buenas|hey|hi)\b/.test(t)) return tr('basicHi') + HELP();
  return HELP();
}
