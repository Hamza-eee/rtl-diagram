// Problems reading the RTL ("source issues"): syntax errors, modules declared twice, instantiated
// modules that weren't found, and problems in Bender manifests or filelists. They are tied to the
// modules they affect so the diagram can mark those blocks. No VS Code API here (unit-testable).

import * as fs from 'fs';
import * as path from 'path';
import { Design } from './model';

export type IssueKind = 'syntax' | 'duplicate' | 'missing' | 'sources';

/** How each kind is named in the UI ("Syntax error near 'rptr'", "Not found: module x"). */
export const ISSUE_KIND_LABEL: Record<IssueKind, string> = { syntax: 'Syntax error', duplicate: 'Declared more than once:', missing: 'Not found:', sources: 'Sources:' };

export interface SourceIssue {
  key: string;            // stable identity, used to remember a tick for the session
  kind: IssueKind;
  title: string;          // one line, e.g. "Syntax error near 'rptr'"
  detail?: string;        // extra sentence, e.g. what this means for the diagram
  file?: string;          // absolute
  line?: number;          // 1-based, for display and opening
  col?: number;           // 1-based
  modules: string[];      // modules whose drawing this affects
}

export interface FileErrors {
  file: string;
  errors: { line: number; column: number; text?: string; phase?: string }[];   // Verible: 0-based line/column
  parsed: boolean;        // Verible produced a syntax tree (it recovered from the errors)
  modules: string[];      // modules extracted from the file
}

/**
 * Module names a file declares, read from its text. Used only for files Verible couldn't parse
 * at all, so a broken file can still be linked to the modules it was meant to provide.
 */
export function declaredModules(text: string): string[] {
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
  const out: string[] = [];
  const re = /\b(?:module|macromodule)\s+(?:(?:automatic|static)\s+)?([A-Za-z_][A-Za-z0-9_$]*)/g;
  for (let m = re.exec(code); m; m = re.exec(code)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

const rel = (f: string, roots: string[]) => {
  for (const r of roots) { const x = path.relative(r, f); if (!x.startsWith('..') && !path.isAbsolute(x)) return x; }
  return path.basename(f);
};

export function collectIssues(d: Design, files: FileErrors[], sourceProblems: string[], roots: string[] = []): SourceIssue[] {
  const out: SourceIssue[] = [];
  const declaredByBroken = new Map<string, string>();     // module name -> broken file that declares it

  for (const f of files) {
    if (!f.errors.length) continue;
    let mods = f.modules;
    if (!f.parsed) {
      let text = '';
      try { text = fs.readFileSync(f.file, 'utf8'); } catch { /* unreadable: no modules */ }
      mods = declaredModules(text);
      for (const m of mods) if (!d.modules[m]) declaredByBroken.set(m, f.file);
    }
    const name = rel(f.file, roots);
    // In a file Verible couldn't recover from, errors after the first are mostly knock-on effects
    // of it (one missing comma can produce half a dozen), so only the first is listed.
    const errors = f.parsed ? f.errors : f.errors.slice(0, 1);
    const more = f.errors.length - errors.length;
    for (const e of errors) {
      const line = e.line + 1, col = e.column + 1;
      const tok = e.text ? (e.text.length > 24 ? e.text.slice(0, 23) + '…' : e.text) : '';
      out.push({
        key: `syntax:${f.file}:${line}:${col}:${e.text ?? ''}`,
        kind: 'syntax',
        title: tok ? `near '${tok}'` : `in ${name}`,
        detail: (f.parsed
          ? `Verible recovered, so ${mods.length ? mods.join(', ') : 'this file'} may be drawn incomplete.`
          : `The file could not be read at all${mods.length ? `, so ${mods.join(', ')} ${mods.length === 1 ? 'is' : 'are'} missing from the diagram` : ''}.`
            + (more ? ` Verible reported ${more} more error${more === 1 ? '' : 's'} after this one, usually knock-on effects: fix this one first.` : '')),
        file: f.file, line, col, modules: mods,
      });
    }
  }

  for (const [m, fs_] of Object.entries(d.duplicates)) {
    out.push({
      key: `duplicate:${m}:${fs_.join('|')}`, kind: 'duplicate',
      title: `module ${m}, ${fs_.length} times`,
      detail: `Using the first, in ${rel(fs_[0], roots)}. Also in ${fs_.slice(1).map(f => rel(f, roots)).join(', ')}.`,
      file: fs_[0], modules: [m],
    });
  }

  const missing = new Map<string, Set<string>>();
  for (const m of Object.values(d.modules)) {
    for (const i of m.instances) if (!d.modules[i.moduleName]) (missing.get(i.moduleName) ?? missing.set(i.moduleName, new Set()).get(i.moduleName)!).add(m.name);
  }
  for (const [name, parents] of [...missing.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const broken = declaredByBroken.get(name);
    out.push({
      key: `missing:${name}`, kind: 'missing',
      title: `module ${name}`,
      detail: broken
        ? `It is declared in ${rel(broken, roots)}, which has syntax errors. Instantiated in ${[...parents].sort().join(', ')}.`
        : `Instantiated in ${[...parents].sort().join(', ')}, but not in the files read. It may be a vendor primitive, a missing dependency or a file outside the sources.`,
      file: broken, modules: [name],
    });
  }

  for (const p of sourceProblems) out.push({ key: `sources:${p}`, kind: 'sources', title: p, modules: [] });
  return out;
}

export interface IssueMarks {
  module: number;                                          // unchecked issues on the viewed module itself
  nodes: Record<string, { count: number; inside: boolean }>;  // inst:<key> -> issues on that block or below it
}

/** Where unchecked issues show in the view of `module`. */
export function issueMarksFor(d: Design, issues: SourceIssue[], checked: Set<string>, module: string): IssueMarks {
  const open = issues.filter(i => !checked.has(i.key) && i.modules.length);
  const marks: IssueMarks = { module: open.filter(i => i.modules.includes(module)).length, nodes: {} };
  const memo = new Map<string, Set<string>>();
  const below = (m: string): Set<string> => {
    let s = memo.get(m);
    if (s) return s;
    s = new Set();
    memo.set(m, s);
    for (const i of d.modules[m]?.instances ?? []) { s.add(i.moduleName); for (const x of below(i.moduleName)) s.add(x); }
    return s;
  };
  for (const inst of d.modules[module]?.instances ?? []) {
    const direct = open.filter(i => i.modules.includes(inst.moduleName)).length;
    const inside = open.filter(i => !i.modules.includes(inst.moduleName) && i.modules.some(m => below(inst.moduleName).has(m))).length;
    if (direct || inside) marks.nodes[`inst:${inst.key}`] = { count: direct + inside, inside: direct === 0 };
  }
  return marks;
}
