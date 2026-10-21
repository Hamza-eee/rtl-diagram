// Chooses where RTL files come from: Bender.yml, filelists, or an include glob.
// Independent of the VS Code API so it can be unit-tested.

import * as path from 'path';
import { expandGlob, globToRegExp, matchesAny } from '../util/glob';
import { loadBender } from './bender';
import { loadFilelists } from './filelist';

export type SourceMode = 'auto' | 'bender' | 'filelist' | 'glob';

export interface DiscoverOptions {
  roots: string[];            // workspace folders
  mode: SourceMode;
  benderRoots: string[];      // relative to the first root, or absolute
  filelists: string[];
  include: string;
  exclude: string[];
}

export interface SourceSet {
  mode: 'bender' | 'filelist' | 'glob' | 'none';
  label: string;              // e.g. "Bender · 12 packages · 41 files"
  files: { file: string; pkg?: string }[];
  issues: string[];
}

export function discoverSources(o: DiscoverOptions): SourceSet {
  const ex = o.exclude.map(globToRegExp);
  const keep = (f: string) => {
    for (const r of o.roots) {
      const rel = path.relative(r, f);
      if (!rel.startsWith('..') && matchesAny(rel, ex)) return false;
    }
    return true;
  };
  const resolveRel = (p: string) => path.isAbsolute(p) ? p : path.resolve(o.roots[0] ?? '.', p);

  const tryBender = (): SourceSet | null => {
    let dirs = o.benderRoots.map(resolveRel);
    if (!dirs.length) {
      for (const r of o.roots) {
        for (const f of expandGlob(r, '**/Bender.yml')) {
          if (keep(f) && !f.includes(`${path.sep}.bender${path.sep}`)) dirs.push(path.dirname(f));
        }
      }
    }
    if (!dirs.length) return null;
    const b = loadBender(dirs);
    const files = b.files.filter(f => keep(f.file));
    const pkgs = new Set(files.map(f => f.pkg)).size;
    return { mode: 'bender', label: `Bender · ${pkgs} package${pkgs === 1 ? '' : 's'} · ${files.length} files`, files, issues: b.issues };
  };
  const tryFilelist = (): SourceSet | null => {
    if (!o.filelists.length) return null;
    const r = loadFilelists(o.filelists.map(resolveRel));
    const files = r.files.filter(keep).map(file => ({ file }));
    return { mode: 'filelist', label: `Filelist · ${files.length} files`, files, issues: r.issues };
  };
  const tryGlob = (): SourceSet => {
    const files: { file: string }[] = [];
    for (const r of o.roots) for (const f of expandGlob(r, o.include)) if (keep(f)) files.push({ file: f });
    return { mode: 'glob', label: `Glob · ${files.length} files`, files, issues: [] };
  };

  switch (o.mode) {
    case 'bender': return tryBender() ?? { mode: 'none', label: 'Bender · no Bender.yml found', files: [], issues: ['sourceMode is "bender" but no Bender.yml was found'] };
    case 'filelist': return tryFilelist() ?? { mode: 'none', label: 'Filelist · none configured', files: [], issues: ['sourceMode is "filelist" but rtlDiagram.filelists is empty'] };
    case 'glob': return tryGlob();
    default: return tryBender() ?? tryFilelist() ?? tryGlob();
  }
}
