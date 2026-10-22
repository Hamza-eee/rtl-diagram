// Notes left on the diagram by designers and verification engineers.
// One JSON file per note under <workspace folder>/.rtl-notes/, so notes travel with git
// and two people adding notes never edit the same file. No VS Code API here (unit-testable).

import * as fs from 'fs';
import * as path from 'path';
import { Design } from '../model';
import { isNet, moduleAtPath } from '../elab';

export type NoteKind = 'note' | 'question' | 'issue';

export type NoteTarget =
  | { type: 'module' }
  | { type: 'port'; name: string }
  | { type: 'net'; name: string };

export interface NoteAnchor {
  module: string;                                   // module the note is about
  target: NoteTarget;
  scope?: { top: string; instPath: string[] };      // set: only this instance (instance keys from `top`)
}

export interface Note {
  schema: 1;
  id: string;
  kind: NoteKind;
  text: string;
  author: string;
  created: string;                                  // ISO 8601
  updated?: string;
  resolved: boolean;
  anchor: NoteAnchor;
}

export interface StoredNote extends Note { file: string }

export const NOTE_KINDS: NoteKind[] = ['note', 'question', 'issue'];
export const MAX_NOTE_LENGTH = 4000;

export function newNoteId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');   // 20260115T100000
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

// Notes are shared files written by other people and tools, so everything read from disk
// (or sent by the webview) is validated before use. The id doubles as the file name, so it
// must match exactly what newNoteId() produces: no separators, no "..".
export const NOTE_ID_RE = /^\d{8}T\d{6}-[a-z0-9]{1,12}$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;          // SystemVerilog identifier
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_$]*(\[[^\]\n]{1,64}\])?(#\d+)?$/;   // instance key, e.g. u_arr[1:0], u_x#2

const isStr = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

export function isAnchor(a: any): a is NoteAnchor {
  if (!a || typeof a !== 'object' || !isStr(a.module) || !NAME_RE.test(a.module)) return false;
  const t = a.target;
  if (!t || typeof t !== 'object') return false;
  if (t.type === 'module') { /* ok */ }
  else if ((t.type === 'port' || t.type === 'net') && isStr(t.name) && NAME_RE.test(t.name)) { /* ok */ }
  else return false;
  if (a.scope !== undefined) {
    const sc = a.scope;
    if (!sc || !isStr(sc.top) || !NAME_RE.test(sc.top) || !Array.isArray(sc.instPath) || sc.instPath.length > 64) return false;
    if (!sc.instPath.every((k: unknown) => isStr(k, 128) && KEY_RE.test(k as string))) return false;
  }
  return true;
}

const isIsoDate = (v: unknown) => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

export function isNote(x: any): x is Note {
  return !!x && typeof x === 'object' && x.schema === 1
    && typeof x.id === 'string' && NOTE_ID_RE.test(x.id)
    && NOTE_KINDS.includes(x.kind)
    && typeof x.text === 'string' && x.text.length <= MAX_NOTE_LENGTH
    && typeof x.author === 'string' && x.author.length <= 200
    && isIsoDate(x.created) && (x.updated === undefined || isIsoDate(x.updated))
    && typeof x.resolved === 'boolean'
    && isAnchor(x.anchor);
}

/** Read every `*.json` note in the given folders. Invalid files are reported and skipped, never fatal. */
export function loadNotes(dirs: string[]): { notes: StoredNote[]; issues: string[] } {
  const notes: StoredNote[] = [];
  const issues: string[] = [];
  for (const dir of dirs) {
    let names: string[];
    try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort(); } catch { continue; }
    for (const n of names) {
      const file = path.join(dir, n);
      try {
        const x = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!isNote(x)) issues.push(`${file}: not a valid note (skipped)`);
        else if (x.id !== path.basename(n, '.json')) issues.push(`${file}: note id "${x.id}" does not match its file name (skipped)`);
        else notes.push({ ...x, file });
      } catch (e: any) {
        issues.push(`${file}: ${e.message}`);
      }
    }
  }
  notes.sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
  return { notes, issues };
}

/** True if `file` is directly inside `dir` (no traversal, no symlinked escape of the name). */
export function isInside(dir: string, file: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep);
}

/** Write a note to <dir>/<id>.json. Refuses ids that aren't plain note ids. */
export function writeNote(dir: string, note: Note): string {
  if (!NOTE_ID_RE.test(note.id)) throw new Error(`refusing to write note with invalid id "${note.id}"`);
  const file = path.join(dir, `${note.id}.json`);
  if (!isInside(dir, file)) throw new Error(`refusing to write a note outside ${dir}`);
  fs.mkdirSync(dir, { recursive: true });
  const plain: Partial<StoredNote> = { ...note };
  delete plain.file;                         // the path is where it lives, not part of the note
  fs.writeFileSync(file, JSON.stringify(plain, null, 2) + '\n');
  return file;
}

/** A notes folder name from settings: a plain relative path inside the project, else the default. */
export function safeNotesFolder(name: unknown, fallback = '.rtl-notes'): { name: string; issue?: string } {
  if (typeof name !== 'string' || !name.trim()) return { name: fallback };
  const n = path.normalize(name.trim());
  if (path.isAbsolute(n) || n.split(/[\\/]/).includes('..')) {
    return { name: fallback, issue: `rtlDiagram.notesFolder "${name}" points outside the project; using "${fallback}"` };
  }
  return { name: n };
}

/** Why a note no longer points at anything in the parsed RTL, or undefined if it still does. */
export function detachedReason(d: Design, n: Note): string | undefined {
  const a = n.anchor;
  const m = d.modules[a.module];
  if (!m) return `module ${a.module} is not in the parsed RTL`;
  if (a.target.type === 'port' && !m.ports.some(p => p.name === (a.target as { name: string }).name)) return `${a.module} has no port ${a.target.name}`;
  if (a.target.type === 'net' && !isNet(m, a.target.name)) return `${a.module} has no net ${a.target.name}`;
  if (a.scope) {
    const at = moduleAtPath(d, a.scope.top, a.scope.instPath);
    if (!at || at.name !== a.module) return `instance ${[a.scope.top, ...a.scope.instPath].join('.')} no longer exists`;
  }
  return undefined;
}

/** Human label for where a note sits, e.g. "fifo.wdata", "u_evt_fifo (fifo) only". */
export function anchorLabel(n: Note): string {
  const a = n.anchor;
  const what = a.target.type === 'module' ? a.module : `${a.module}.${a.target.name}`;
  return a.scope ? `${what} · only ${[a.scope.top, ...a.scope.instPath].join('.')}` : what;
}

export interface NoteMark { ids: string[]; kind: NoteKind; resolved: boolean; inside: boolean }

/**
 * Where notes appear in the view of module at (top, path). Keys are the webview's ids:
 *  - `port:<p>/p`       a port of this module
 *  - `net:<n>`          a net of this module
 *  - `module`           this module itself
 *  - `inst:<k>/<p>`     a port of a child instance
 *  - `inst:<k>`         a child instance (notes on the child module, or anything inside it)
 */
export function noteMarksFor(d: Design, notes: Note[], top: string, viewPath: string[]): { marks: Record<string, NoteMark>; here: string[] } {
  const marks: Record<string, NoteMark> = {};
  const here: string[] = [];
  const mod = moduleAtPath(d, top, viewPath);
  if (!mod) return { marks, here };
  const rank: Record<NoteKind, number> = { issue: 0, question: 1, note: 2 };
  const add = (key: string, n: Note, inside: boolean) => {
    const m = (marks[key] ??= { ids: [], kind: n.kind, resolved: true, inside: false });
    m.ids.push(n.id);
    if (!n.resolved && (m.resolved || rank[n.kind] < rank[m.kind])) m.kind = n.kind;
    m.resolved &&= n.resolved;
    m.inside ||= inside;
  };
  const scopeOk = (n: Note, p: string[]) => !n.anchor.scope
    || (n.anchor.scope.top === top && n.anchor.scope.instPath.length === p.length && n.anchor.scope.instPath.every((x, i) => x === p[i]));
  for (const n of notes) {
    const a = n.anchor;
    if (a.module === mod.name && scopeOk(n, viewPath)) {
      here.push(n.id);
      if (a.target.type === 'port') add(`port:${a.target.name}/p`, n, false);
      else if (a.target.type === 'net') add(`net:${a.target.name}`, n, false);
      else add('module', n, false);
    }
    for (const inst of mod.instances) {
      if (a.module !== inst.moduleName || !scopeOk(n, [...viewPath, inst.key])) continue;
      if (a.target.type === 'port') add(`inst:${inst.key}/${a.target.name}`, n, false);
      else add(`inst:${inst.key}`, n, a.target.type === 'net');
    }
  }
  return { marks, here };
}
