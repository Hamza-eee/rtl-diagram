import * as fs from 'fs';
import * as path from 'path';

/** Convert a glob (`*`, `**`, `?`, `{a,b}`, `[abc]`) to a RegExp over `/`-separated relative paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  let inBrace = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 3 : 2;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { inBrace++; re += '(?:'; }
    else if (c === '}' && inBrace) { inBrace--; re += ')'; }
    else if (c === ',' && inBrace) re += '|';
    else if (c === '[') {
      const j = glob.indexOf(']', i);
      if (j < 0) re += '\\[';
      else { re += '[' + glob.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = j; }
    } else re += c.replace(/[.+^$()|\\]/g, '\\$&');
    i++;
  }
  return new RegExp('^' + re + '$');
}

// Never descended into by recursive globs: VCS metadata, package managers, Python envs.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'venv', '.venv', '__pycache__', '.bender', '.vscode-test']);

export function hasMagic(p: string) { return /[*?[{]/.test(p); }

/** Expand a glob relative to `base`. Results are absolute, sorted, files only. */
export function expandGlob(base: string, pattern: string): string[] {
  const norm = pattern.replace(/\\/g, '/');
  if (!hasMagic(norm)) {
    const abs = path.resolve(base, norm);
    return fs.existsSync(abs) ? [abs] : [];
  }
  // Walk from the deepest non-magic directory prefix.
  const parts = norm.split('/');
  const fixed: string[] = [];
  while (parts.length && !hasMagic(parts[0])) fixed.push(parts.shift()!);
  const root = path.resolve(base, fixed.join('/'));
  const rx = globToRegExp(parts.join('/'));
  const deep = parts.some(p => p.includes('**')) || parts.length > 1;
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? rel + '/' + e.name : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (deep && !SKIP_DIRS.has(e.name)) walk(abs, r); }
      else if (rx.test(r)) out.push(abs);
    }
  };
  walk(root, '');
  return out;
}

export function matchesAny(relPath: string, globs: RegExp[]) {
  const p = relPath.replace(/\\/g, '/');
  return globs.some(g => g.test(p));
}
