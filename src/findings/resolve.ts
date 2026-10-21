// Maps a finding's logicalLocations (tb.dut.<port>) onto the parsed RTL:
// the DUT module, the port declaration and whatever drives it inside that module.

import { Design, Driver, Module, Port } from '../model';
import { isNet, moduleAtPath } from '../elab';
import { Finding, LogicalLoc, Run, primaryOf } from './run';

export type ResolveStatus = 'ok' | 'no-dut' | 'no-instance' | 'no-signal';

export interface SignalRef {
  fqn: string;
  role: string;
  signal: string;          // identifier without bit-select
  instPath: string[];      // instance path below the DUT top
  module?: string;         // module that declares the signal
  port?: Port;
  isNet: boolean;          // declared as an internal net (not a port)
  drivers: Driver[];
  status: ResolveStatus;
  reason?: string;         // human-readable, when status !== 'ok'
}

export interface Resolution {
  primary?: SignalRef;
  context: SignalRef[];
  dutModule?: string;
}

function splitFqn(run: Run, fqn: string): { instPath: string[]; signal: string } | null {
  const pre = run.dutInstance;
  let rest: string;
  if (pre && fqn === pre) return { instPath: [], signal: '' };
  if (pre && fqn.startsWith(pre + '.')) rest = fqn.slice(pre.length + 1);
  else return null;
  // Split on dots outside brackets (hierarchical names may carry generate indices, e.g. gen[0].u).
  const parts: string[] = [];
  let depth = 0, cur = '';
  for (const c of rest) {
    if (c === '[') depth++;
    if (c === ']') depth--;
    if (c === '.' && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  const last = parts.pop() ?? '';
  return { instPath: parts, signal: last.replace(/\[.*$/, '') };
}

export function resolveSignal(d: Design, run: Run, l: LogicalLoc): SignalRef {
  const base: SignalRef = { fqn: l.fqn, role: l.role ?? '', signal: l.name.replace(/\[.*$/, ''), instPath: [], isNet: false, drivers: [], status: 'ok' };
  const top = d.modules[run.dutTop];
  if (!top) return { ...base, status: 'no-dut', reason: `DUT module "${run.dutTop}" is not in the parsed RTL` };
  const sp = splitFqn(run, l.fqn);
  const instPath = sp?.instPath ?? [];
  const signal = sp?.signal || base.signal;
  const m: Module | undefined = moduleAtPath(d, run.dutTop, instPath);
  if (!m) return { ...base, instPath, signal, status: 'no-instance', reason: `no instance path "${instPath.join('.')}" under ${run.dutTop}` };
  const port = m.ports.find(p => p.name === signal);
  const net = !port && isNet(m, signal);
  if (!port && !net) {
    return { ...base, instPath, signal, module: m.name, status: 'no-signal', reason: `${m.name} has no port or net named "${signal}"` };
  }
  return {
    ...base, instPath, signal, module: m.name, port, isNet: net,
    drivers: m.drivers.filter(x => x.signal === signal),
    status: 'ok',
  };
}

export function resolveFinding(d: Design, run: Run, f: Finding): Resolution {
  const prim = primaryOf(f);
  return {
    dutModule: d.modules[run.dutTop] ? run.dutTop : undefined,
    primary: prim ? resolveSignal(d, run, prim) : undefined,
    context: f.logical.filter(l => l.kind === 'variable' && l !== prim).map(l => resolveSignal(d, run, l)),
  };
}
