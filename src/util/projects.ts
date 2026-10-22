import * as fs from 'fs';
import * as path from 'path';

const SKIP = new Set(['node_modules', 'venv', '.venv', '__pycache__', '.bender', '.vscode-test', 'dist', 'build', '.git']);

async function entries(dir: string): Promise<fs.Dirent[]> {
  try { return await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
}

/** True if `dir` contains a .sv/.v file or a Bender.yml within `depth` levels (stops at the first hit). */
export async function hasRtl(dir: string, depth = 6): Promise<boolean> {
  const ents = await entries(dir);
  if (ents.some(e => e.isFile() && (/\.(sv|v)$/.test(e.name) || e.name === 'Bender.yml'))) return true;
  if (depth <= 0) return false;
  for (const e of ents) {
    if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.') && await hasRtl(path.join(dir, e.name), depth - 1)) return true;
  }
  return false;
}

/**
 * Candidate project folders under the workspace roots: git repositories (a folder with .git)
 * that contain RTL, searched up to `maxDepth` levels down. Asynchronous, so a large parent
 * folder never blocks the extension host. Sorted by path.
 */
export async function findProjects(roots: string[], maxDepth = 4): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    const ents = await entries(dir);
    if (ents.some(e => e.name === '.git')) {
      if (await hasRtl(dir)) out.push(dir);
      return;                      // nested repos (submodules) belong to this project
    }
    if (depth >= maxDepth) return;
    await Promise.all(ents.filter(e => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.'))
      .map(e => walk(path.join(dir, e.name), depth + 1)));
  };
  await Promise.all(roots.map(r => walk(r, 0)));
  return out.sort();
}
