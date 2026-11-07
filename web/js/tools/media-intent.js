// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
// Whether a turn needs the media tools in its prompt, decided before the turn with rules, never with a model call.
// The same file is in the chat (elffuss-home site-chat/chat/), Claw and Code (web/js/tools/).
//
// Without them the prompt is byte for byte the one from before the media tools, so the engine's prefix reuse holds on
// ordinary turns. They go in only when:
//   (a) the message carries an attachment, or names a media item of the conversation (an id such as img-k3x9, or «esta
//       foto», «la imagen de antes», «anímala»… when the conversation has one); or
//   (b) the message asks to MAKE media: a creation verb («haz», «crea», «dibuja», «make», «draw»…) followed closely by
//       a media noun («imagen», «canción», «vídeo», «picture», «song»…), with nothing in between that makes it about
//       code or an app («haz una app de música» is an app), and not a media noun of another trade («imagen ISO»,
//       «docker image»); or a few phrases that only mean media («en voz alta», «read it aloud»).
// A question about media («¿qué es una imagen ISO?») has no creation verb and does not count.

/** Lowercase, accents stripped, punctuation to spaces, single spaces. */
export function normalize(text) {
  return ` ${String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ\- ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

/** A media id of the SDK tools (img-, aud-, vid-, doc- and four characters). */
export const MEDIA_ID = /\b(?:img|aud|vid|doc)-[a-z2-9]{4}\b/;

const KIND = {
  image: 'imagen(?:es)?|fotos?|fotografias?|dibujos?|ilustracion(?:es)?|logos?|logotipos?|retratos?|cuadros?|iconos?|fondos? de pantalla|carteles?|posters?|pictures?|images?|photos?|photographs?|drawings?|illustrations?|portraits?|icons?|wallpapers?|paintings?|pinturas?|acuarelas?|watercolou?rs?|avatar(?:es)?|stickers?|pegatinas?|memes?',
  video: 'videos?|clips?|animacion(?:es)?|animations?|movies?|peliculas? cortas?|cortometrajes?',
  music: 'musica|canciones|cancion|melodias?|bandas? sonoras?|jingles?|songs?|music|melod(?:y|ies)|soundtracks?|beats?|ritmos?|himnos?|nanas?|lullab(?:y|ies)',
  sfx: 'sonidos?|efectos? de sonido|ruidos?|sfx|sound effects?|sounds?',
  voice: 'audios?|locucion(?:es)?|narracion(?:es)?|voice ?overs?|voiceovers?|notas? de voz|voice notes?',
};
const NOUN = new RegExp(`^(?:${Object.values(KIND).join('|')})\\b`);
// The media noun of another trade: an ISO or docker image, a disk image, an image of an object in code.
const NOT_MEDIA_AFTER = /^\S+ (?:iso|docker|de disco|del disco|de sistema|del sistema|de contenedor|disk|container|base ?64|binari[ao]s?|en base ?64|de la base de datos)\b/;
const NOT_MEDIA_BEFORE = /\b(?:docker|iso|disk|container|contenedor|base64)\s*$/;

// Creation verbs and phrases (imperative, request, first-person want), es and en.
const CREATE = new RegExp('\\b(?:' + [
  'haz', 'hazme', 'haznos', 'hacer', 'hagas', 'hagamos', 'crea', 'creame', 'crear', 'crees', 'creamos',
  'genera', 'generame', 'generar', 'generes', 'dibuja', 'dibujame', 'dibujar', 'pinta', 'pintame', 'pintar',
  'compon', 'componme', 'componer', 'disena', 'disename', 'disenar', 'graba', 'grabame', 'produce', 'produceme',
  'me haces', 'me hagas', 'me creas', 'me generas', 'me dibujas', 'me pintas', 'me compones', 'quiero', 'quisiera', 'necesito', 'dame', 'ponme', 'preparame', 'prepara', 'saca', 'sacame',
  'make', 'create', 'generate', 'draw', 'paint', 'compose', 'design', 'render', 'produce', 'record',
  'give me', 'i want', 'i need', 'i d like', 'id like',
].join('|') + ')\\b', 'g');
// Words that make the request about code or an app when they come between the verb and the noun.
const BLOCK = /\b(?:app|apps|aplicacion|aplicaciones|web|webs|pagina|paginas|programa|script|funcion|codigo|juego|juegos|reproductor|editor|visor|galeria|componente|boton|formulario|clase|modulo|website|page|function|code|game|player|component|button|form|class|module|viewer|gallery|canvas|svg|css|html|javascript|python|carpeta|folder|lista|list|tabla|table|database|archivo|fichero|file|pdf|excel|csv|grafica|grafico|chart|plot|diagrama|diagram|conclusion(?:es)?|conclusions?|linea|line|circulo|circle|resumen|summary|busqueda|search)\b/;
const NEAR = 7;   // the media noun within this many words after the verb

// Phrases that only mean making media.
const ONLY_MEDIA = [
  /\ben voz alta\b/, /\b(?:read|say|speak) (?:it |this |that |these |the text |my text )?(?:aloud|out loud)\b/, /\bout loud\b/, /\baloud\b/,
  /\btext to speech\b/, /\btts\b/, /\bnarra(?:lo|la|me|melo)? (?:en|con) (?:voz|audio)\b/, /\bcon (?:tu|una|la) voz\b/,
  /\bconvierte(?:lo|la)? (?:en|a) (?:voz|audio)\b/, /\b(?:turn|convert) (?:it|this|that|the text) (?:in)?to (?:speech|audio|voice)\b/,
  /\banim(?:ala|alo|alas|alos|amela|amelo)\b/, /\banimate (?:it|this|that|the|my|her|him)\b/,
  /\b(?:dibujame|pintame)\b(?! (?:un|una|el|la) (?:grafic|diagram|tabla|lista))/,
];

// What points at a media item the conversation already has.
const REFERS = [
  /\b(?:esta|esa|aquella|la|mi|tu|otra|ultima|primera|segunda)\s+(?:foto|imagen|fotografia|ilustracion|cancion|musica|grabacion|nota de voz)\b/,
  /\b(?:este|ese|aquel|el|mi|tu|otro|ultimo|primer|segundo)\s+(?:video|audio|clip|dibujo|logo|retrato|sonido|efecto)\b/,
  /\b(?:this|that|the|my|your|last|first|previous|same)\s+(?:photo|picture|image|drawing|video|clip|song|audio|sound|voice note|recording)\b/,
  /\b(?:de antes|anterior|que hiciste|que has hecho|que te pase|que adjunte|you made|i sent|i attached|from before)\b/,
  /\banim(?:a|ar|ala|alo|ame|amela)\b/, /\banimate\b/,
];

// Drawing and painting verbs with an object («dibuja un gato», «draw a cat»): a picture even without the word for it,
// unless what is drawn is code's («un círculo en el canvas», «a chart»).
const DRAW = /\b(?:dibuja|dibujame|pinta|pintame|draw|paint)\s+(?:me\s+)?(?:un|una|unos|unas|el|la|mi|a|an|the|my|some)\s+((?:\S+\s*){1,4})/;

/**
 * Does this turn need the media tools in its prompt?
 * @param {string} text the user's message, as typed
 * @param {{ attachments?: number, hasMedia?: boolean }} [conv] `attachments`: how many the message carries;
 *   `hasMedia`: the conversation already has a media item (a card or an attachment)
 * @returns {{ media: boolean, why: 'attachment'|'id'|'reference'|'request'|'phrase'|null }}
 */
export function needsMediaTools(text, { attachments = 0, hasMedia = false } = {}) {
  if (attachments > 0) return { media: true, why: 'attachment' };
  const raw = String(text || '');
  if (MEDIA_ID.test(raw.toLowerCase())) return { media: true, why: 'id' };
  const t = normalize(raw);
  if (hasMedia && REFERS.some((re) => re.test(t))) return { media: true, why: 'reference' };
  if (ONLY_MEDIA.some((re) => re.test(t))) return { media: true, why: 'phrase' };
  const d = DRAW.exec(t);
  if (d && !d[1].trim().split(' ').some((w) => BLOCK.test(w))) return { media: true, why: 'request' };
  CREATE.lastIndex = 0;
  let m;
  while ((m = CREATE.exec(t))) {
    const after = t.slice(m.index + m[0].length).trim().split(' ');
    for (let i = 0; i < Math.min(NEAR, after.length); i++) {
      const rest = after.slice(i).join(' ');
      if (BLOCK.test(after[i])) break;
      if (NOUN.test(rest)) {
        const before = after.slice(0, i).join(' ');
        if (NOT_MEDIA_AFTER.test(rest) || NOT_MEDIA_BEFORE.test(before)) break;
        return { media: true, why: 'request' };
      }
    }
  }
  return { media: false, why: null };
}

/** True when a text (the conversation so far) holds a media id: the conversation has a media item. */
export const hasMediaIn = (text) => MEDIA_ID.test(String(text || ''));
