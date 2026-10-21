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

function collectSources(root: string, list: unknown[], pkg: BenderPackage, issues: string[]) {
  for (const s of list ?? []) {
    if (typeof s === 'string') {
      const hits = expandGlob(root, s);
      if (!hits.length) issues.push(`${pkg.name}: source "${s}" matched no files`);
      for (const h of hits) if (!pkg.files.includes(h)) pkg.files.push(h);
    } else if (s && typeof s === 'object') {
      const g = s as SourceGroup;
      for (const inc of g.include_dirs ?? []) pkg.includeDirs.push(path.resolve(root, inc));
      Object.assign(pkg.defines, g.defines ?? {});
      collectSources(root, g.files ?? [], pkg, issues);
    }
  }
}

/** Load the Bender package rooted at each dir, following path (and checked-out git) dependencies. */
export function loadBender(rootDirs: string[]): BenderResult {
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
      name: man.package?.name ?? path.basename(key), root: key, files: [], includeDirs: [], defines: {}, deps: [],
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
    collectSources(key, man.sources ?? [], pkg, issues);
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
