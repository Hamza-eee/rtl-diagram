// Reads Bender.yml manifests directly (never runs `bender`, so nothing is written
// to the user's repository). Produces the ordered RTL file list per package.

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { expandGlob } from '../util/glob';

export interface BenderPackage {
  name: string;
  root: string;               // directory containing Bender.yml
  files: string[];            // absolute, in manifest order
  includeDirs: string[];
  defines: Record<string, string | null>;
  deps: string[];             // dependency package names
  skippedGroups: string[];    // target expressions of source groups left out for the active targets
}

export interface BenderResult {
  packages: BenderPackage[];  // dependency order: deps before dependents
  files: { file: string; pkg: string }[];
  issues: string[];
}

interface SourceGroup {
  files?: unknown[];
  target?: unknown;
  include_dirs?: string[];
  defines?: Record<string, string | null>;
}

function readManifest(dir: string): any | null {
  const f = path.join(dir, 'Bender.yml');
  if (!fs.existsSync(f)) return null;
  return parseYaml(fs.readFileSync(f, 'utf8')) ?? {};
}

/** Find a git dependency's checkout under any ancestor's .bender/git/checkouts. */
function findCheckout(fromDir: string, name: string): string | null {
  let d = fromDir;
  for (;;) {
    const co = path.join(d, '.bender', 'git', 'checkouts');
    if (fs.existsSync(co)) {
      const hit = fs.readdirSync(co).sort().find(e => e === name || e.startsWith(name + '-'));
      if (hit) return path.join(co, hit);
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/**
 * Evaluate a Bender target expression against the active targets:
 * `*`, a target name, `all(e, …)`, `any(e, …)`, `not(e)`. Names compare case-insensitively.
 * Returns undefined if the expression cannot be parsed.
 */
export function evalTarget(expr: string, active: Set<string>): boolean | undefined {
  const toks = expr.match(/[A-Za-z0-9_\-]+|\*|[(),]/g) ?? [];
  if (toks.join('') !== expr.replace(/\s+/g, '')) return undefined;   // stray characters
  let i = 0;
  const parse = (): boolean | undefined => {
    const t = toks[i++];
    if (t === undefined) return undefined;
    if (t === '*') return true;
    const op = t.toLowerCase();
    if ((op === 'all' || op === 'any' || op === 'not') && toks[i] === '(') {
      i++;
      const args: boolean[] = [];
      while (toks[i] !== ')') {
        const v = parse();
        if (v === undefined) return undefined;
        args.push(v);
        if (toks[i] === ',') i++;
        else if (toks[i] !== ')') return undefined;
      }
      i++;
      if (op === 'not') return args.length === 1 ? !args[0] : undefined;
      return op === 'all' ? args.every(Boolean) : args.some(Boolean);
    }
    if (/^[(),]$/.test(t)) return undefined;
    return active.has(op);
  };
  const v = parse();
  return i === toks.length ? v : undefined;
}

function collectSources(root: string, list: unknown[], pkg: BenderPackage, issues: string[], active: Set<string>) {
  for (const s of list ?? []) {
    if (typeof s === 'string') {
      const hits = expandGlob(root, s);
      if (!hits.length) issues.push(`${pkg.name}: source "${s}" matched no files`);
      for (const h of hits) if (!pkg.files.includes(h)) pkg.files.push(h);
    } else if (s && typeof s === 'object') {
      const g = s as SourceGroup;
      if (g.target !== undefined) {
        const on = evalTarget(String(g.target), active);
        if (on === undefined) { issues.push(`${pkg.name}: cannot read target expression "${g.target}"; group skipped`); continue; }
        if (!on) { pkg.skippedGroups.push(String(g.target)); continue; }
      }
      for (const inc of g.include_dirs ?? []) pkg.includeDirs.push(path.resolve(root, inc));
      Object.assign(pkg.defines, g.defines ?? {});
      collectSources(root, g.files ?? [], pkg, issues, active);
    }
  }
}

/**
 * Load the Bender package rooted at each dir, following path (and checked-out git) dependencies.
 * Source groups with a `target:` are included only if it holds for `targets` (default: none active,
 * i.e. plain RTL: ungated and `not(...)` groups in, `test`/`sim`/technology groups out).
 */
export function loadBender(rootDirs: string[], targets: string[] = []): BenderResult {
  const active = new Set(targets.map(t => t.toLowerCase()));
  const byRoot = new Map<string, BenderPackage>();
  const order: BenderPackage[] = [];
  const issues: string[] = [];
  const visiting = new Set<string>();

  const visit = (dir: string): BenderPackage | null => {
    const key = path.resolve(dir);
    if (byRoot.has(key)) return byRoot.get(key)!;
    if (visiting.has(key)) { issues.push(`dependency cycle through ${key}`); return null; }
    let man: any;
    try { man = readManifest(key); } catch (e: any) { issues.push(`${key}/Bender.yml: ${e.message}`); return null; }
    if (!man) { issues.push(`no Bender.yml in ${key}`); return null; }
    visiting.add(key);
    const pkg: BenderPackage = {
      name: man.package?.name ?? path.basename(key), root: key, files: [], includeDirs: [], defines: {}, deps: [], skippedGroups: [],
    };
    for (const [dname, spec] of Object.entries<any>(man.dependencies ?? {})) {
      pkg.deps.push(dname);
      let depDir: string | null = null;
      if (spec && typeof spec === 'object' && typeof spec.path === 'string') depDir = path.resolve(key, spec.path);
      else depDir = findCheckout(key, dname);
      if (!depDir) { issues.push(`${pkg.name}: dependency "${dname}" is not a path dependency and has no checkout in .bender/ (run \`bender checkout\` to resolve it)`); continue; }
      visit(depDir);
    }
    for (const inc of man.export_include_dirs ?? []) pkg.includeDirs.push(path.resolve(key, inc));
    collectSources(key, man.sources ?? [], pkg, issues, active);
    visiting.delete(key);
    byRoot.set(key, pkg);
    order.push(pkg);
    return pkg;
  };

  for (const r of [...rootDirs].sort()) visit(r);

  const seen = new Set<string>();
  const files: BenderResult['files'] = [];
  for (const p of order) for (const f of p.files) if (!seen.has(f)) { seen.add(f); files.push({ file: f, pkg: p.name }); }
  return { packages: order, files, issues };
}
