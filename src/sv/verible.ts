import { execFile } from 'child_process';
import * as fs from 'fs';

// Raw Verible CST node as emitted by `verible-verilog-syntax --export_json --printtree`.
// Leaf tokens carry start/end (byte offsets) and usually text; inner nodes carry children.
export interface CstNode {
  tag: string;
  start?: number;
  end?: number;
  text?: string;
  children?: (CstNode | null)[];
}

export interface VeribleError {
  line: number;
  column: number;
  phase?: string;
  text?: string;
}

export interface ParsedFile {
  file: string;
  tree: CstNode | null;
  errors: VeribleError[];
  buf: Buffer;          // exact bytes Verible parsed; offsets index into this
  mtimeMs: number;
}

const cache = new Map<string, ParsedFile>();

export function clearCache(file?: string) {
  if (file) cache.delete(file);
  else cache.clear();
}

function run(verible: string, files: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(verible, ['--export_json', '--printtree', ...files],
      { maxBuffer: 1024 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // Verible exits non-zero when any file has syntax errors but still prints JSON.
        if (stdout && stdout.trim().startsWith('{')) return resolve(stdout);
        if (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code === 'ENOENT') {
            return reject(new Error(`Verible not found at "${verible}". Install Verible or set rtlDiagram.veriblePath.`));
          }
          return reject(new Error(`Verible failed: ${stderr || err.message}`));
        }
        resolve(stdout);
      });
  });
}

/** Parse files with Verible, reusing cached results for files whose mtime is unchanged. */
export async function parseFiles(verible: string, files: string[]): Promise<ParsedFile[]> {
  const todo: string[] = [];
  const stats = new Map<string, number>();
  for (const f of files) {
    let m = -1;
    try { m = fs.statSync(f).mtimeMs; } catch { /* missing file: reported by caller */ }
    stats.set(f, m);
    const c = cache.get(f);
    if (!c || c.mtimeMs !== m) todo.push(f);
  }
  const CHUNK = 40;
  for (let i = 0; i < todo.length; i += CHUNK) {
    const chunk = todo.slice(i, i + CHUNK).filter(f => stats.get(f)! >= 0);
    if (!chunk.length) continue;
    // Snapshot the bytes before parsing so offsets match even if the file changes meanwhile.
    const bufs = new Map(chunk.map(f => [f, fs.readFileSync(f)] as const));
    const out = JSON.parse(await run(verible, chunk)) as Record<string, { tree?: CstNode; errors?: VeribleError[] }>;
    for (const f of chunk) {
      const r = out[f] ?? {};
      cache.set(f, { file: f, tree: r.tree ?? null, errors: r.errors ?? [], buf: bufs.get(f)!, mtimeMs: stats.get(f)! });
    }
  }
  return files.filter(f => cache.has(f)).map(f => cache.get(f)!);
}
