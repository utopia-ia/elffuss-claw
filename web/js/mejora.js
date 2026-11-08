// «Mejora Elffuss»: el chat de elffuss.com manda aquí lo que el usuario quiere cambiar del propio chat
// (#/mejora?pide=<texto>). Se instala (o se pone al día) la skill elffuss-improve y la petición queda escrita en la
// caja, lista para enviar: una dirección nunca ejecuta nada por sí sola, la envía el usuario.
import * as skills from './skills.js';

export const SKILL_NAME = 'elffuss-improve';
const SKILL_DESC = 'Change or improve the Elffuss chat itself (colours, shapes, texts, behaviour) in the user\'s own fork on GitHub, publish it, and offer it as a pull request.';

export const SKILL_MD = `# Improve Elffuss (the user's own version of the chat)

The user wants to change the Elffuss chat (elffuss.com) itself. You do it in THEIR fork on GitHub, never in the
official site. In Elffuss Claw, explain each step in one plain sentence: the user may not program. In Elffuss Code,
the user programs: show the exact diff and wait for an OK before each github.write.

## Steps
1. Restate the change in one sentence and confirm what you understood.
2. If GitHub is not connected, call github.connect and wait.
3. Call github.fork (creates or updates the fork named elffuss-chat).
4. Find the file to change. Read before writing:
   - colours, sizes, shapes, fonts, spacing: chat/chat.css (look for the custom properties in :root first)
   - words and labels: chat/chat.js (the text dictionaries near the top, one per language)
   - layout of the page: index.html
   - behaviour: chat/chat.js. Only small, local changes; if it needs a large rewrite, say so and stop.
5. Make the SMALLEST change that does what was asked. Keep everything else byte for byte. Never touch .github/.
6. Write the whole file back with github.write and a one-line message.
7. Call github.publish and wait. Then tell the user:
   - their version is at the address it returns;
   - to use it from now on, open https://elffuss.com/?my-version=<that address> and confirm there;
   - https://elffuss.com/?official=1 always goes back to the official chat.
8. Ask if they want to propose the change to Elffuss. Only if they say yes, call github.pr with a short title and a
   body that quotes what they asked and lists the files changed.

## Never
- Write outside the fork, or to any repository other than the one github.fork prepared.
- Add scripts from other websites, trackers, or anything that sends data elsewhere.
- Paste a token or password into the conversation; connecting is always github.connect.`;

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
