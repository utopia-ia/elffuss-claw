// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The prompt of a picture made from another. People write the change they want («en acuarela»,
// «de noche», «the same scene as a watercolor»), not the picture: given alone, SANA paints the
// change and forgets the subject (a watercolour landscape where the fox was). So when the text
// is a change, the prompt is the picture's own caption (image-to-text) followed by the change,
// and a few common Spanish changes are written in the English the model follows best. A text
// that describes a whole scene is used as it is. Pure functions.

/** Words that open a change rather than a scene (Spanish and English). */
const OPENERS = /^(en|de|del|como|con|al|a la|a lo|estilo|tipo|versi[oó]n|pero|que|haz(la|lo|le)?|ponle|p[oó]n(la|lo)?|convi[eé]rte(la|lo)|as|in|at|with|like|but|make it|turn it( into)?|the same|same|la misma|el mismo|lo mismo|igual)\b/i;

/** Changes of style, light, weather or time that make a short text a change. */
const CHANGES = /\b(acuarela|watercolou?r|[oó]leo|oil|l[aá]piz|pencil|carb[oó]n|charcoal|tinta|ink|c[oó]mic|comic|manga|anime|pixel|p[ií]xel|3d|render|boceto|sketch|dibujo|drawing|pintura|painting|ilustraci[oó]n|illustration|cartoon|dibujos animados|noche|night|nocturn[oa]|atardecer|sunset|amanecer|sunrise|niebla|fog|lluvia|lloviendo|rain|nieve|nevando|nevad[oa]|snow|snowing|invierno|winter|oto[ñn]o|autumn|primavera|spring|verano|summer|blanco y negro|black and white|vintage|retro|cyberpunk|futurista|futuristic|steampunk|pastel|ne[oó]n|neon)\b/i;

/** Common Spanish changes, in the English the model follows best (the person's words stay too). */
const ENGLISH = [
  [/\ben acuarela\b|\bacuarela\b/i, 'as a watercolor painting'],
  [/\bal [oó]leo\b|\b[oó]leo\b/i, 'as an oil painting'],
  [/\ba l[aá]piz\b|\bl[aá]piz\b/i, 'as a pencil drawing'],
  [/\bestilo c[oó]mic\b|\bc[oó]mic\b/i, 'in comic book style, bold ink lines, flat colors'],
  [/\bde noche\b|\bnoche\b|\bnocturn[oa]\b/i, 'at night, dark blue sky, moonlight'],
  [/\bnevando\b|\bnieve\b|\bnevad[oa]\b/i, 'in the snow, snow falling, snow on the ground'],
  [/\blloviendo\b|\blluvia\b/i, 'in the rain, wet surfaces'],
  [/\bal atardecer\b|\batardecer\b/i, 'at sunset, golden light'],
  [/\bblanco y negro\b/i, 'black and white photograph'],
];

/**
 * Whether a text asks for a change of the picture rather than describing a whole scene: short
 * (six words or fewer), or opening like a change («en…», «de…», «como…», «as a…», «in…», «the
 * same…»), or short-ish (up to twelve words) and naming a style, a light or the weather.
 * @param {string} text
 */
export function isChangeRequest(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!t) return true;
  const words = t.split(' ').length;
  return words <= 6 || OPENERS.test(t) || (words <= 12 && CHANGES.test(t));
}

/** The first sentences of a caption, at most `max` characters, without its final full stop. */
export function shortCaption(caption, max = 240) {
  // «The image shows…», «In this picture, …»: the scene itself, not a description of a picture
  const c = String(caption || '').replace(/\s+/g, ' ').trim()
    .replace(/^(the|this) (image|picture|photo|photograph) (shows|depicts|is of|features|contains)\s+/i, '')
    .replace(/^in (this|the) (image|picture|photo|photograph),?\s*/i, '');
  const sentences = c.match(/[^.!?]+[.!?]?/g) || [];
  let out = '';
  for (const s of sentences) {
    const next = (out + ' ' + s.trim()).trim();
    if (next.length > max && out) break;
    out = next;
  }
  return out.slice(0, max).replace(/[.\s]+$/, '');
}

/**
 * The prompt for a picture made from another: the caption and the change when the text is a
 * change, the text itself when it describes a whole scene (or there is no caption).
 * @param {string} caption what the picture shows (image-to-text, English)
 * @param {string} text what the person wrote
 * @returns {{ prompt: string, composed: boolean }}
 */
export function composePrompt(caption, text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  const c = shortCaption(caption);
  if (!c || !isChangeRequest(t)) return { prompt: t, composed: false };
  // «the same scene as…» / «la misma escena…»: the caption is the scene
  const change = t.replace(/^(the same( scene| picture| image| photo)?|la misma( escena| imagen| foto)?|el mismo( paisaje)?|lo mismo)\s*,?\s*/i, '').trim();
  const english = ENGLISH.filter(([re]) => re.test(change)).map(([, en]) => en);
  const parts = [c, ...english, ...(change && !english.length ? [change] : english.length ? [change] : [])];
  return { prompt: parts.filter(Boolean).join(', '), composed: true };
}
