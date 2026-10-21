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

function isNote(x: any): x is Note {
  return x && x.schema === 1 && typeof x.id === 'string' && NOTE_KINDS.includes(x.kind) && typeof x.text === 'string'
    && x.anchor && typeof x.anchor.module === 'string' && x.anchor.target && ['module', 'port', 'net'].includes(x.anchor.target.type);
}

/** Read every `*.json` note in the given folders. Unreadable files are reported, not fatal. */
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
        if (isNote(x)) notes.push({ ...x, file });
        else issues.push(`${file}: not a valid note`);
      } catch (e: any) {
        issues.push(`${file}: ${e.message}`);
      }
    }
  }
  notes.sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
  return { notes, issues };
}

export function writeNote(dir: string, note: Note): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${note.id}.json`);
  const plain: Partial<StoredNote> = { ...note };
  delete plain.file;                         // the path is where it lives, not part of the note
  fs.writeFileSync(file, JSON.stringify(plain, null, 2) + '\n');
  return file;
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
