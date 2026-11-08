// «Mejora Elffuss»: el chat de elffuss.com manda aquí lo que el usuario quiere cambiar del propio chat
// (#/mejora?pide=<texto>). Se instala (o se pone al día) la skill elffuss-improve y la petición queda escrita en la
// caja, lista para enviar: una dirección nunca ejecuta nada por sí sola, la envía el usuario.
import * as skills from './skills.js';

export const SKILL_NAME = 'elffuss-improve';
const SKILL_DESC = 'Change the Elffuss chat itself: its look and words as a validated theme on elffuss.com, behaviour in the user\'s GitHub fork (Code), and propose it as a pull request.';

export const SKILL_MD = `# Improve Elffuss (the user's own version of the chat)

The user wants to change the Elffuss chat (elffuss.com) itself. In Elffuss Claw, explain each step in one plain
sentence: the user may not program. In Elffuss Code, the user programs: show exact changes and wait for an OK.

## A. Look and words (colours, shapes, fonts, density, labels): the theme
Almost every request is this. No GitHub needed.
1. Restate the change in one sentence.
2. Call elffuss.theme_get to see the current theme and what is allowed.
3. Build the WHOLE theme JSON (fields you leave out go back to the official look) and call elffuss.theme_set.
   - colors: wall (page), surface (side panels), board, steel (borders), ink (text and buttons), graphite (secondary
     text), on-ink (text on buttons), tape (highlight), accent, selection. Only #rrggbb.
   - radius: square | soft | round | pill. density: compact | normal | roomy. font: system | serif | rounded | mono.
   - texts: {"es": {"key": "text"}, "en": {...}} for labels of the chat; plain text, 160 characters at most.
   If it is rejected, read the reason (often contrast: text must stay readable), fix it and try again.
4. Tell the user to open or reload https://elffuss.com to see it, and that «Volver a la oficial» there turns it off.
   elffuss.theme_reset removes it.

## B. Behaviour (only in Elffuss Code, only if A cannot do it)
Changing how the chat works means changing its code in the user's fork on GitHub (github.fork, github.read,
github.write, github.publish). That version runs at the user's github.io address as a preview, without the shared
memory or models of elffuss.com. Keep changes small; if it needs a large rewrite, say so and stop.

## Proposing it to Elffuss
Only if the user asks: in their fork, write the theme as elffuss-theme.json (or the code change), then github.pr with
a short title and a body quoting what they asked. If GitHub is not available yet, say so plainly.

## Never
- Write CSS, scripts or HTML into the theme; only the fields above.
- Write outside the user's fork, or add anything that loads from other websites or sends data elsewhere.
- Paste a token or password into the conversation.`;

export async function instalarSkill() {
  const ya = skills.installed().find((s) => s.name === SKILL_NAME);
  if (!ya) return skills.createSkill({ name: SKILL_NAME, description: SKILL_DESC, instructions: SKILL_MD });
  if ((await skills.get(SKILL_NAME))?.content === SKILL_MD) return null;
  if (skills.editSkill) return skills.editSkill({ name: SKILL_NAME, description: SKILL_DESC, instructions: SKILL_MD });
  await skills.remove(SKILL_NAME);
  return skills.createSkill({ name: SKILL_NAME, description: SKILL_DESC, instructions: SKILL_MD });
}

// La petición que trae la dirección, o null. Se quita del hash al leerla: recargar no la vuelve a poner.
export function leerPeticion(hash = location.hash) {
  const m = /^#\/mejora\?(?:.*&)?pide=([^&]*)/.exec(hash || '');
  if (!m) return null;
  let pide = '';
  try { pide = decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch { pide = m[1]; }
  try { history.replaceState(history.state, '', location.pathname + location.search); } catch { /* sandbox */ }
  pide = pide.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 600);
  return pide || null;
}

// Deja la petición en la caja de escribir, con el foco, para que el usuario la lea y la envíe.
export function prepararCaja(pide, prefijo) {
  const caja = document.getElementById('prompt');
  if (!caja) return false;
  caja.value = `${prefijo} ${pide}`;
  caja.dispatchEvent(new Event('input', { bubbles: true }));
  caja.focus();
  return true;
}
