// Sistema de archivos real vía File System Access API (Chrome/Edge).
// Los handles de carpeta se persisten en IndexedDB; el navegador re-pide
// su propio permiso nativo al volver a usarlos en otra sesión.
import * as db from '../db.js';
import { require as requirePerm } from '../permissions.js';
import { t } from '../i18n.js';

const MAX_READ = 200_000; // caracteres

export async function pickFolder() {
  await requirePerm('fs', t('pdPickFolder'));
  if (!window.showDirectoryPicker)
    throw new Error(t('fsNoApi'));
  const handle = await window.showDirectoryPicker();
  await db.set('fs', handle.name, handle);
  return t('fsAuthorized', { name: handle.name });
}

export async function folders() { return db.keys('fs'); }

export async function root(folder) {
  await requirePerm('fs');
  const names = await db.keys('fs');
  if (!names.length)
    throw new Error(t('fsNoFolder'));
  if (folder && !names.includes(folder))
    throw new Error(t('fsUnknownFolder', { folder, names: names.join(', ') }));
  const handle = await db.get('fs', folder || names[0]);
  // (los handles OPFS no exponen queryPermission — se consideran concedidos)
  const perm = handle.queryPermission ? await handle.queryPermission({ mode: 'readwrite' }) : 'granted';
  if (perm !== 'granted' &&
      (!handle.requestPermission || await handle.requestPermission({ mode: 'readwrite' }) !== 'granted'))
    throw new Error(t('fsDenied'));
  return handle;
}

// Excel → CSV (SheetJS, lazy). Devuelve el CSV de la primera hoja. SheetJS va
// fijado y servido desde este origen (web/vendor/third-party/, PIN.json); antes
// venía de cdn.sheetjs.com «xlsx-latest», que cambiaba sin avisar.
export async function xlsxToCsv(file) {
  const XLSX = await import('../../vendor/third-party/xlsx@0.20.3/xlsx.mjs');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const sheet = wb.SheetNames[0];
  return { sheet, csv: XLSX.utils.sheet_to_csv(wb.Sheets[sheet]) };
}

// Un modelo pequeño suele pasar el NOMBRE de la carpeta raíz como si fuera una
// subcarpeta: fs.list(path="models") cuando la carpeta autorizada YA es «models».
// Lo perdonamos quitando ese primer segmento redundante.
function stripRootName(path, rootName) {
  const parts = (path || '').split('/').filter(Boolean);
  if (parts.length && parts[0] === rootName) parts.shift();
  return parts;
}

// Entra en subcarpetas dando un error que ENSEÑA (qué hay) en vez del críptico
// «could not be found».
async function enterDir(dir, parts) {
  for (const p of parts) {
    try { dir = await dir.getDirectoryHandle(p); }
    catch {
      const hay = [];
      try { for await (const e of dir.values()) hay.push((e.kind === 'directory' ? '📁 ' : '📄 ') + e.name); } catch {}
      throw new Error(t('fsNoSubfolder', { sub: p, dir: dir.name, hay: hay.join(', ') || t('fsEmpty') }));
    }
  }
  return dir;
}

// Recorre 'a/b/c.txt' → { dir: handle de a/b, name: 'c.txt' }
async function walk(handle, path, { create = false } = {}) {
  const parts = stripRootName(path, handle.name);
  const name = parts.pop();
  for (const p of parts) handle = await handle.getDirectoryHandle(p, { create });
  return { dir: handle, name };
}

export async function list({ path = '', folder } = {}) {
  const rootH = await root(folder);
  const dir = await enterDir(rootH, stripRootName(path, rootH.name));
  const out = [];
  for await (const entry of dir.values())
    out.push(`${entry.kind === 'directory' ? '📁' : '📄'} ${entry.name}`);
  return out.length ? out.sort().join('\n') : t('fsEmptyFolder');
}

export async function read({ path, folder } = {}) {
  if (!path) throw new Error(t('toolMissing', { arg: 'path' }));
  const { dir, name } = await walk(await root(folder), path);
  const file = await (await dir.getFileHandle(name)).getFile();
  if (/\.xlsx?$/i.test(name)) { // Excel: binario → CSV legible
    const { sheet, csv } = await xlsxToCsv(file);
    const body = csv.length > MAX_READ ? csv.slice(0, MAX_READ) + '\n' + t('cutMark') : csv;
    return t('fsSheetCsv', { name, sheet }) + '\n' + body;
  }
  const text = await file.text();
  return text.length > MAX_READ
    ? text.slice(0, MAX_READ) + '\n' + t('fsCutBytes', { n: file.size })
    : text;
}

export async function write({ path, content = '', folder } = {}) {
  if (!path) throw new Error(t('toolMissing', { arg: 'path' }));
  const { dir, name } = await walk(await root(folder), path, { create: true });
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(content);
  await w.close();
  return t('fsWritten', { path, n: content.length });
}

export const globToRegex = pattern => new RegExp(
  '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');

// Copia one-shot entre dos carpetas autorizadas (pattern tipo *.txt).
export async function copy({ pattern = '*', from, to } = {}) {
  if (!from || !to) throw new Error(t('fsMissingFromTo'));
  const src = await root(from), dst = await root(to);
  const rx = globToRegex(pattern);
  const copied = [];
  for await (const entry of src.values()) {
    if (entry.kind !== 'file' || !rx.test(entry.name)) continue;
    const data = await (await entry.getFile()).arrayBuffer();
    const fh = await dst.getFileHandle(entry.name, { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
    copied.push(entry.name);
  }
  return copied.length
    ? t('fsCopied', { n: copied.length, from, to, files: copied.join(', ') })
    : t('fsNothingToCopy', { pattern, from });
}
