// Reads simulator-style filelists (.f): plain paths, -f/-F nesting, +incdir+, +define+, -v, -y.

import * as fs from 'fs';
import * as path from 'path';
import { expandGlob } from '../util/glob';

export interface FilelistResult {
  files: string[];
  includeDirs: string[];
  issues: string[];
}

function expandEnv(s: string) {
  return s.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => process.env[a ?? b] ?? m);
}

export function loadFilelists(lists: string[]): FilelistResult {
  const res: FilelistResult = { files: [], includeDirs: [], issues: [] };
  const seenLists = new Set<string>();
  const add = (f: string) => { if (!res.files.includes(f)) res.files.push(f); };

  const read = (fl: string) => {
    const abs = path.resolve(fl);
    if (seenLists.has(abs)) return;
    seenLists.add(abs);
    let text: string;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { res.issues.push(`filelist not found: ${abs}`); return; }
    const base = path.dirname(abs);
    const toks = text.replace(/\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//g, ' ').split(/\s+/).filter(Boolean).map(expandEnv);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t === '-f' || t === '-F') { const n = toks[++i]; if (n) read(path.resolve(base, n)); }
      else if (t.startsWith('+incdir+')) t.slice(8).split('+').filter(Boolean).forEach(d => res.includeDirs.push(path.resolve(base, d)));
      else if (t.startsWith('+define+') || t.startsWith('+libext+')) continue;
      else if (t === '-v') { const n = toks[++i]; if (n) add(path.resolve(base, n)); }
      else if (t === '-y') {
        const n = toks[++i];
        if (n) expandGlob(path.resolve(base, n), '*.{sv,v}').forEach(add);
      } else if (t.startsWith('-') || t.startsWith('+')) continue;   // other simulator flags
      else {
        const hits = expandGlob(base, t);
        if (!hits.length) res.issues.push(`${path.basename(abs)}: file not found: ${t}`);
        hits.forEach(add);
      }
    }
  };
  lists.forEach(read);
  return res;
}
