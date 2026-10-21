// Links extracted modules into a design: resolves instance → module, positional and
// wildcard connections, instance-output drivers, port widths and the hierarchy.

import { Design, Driver, Module, ParseIssue, Port } from './model';

export interface ResolvedConn {
  port: string;          // formal port on the child
  dir: Port['dir'];
  expr: string;          // actual expression ('' = left open)
  signals: string[];     // parent-side signals
  implicit: boolean;
}

export function buildDesign(mods: Module[], files: string[], issues: ParseIssue[], sourceMode: string): Design {
  const modules: Record<string, Module> = {};
  const decl: Record<string, string[]> = {};
  for (const m of mods) {
    (decl[m.name] ??= []).push(m.file);
    if (!modules[m.name]) modules[m.name] = m;   // first in source order wins (compile-order semantics)
  }
  const duplicates: Record<string, string[]> = {};
  for (const [n, fs] of Object.entries(decl)) if (fs.length > 1) duplicates[n] = fs;
  for (const m of Object.values(modules)) for (const p of m.ports) p.width = portWidth(p, m);
  const d: Design = { modules, duplicates, issues, files, sourceMode };
  for (const m of Object.values(modules)) addInstanceDrivers(d, m);
  return d;
}

/** Connections of an instance with every formal port of the child resolved (positional, `.name`, `.*`). */
export function resolveConnections(d: Design, parent: Module, instIdx: number): ResolvedConn[] {
  const inst = parent.instances[instIdx];
  const child = d.modules[inst.moduleName];
  const out: ResolvedConn[] = [];
  const named = new Set<string>();
  for (const c of inst.connections) {
    let port = c.port;
    if (!port && c.position !== undefined && child) port = child.ports[c.position]?.name ?? `#${c.position}`;
    if (!port) continue;
    named.add(port);
    out.push({
      port, dir: child?.ports.find(p => p.name === port)?.dir ?? 'unknown',
      expr: c.expr, signals: dropConstants(parent, c.signals), implicit: !!c.implicit,
    });
  }
  if (inst.wildcard && child) {
    const visible = new Set([...parent.ports.map(p => p.name), ...parent.nets]);
    for (const p of child.ports) {
      if (named.has(p.name)) continue;
      // `.*` connects to a same-named signal in the parent; unmatched ports stay open (a compile error in SV).
      out.push({ port: p.name, dir: p.dir, expr: visible.has(p.name) ? p.name : '', signals: visible.has(p.name) ? [p.name] : [], implicit: true });
    }
  }
  // Keep child declaration order so pins line up with the module header.
  if (child) {
    const order = new Map(child.ports.map((p, i) => [p.name, i]));
    out.sort((a, b) => (order.get(a.port) ?? 1e9) - (order.get(b.port) ?? 1e9));
  }
  return out;
}

/**
 * An identifier is a net only if this module declares it (port, net or variable).
 * Parameters, genvars, enum constants and package items are therefore never nets.
 * Implicit (undeclared) nets are not drawn; they are a lint error in most flows anyway.
 */
export function isNet(m: Module, s: string): boolean {
  return m.ports.some(p => p.name === s) || m.nets.includes(s);
}

function dropConstants(m: Module, sigs: string[]): string[] {
  return sigs.filter(s => isNet(m, s));
}

function addInstanceDrivers(d: Design, m: Module) {
  m.instances.forEach((inst, i) => {
    for (const c of resolveConnections(d, m, i)) {
      if (c.dir !== 'output' && c.dir !== 'inout') continue;
      for (const s of c.signals) {
        const drv: Driver = {
          signal: s, kind: 'instance', instance: inst.key, instPort: c.port,
          text: `${inst.moduleName} ${inst.name} (.${c.port}(${c.expr}))`,
          loc: inst.connections.find(x => x.port === c.port)?.loc ?? inst.loc,
        };
        m.drivers.push(drv);
      }
    }
  });
}

export function topCandidates(d: Design): string[] {
  const used = new Set<string>();
  for (const m of Object.values(d.modules)) for (const i of m.instances) if (i.moduleName !== m.name) used.add(i.moduleName);
  const tops = Object.keys(d.modules).filter(n => !used.has(n));
  // Most instances (deepest design) first, then by name: deterministic.
  const size = (n: string, seen = new Set<string>()): number => {
    if (seen.has(n)) return 0;
    seen.add(n);
    const m = d.modules[n];
    return m ? m.instances.reduce((a, i) => a + 1 + size(i.moduleName, seen), 0) : 0;
  };
  return tops.sort((a, b) => size(b) - size(a) || a.localeCompare(b));
}

/** Module at the end of an instance-key path from `top`, e.g. ["u_core", "u_alu"]. */
export function moduleAtPath(d: Design, top: string, instPath: string[]): Module | undefined {
  let m = d.modules[top];
  for (const key of instPath) {
    const inst = m?.instances.find(i => i.key === key);
    if (!inst) return undefined;
    m = d.modules[inst.moduleName];
  }
  return m;
}

export type HierResult = { ok: true; path: string[]; module: Module } | { ok: false; reason: string };

const baseName = (s: string) => s.replace(/\[[^\]]*\]$/, '');

/**
 * Resolve a simulator hierarchical path below `top` (the parts between the DUT instance
 * and the signal, e.g. ["g_ch[0]", "u_core"] or ["u_arr[1]"]) to instance keys.
 *
 * Rules, applied per element:
 *  - an element whose base name (without a trailing [index]) names an instance whose
 *    generate scopes equal the scopes consumed so far enters that instance;
 *  - otherwise, an element naming a generate block label in the current module, or an
 *    implicit `genblkN` (IEEE 1800 §27.6), is consumed as a scope;
 *  - a base name matching exactly one instance is accepted even if the scopes differ;
 *  - anything else fails, with a reason.
 */
export function resolveHierPath(d: Design, top: string, elems: string[]): HierResult {
  let m = d.modules[top];
  if (!m) return { ok: false, reason: `module "${top}" is not in the parsed RTL` };
  const path: string[] = [];
  let scopes: string[] = [];
  for (const e of elems) {
    const b = baseName(e);
    const cands = m.instances.filter(i => baseName(i.name) === b);
    const named = cands.filter(i => i.genScopes.filter(Boolean).join('.') === scopes.filter(x => !/^genblk\d+$/.test(x)).join('.'));
    // A unique base-name match is accepted even if the scopes differ (some tools omit them).
    const inst = named[0] ?? (cands.length === 1 ? cands[0] : undefined);
    if (inst) {
      const child = d.modules[inst.moduleName];
      if (!child) return { ok: false, reason: `instance ${inst.name} is a "${inst.moduleName}", which is not in the parsed RTL` };
      path.push(inst.key);
      m = child;
      scopes = [];
      continue;
    }
    const isScope = /^genblk\d+$/.test(b) || m.instances.some(i => i.genScopes.includes(b));
    if (isScope) { scopes.push(b); continue; }
    if (cands.length) {
      return { ok: false, reason: `${m.name} has an instance ${b}, but not inside generate scope "${scopes.join('.') || '(none)'}"` };
    }
    return { ok: false, reason: `${m.name} has no instance or generate block named "${b}"` };
  }
  if (scopes.length) return { ok: false, reason: `path ends inside generate scope "${scopes.join('.')}" of ${m.name}` };
  return { ok: true, path, module: m };
}

// ---------- width evaluation (constant folding over parameter defaults) ----------

export function portWidth(p: Port, m: Module): number | undefined {
  if (!p.packed) return /\b(int|integer)\b/.test(p.type) ? 32 : 1;
  const env = paramEnv(m);
  let total = 1;
  for (const dim of p.packed.match(/\[[^\]]*\]/g) ?? []) {
    const inner = dim.slice(1, -1);
    const parts = splitTopColon(inner);
    if (parts.length === 2) {
      const a = evalExpr(parts[0], env), b = evalExpr(parts[1], env);
      if (a === undefined || b === undefined) return undefined;
      total *= Math.abs(a - b) + 1;
    } else {
      const n = evalExpr(inner, env);
      if (n === undefined) return undefined;
      total *= n;
    }
  }
  return total;
}

function splitTopColon(s: string): string[] {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ':' && depth === 0 && s[i + 1] !== ':' && s[i - 1] !== ':') return [s.slice(0, i), s.slice(i + 1)];
  }
  return [s];
}

export function paramEnv(m: Module): Record<string, number> {
  const env: Record<string, number> = {};
  for (const p of m.params) {
    if (p.value === undefined) continue;
    const v = evalExpr(p.value, env);
    if (v !== undefined) env[p.name] = v;
  }
  return env;
}

/** Evaluate a constant integer expression. Returns undefined for anything not fully constant. */
export function evalExpr(src: string, env: Record<string, number>): number | undefined {
  const toks = src.match(/\d+'[sS]?[bBoOdDhH][0-9a-fA-F_xXzZ?]+|'[sS]?[bBoOdDhH][0-9a-fA-F_]+|\d[\d_]*|\$?[A-Za-z_][\w$]*|<<|>>|\*\*|[-+*/%()?:<>]|\S/g);
  if (!toks) return undefined;
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const lit = (t: string): number | undefined => {
    const m = t.match(/^(\d*)'[sS]?([bBoOdDhH])([0-9a-fA-F_]+)$/);
    if (m) {
      const base = { b: 2, o: 8, d: 10, h: 16 }[m[2].toLowerCase() as 'b' | 'o' | 'd' | 'h'];
      return parseInt(m[3].replace(/_/g, ''), base);
    }
    if (/^\d[\d_]*$/.test(t)) return parseInt(t.replace(/_/g, ''), 10);
    return undefined;
  };
  const primary = (): number | undefined => {
    const t = next();
    if (t === undefined) return undefined;
    if (t === '(') { const v = ternary(); if (next() !== ')') return undefined; return v; }
    if (t === '-') { const v = primary(); return v === undefined ? undefined : -v; }
    if (t === '+') return primary();
    if (t === '$clog2') {
      if (next() !== '(') return undefined;
      const v = ternary();
      if (next() !== ')' || v === undefined) return undefined;
      return v <= 1 ? 0 : Math.ceil(Math.log2(v));
    }
    const l = lit(t);
    if (l !== undefined) return l;
    if (/^[A-Za-z_]/.test(t)) return env[t];
    return undefined;
  };
  const bin = (lvl: number): number | undefined => {
    const ops: string[][] = [['<', '>'], ['<<', '>>'], ['+', '-'], ['*', '/', '%'], ['**']];
    if (lvl >= ops.length) return primary();
    let a = bin(lvl + 1);
    while (a !== undefined && ops[lvl].includes(peek())) {
      const op = next();
      const b = bin(lvl + 1);
      if (b === undefined) return undefined;
      switch (op) {
        case '+': a = a + b; break;
        case '-': a = a - b; break;
        case '*': a = a * b; break;
        case '/': if (!b) return undefined; a = Math.trunc(a / b); break;
        case '%': if (!b) return undefined; a = a % b; break;
        case '**': a = a ** b; break;
        case '<<': a = a << b; break;
        case '>>': a = a >> b; break;
        case '<': a = a < b ? 1 : 0; break;
        case '>': a = a > b ? 1 : 0; break;
      }
    }
    return a;
  };
  const ternary = (): number | undefined => {
    const c = bin(0);
    if (peek() !== '?') return c;
    next();
    const a = ternary();
    if (next() !== ':') return undefined;
    const b = ternary();
    return c === undefined ? undefined : (c ? a : b);
  };
  const v = ternary();
  return i === toks.length ? v : undefined;
}
