// Places resolved findings on a module view, by instance path.
// Pure functions (no VS Code API) so they can be unit-tested.

import { Design } from '../model';
import { moduleAtPath } from '../elab';
import { Level, Run } from './run';
import { Resolution, SignalRef } from './resolve';

export interface Marker { f: number; level: Level; role: 'primary' | 'context' | 'driver' }

export interface ViewMarkers {
  pins: Record<string, Marker[]>;
  nodes: Record<string, { error: number; warning: number; note: number; inside: boolean }>;
  nets: Record<string, Marker[]>;
  /** True when the DUT is not uniquely placed under the view's top, so findings are matched by module. */
  byModule: boolean;
}

/** Instance-key paths from `top` to instances of `target`, depth-first in source order; stops after `cap`. */
export function pathsTo(d: Design, top: string, target: string, cap = 2): string[][] {
  const out: string[][] = [];
  const stack: string[] = [];
  const walk = (mod: string, prefix: string[]) => {
    if (out.length >= cap || stack.includes(mod)) return;
    stack.push(mod);
    for (const i of d.modules[mod]?.instances ?? []) {
      if (out.length >= cap) break;
      if (i.moduleName === target) out.push([...prefix, i.key]);
      else walk(i.moduleName, [...prefix, i.key]);
    }
    stack.pop();
  };
  walk(top, []);
  return out;
}

/** Path from `top` to the DUT, or null when the DUT is absent or instantiated more than once under `top`. */
export function dutPrefix(d: Design, top: string, dutTop: string): string[] | null {
  if (top === dutTop) return [];
  const ps = pathsTo(d, top, dutTop, 2);
  return ps.length === 1 ? ps[0] : null;
}

/** Absolute instance-key path (from `top`) of the module that declares `ref`, or null if it cannot be placed. */
export function refPath(d: Design, run: Run, top: string, ref: SignalRef): string[] | null {
  if (ref.status !== 'ok') return null;
  const pre = dutPrefix(d, top, run.dutTop);
  return pre === null ? null : [...pre, ...ref.instPath];
}

const startsWith = (a: string[], b: string[]) => b.every((x, i) => a[i] === x);
const sameLevel = (l: Level): l is 'error' | 'warning' | 'note' => l === 'error' || l === 'warning' || l === 'note';

export function markersFor(d: Design, run: Run | undefined, res: Map<number, Resolution>, top: string, path: string[]): ViewMarkers {
  const out: ViewMarkers = { pins: {}, nodes: {}, nets: {}, byModule: false };
  const mod = moduleAtPath(d, top, path);
  if (!run || !mod) return out;
  const pre = dutPrefix(d, top, run.dutTop);
  out.byModule = pre === null;

  const push = (rec: Record<string, Marker[]>, k: string, mk: Marker) => {
    const l = (rec[k] ??= []);
    if (!l.some(x => x.f === mk.f && x.role === mk.role)) l.push(mk);
  };
  const bump = (id: string, level: Level, inside: boolean) => {
    const n = (out.nodes[id] ??= { error: 0, warning: 0, note: 0, inside: false });
    if (sameLevel(level)) n[level]++;
    n.inside ||= inside;
  };
  // Memoised "which modules sit below this one", for the by-module fallback.
  const belowMemo = new Map<string, Set<string>>();
  const below = (m: string): Set<string> => {
    let s = belowMemo.get(m);
    if (s) return s;
    s = new Set();
    belowMemo.set(m, s);
    for (const i of d.modules[m]?.instances ?? []) { s.add(i.moduleName); for (const x of below(i.moduleName)) s.add(x); }
    return s;
  };

  for (const f of run.findings) {
    const r = res.get(f.index);
    if (!r) continue;
    const refs = [...(r.primary ? [r.primary] : []), ...r.context];
    const badged = new Set<string>();
    for (const ref of refs) {
      if (ref.status !== 'ok' || !ref.module) continue;
      const role = ref === r.primary ? 'primary' : 'context';
      const mk: Marker = { f: f.index, level: f.level, role };
      const here = pre !== null ? startsWith(path, [...pre, ...ref.instPath]) && path.length === pre.length + ref.instPath.length : ref.module === mod.name;
      if (here) {
        if (ref.port) push(out.pins, `port:${ref.signal}/p`, mk);
        push(out.nets, ref.signal, mk);
        if (role === 'primary') {
          for (const dr of ref.drivers) {
            const dm: Marker = { f: f.index, level: f.level, role: 'driver' };
            if (dr.kind === 'instance' && dr.instance && dr.instPort) push(out.pins, `inst:${dr.instance}/${dr.instPort}`, dm);
            else push(out.pins, `logic/${ref.signal}`, dm);
          }
        }
        continue;
      }
      if (pre !== null) {
        const abs = [...pre, ...ref.instPath];
        if (abs.length <= path.length || !startsWith(abs, path)) continue;
        const id = `inst:${abs[path.length]}`;
        const direct = abs.length === path.length + 1;
        if (direct && ref.port) push(out.pins, `${id}/${ref.signal}`, mk);
        if (!badged.has(id)) { badged.add(id); bump(id, f.level, !direct); }
      } else {
        for (const inst of mod.instances) {
          const id = `inst:${inst.key}`;
          if (inst.moduleName === ref.module) {
            if (ref.port) push(out.pins, `${id}/${ref.signal}`, mk);
            if (!badged.has(id)) { badged.add(id); bump(id, f.level, false); }
          } else if (below(inst.moduleName).has(ref.module) && !badged.has(id)) {
            badged.add(id);
            bump(id, f.level, true);
          }
        }
      }
    }
  }
  return out;
}

/** Findings whose primary signal is declared in the module at (top, path). */
export function countAt(d: Design, run: Run | undefined, res: Map<number, Resolution>, top: string, path: string[]): number {
  if (!run) return 0;
  const pre = dutPrefix(d, top, run.dutTop);
  let c = 0;
  for (const r of res.values()) {
    const p = r.primary;
    if (!p || p.status !== 'ok') continue;
    if (pre === null) { if (p.module === moduleAtPath(d, top, path)?.name) c++; continue; }
    const abs = [...pre, ...p.instPath];
    if (abs.length === path.length && startsWith(abs, path)) c++;
  }
  return c;
}
