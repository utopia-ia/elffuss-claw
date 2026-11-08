// «Tu versión» de Elffuss (Opción A): el tema del chat se guarda aquí, en el IndexedDB de Claw, validado con
// elffuss-theme.js. elffuss.com lo lee por el puente (bridge.js, op theme.get), lo vuelve a validar y lo aplica. Solo
// en este navegador; el fork de GitHub es el registro público y el origen de la PR, no lo que se aplica.
import * as db from '../db.js';
import { validateTheme, SCHEMA, COLORS, RADIUS, DENSITY, FONTS, BASE, THEMEABLE } from '../elffuss-theme.js';

export const KEY = 'elffuss.theme';

export async function get() {
  const s = await db.get('kv', KEY).catch(() => null);
  const v = s?.theme ? validateTheme(s.theme) : null;
  const ayuda = `The official look is a dark slate: ${JSON.stringify(BASE)}. Colours you leave out keep these values, and text must stay readable on them. Allowed: colors {${Object.keys(COLORS).join(', ')}} as #rrggbb, radius ${Object.keys(RADIUS).join('|')}, density ${Object.keys(DENSITY).join('|')}, font ${Object.keys(FONTS).join('|')}, texts {es|en: {key: text}} only for these keys: ${[...THEMEABLE].join(', ')}.`;
  if (!v?.ok) return `No custom theme: elffuss.com shows the official look.\n${ayuda}`;
  return `Current theme:\n${JSON.stringify(v.theme, null, 2)}\n${ayuda}`;
}

// Guarda el tema entero (lo que no venga, vuelve a lo oficial). Si no es válido, no guarda nada y dice por qué, para
// que el modelo lo corrija.
export async function set({ theme }) {
  const v = validateTheme(theme);
  if (!v.ok) throw new Error('Theme not saved: ' + v.errors.join('; '));
  await db.set('kv', KEY, { theme: v.theme, at: Date.now() });
  return `Theme saved (${SCHEMA}). Open or reload https://elffuss.com to see it; «Back to the official» there turns it off.\n` + JSON.stringify(v.theme);
}

export async function reset() {
  await db.del('kv', KEY);
  return 'Theme removed: elffuss.com shows the official look again.';
}

// Para el puente: el tema validado o null.
export async function current() {
  const s = await db.get('kv', KEY).catch(() => null);
  const v = s?.theme ? validateTheme(s.theme) : null;
  return v?.ok ? { theme: v.theme, at: s.at || 0 } : null;
}
