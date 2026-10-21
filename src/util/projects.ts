import * as fs from 'fs';
import * as path from 'path';

const SKIP = new Set(['node_modules', 'venv', '.venv', '__pycache__', '.bender', '.vscode-test', 'dist', 'build', '.git']);

/** True if `dir` contains a .sv/.v file or a Bender.yml within `depth` levels (stops at the first hit). */
export function hasRtl(dir: string, depth = 6): boolean {
  let ents: fs.Dirent[];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of ents) if (e.isFile() && (/\.(sv|v)$/.test(e.name) || e.name === 'Bender.yml')) return true;
  if (depth <= 0) return false;
  for (const e of ents) if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.') && hasRtl(path.join(dir, e.name), depth - 1)) return true;
  return false;
}

/**
 * Candidate project folders under the workspace roots: git repositories (a folder with .git)
 * that contain RTL, searched up to `maxDepth` levels down. Sorted by path.
 */
export function findProjects(roots: string[], maxDepth = 4): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (ents.some(e => e.name === '.git')) {
      if (hasRtl(dir)) out.push(dir);
      return;                      // nested repos (submodules) belong to this project
    }
    if (depth >= maxDepth) return;
    for (const e of ents) if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out.sort();
}
