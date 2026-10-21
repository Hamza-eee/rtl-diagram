// Builds the diagram for one module (its ports, child instances and own logic)
// and lays it out with ELK. Output is plain data posted to the webview.

import { Design, Module, Port, SrcLoc } from './model';
import { isNet, resolveConnections } from './elab';

// elkjs ships without types for the bundled entry point.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ELK = require('elkjs/lib/elk.bundled.js');

export type PinDir = 'input' | 'output' | 'inout' | 'unknown';

export interface VPin {
  id: string;
  name: string;
  dir: PinDir;
  side: 'W' | 'E';
  x: number; y: number;           // absolute, pin anchor on the node edge
  width?: number;                 // bits
  range: string;                  // e.g. "[7:0]"
  expr?: string;                  // actual expression for instance pins
  open?: boolean;                 // left unconnected `.p()`
  tie?: boolean;                  // connected to a constant only
  netLabels?: string[];           // nets drawn as labels at this pin instead of wires
  loc?: SrcLoc;
}

export interface ViewOptions {
  /** Nets with at least this many loads are drawn as labels (0 disables). */
  labelFanout: number;
  /** Nets whose name matches are drawn as labels (e.g. clocks and resets). Empty disables. */
  labelPattern: string;
}

export const DEFAULT_VIEW_OPTIONS: ViewOptions = {
  labelFanout: 6,
  labelPattern: '(^|_)(h|a)?(clk|clock|rst|reset)(_?n|_?i|_?ni)?$',
};

export interface VNode {
  id: string;
  kind: 'in' | 'out' | 'inout' | 'inst' | 'logic';
  label: string;
  sub?: string;                   // module name for instances
  x: number; y: number; w: number; h: number;
  pins: VPin[];
  drillable: boolean;
  missing?: boolean;              // instance of a module not found in sources
  generate?: string;
  params?: { name: string; expr: string }[];
  loc?: SrcLoc;
  defLoc?: SrcLoc;                // module definition (for instances)
}

export interface VEdge {
  id: string;
  net: string;
  width?: number;
  from: string; to: string;       // pin ids
  points: [number, number][];
}

export interface ViewGraph {
  module: string;
  file: string;
  pkg?: string;
  w: number; h: number;
  nodes: VNode[];
  edges: VEdge[];
  nets: Record<string, string[]>; // net -> edge ids (for highlight)
  labels: Record<string, string[]>; // net -> pin ids, for nets drawn as labels
  stats: { instances: number; ports: number; nets: number };
}

const PITCH = 18;
const HEAD = 38;
const CHAR = 7.2;      // ~12px monospace advance
const PAD = 14;

function textW(s: string) { return s.length * CHAR; }

function pinDir(d: Port['dir']): PinDir {
  return d === 'input' || d === 'output' || d === 'inout' ? d : 'unknown';
}

interface Endpoint { pin: string; role: 'src' | 'sink' | 'bi'; width?: number }

export async function buildView(d: Design, m: Module, opts: ViewOptions = DEFAULT_VIEW_OPTIONS): Promise<ViewGraph> {
  const nodes: VNode[] = [];
  const nets = new Map<string, Endpoint[]>();
  const addEp = (net: string, ep: Endpoint) => {
    if (!isNet(m, net)) return;
    const l = nets.get(net) ?? [];
    l.push(ep);
    nets.set(net, l);
  };

  // Module ports as boundary terminals.
  for (const p of m.ports) {
    const kind = p.dir === 'input' ? 'in' : p.dir === 'output' ? 'out' : 'inout';
    const id = `port:${p.name}`;
    const label = p.name;
    const range = p.packed + (p.unpacked ? ' ' + p.unpacked : '');
    const w = Math.max(70, textW(label) + 28);
    nodes.push({
      id, kind, label, x: 0, y: 0, w, h: 24, drillable: false, loc: p.loc,
      pins: [{ id: `${id}/p`, name: p.name, dir: pinDir(p.dir), side: kind === 'in' ? 'E' : 'W', x: 0, y: 0, width: p.width, range, loc: p.loc }],
    });
    addEp(p.name, { pin: `${id}/p`, role: p.dir === 'input' ? 'src' : p.dir === 'output' ? 'sink' : 'bi', width: p.width });
  }

  // Child instances.
  m.instances.forEach((inst, i) => {
    const child = d.modules[inst.moduleName];
    const conns = resolveConnections(d, m, i);
    const id = `inst:${inst.name}`;
    const pins: VPin[] = [];
    const seen = new Set<string>();
    const pinFor = (name: string, dir: PinDir, cp?: Port) => {
      if (seen.has(name)) return pins.find(p => p.name === name)!;
      seen.add(name);
      const pin: VPin = {
        id: `${id}/${name}`, name, dir, side: dir === 'input' ? 'W' : dir === 'unknown' ? 'W' : 'E', x: 0, y: 0,
        width: cp?.width, range: cp ? cp.packed + (cp.unpacked ? ' ' + cp.unpacked : '') : '', loc: cp?.loc,
      };
      pins.push(pin);
      return pin;
    };
    // Every formal port of the child gets a pin, connected or not.
    if (child) for (const cp of child.ports) pinFor(cp.name, pinDir(cp.dir), cp);
    for (const c of conns) {
      const cp = child?.ports.find(p => p.name === c.port);
      const pin = pinFor(c.port, pinDir(c.dir), cp);
      pin.expr = c.expr;
      pin.open = c.expr === '';
      pin.tie = c.expr !== '' && c.signals.length === 0;
      for (const s of c.signals) {
        addEp(s, { pin: pin.id, role: c.dir === 'output' ? 'src' : c.dir === 'input' ? 'sink' : 'bi', width: pin.width });
      }
    }
    // Ports with no connection entry at all (not listed, no .*) are open.
    for (const p of pins) if (p.expr === undefined) p.open = true;
    nodes.push({
      id, kind: 'inst', label: inst.name, sub: inst.moduleName, x: 0, y: 0, w: 0, h: 0, pins,
      drillable: !!child, missing: !child, generate: inst.generate, params: inst.params, loc: inst.loc, defLoc: child?.headerLoc,
    });
  });

  // The module's own logic (assign / always), as one node.
  const driven = new Set(m.drivers.filter(x => x.kind !== 'instance').map(x => x.signal).filter(s => isNet(m, s)));
  const read = m.reads.filter(s => isNet(m, s) && !driven.has(s));
  if (driven.size || read.length) {
    const pins: VPin[] = [];
    for (const s of read) pins.push({ id: `logic/${s}`, name: s, dir: 'input', side: 'W', x: 0, y: 0, range: '' });
    for (const s of driven) pins.push({ id: `logic/${s}`, name: s, dir: 'output', side: 'E', x: 0, y: 0, range: '' });
    for (const p of pins) addEp(p.name, { pin: p.id, role: p.dir === 'output' ? 'src' : 'sink' });
    const first = m.drivers.find(x => x.kind !== 'instance');
    nodes.push({ id: 'logic', kind: 'logic', label: 'logic', sub: 'assign / always', x: 0, y: 0, w: 0, h: 0, pins, drillable: false, loc: first?.loc });
  }

  // Nets → edges (driver → each load).
  const edges: VEdge[] = [];
  const netEdges: Record<string, string[]> = {};
  const labels: Record<string, string[]> = {};
  let rx: RegExp | null = null;
  try { rx = opts.labelPattern ? new RegExp(opts.labelPattern, 'i') : null; } catch { rx = null; }
  const pinOf = new Map<string, VPin>();
  for (const n of nodes) for (const p of n.pins) pinOf.set(p.id, p);
  for (const [net, eps] of [...nets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (eps.length < 2) continue;
    const loads = eps.filter(e => e.role !== 'src').length;
    if ((rx && rx.test(net)) || (opts.labelFanout > 0 && loads >= opts.labelFanout)) {
      // Drawn as a named stub at every pin: same connectivity, far less clutter.
      labels[net] = eps.map(e => e.pin);
      for (const e of eps) { const p = pinOf.get(e.pin)!; (p.netLabels ??= []).push(net); }
      continue;
    }
    let srcs = eps.filter(e => e.role === 'src');
    let sinks = eps.filter(e => e.role !== 'src');
    if (!srcs.length) { srcs = [eps[0]]; sinks = eps.slice(1); }
    const width = eps.map(e => e.width).find(w => w !== undefined);
    for (const s of srcs) for (const t of sinks) {
      if (s.pin === t.pin) continue;
      const id = `e${edges.length}`;
      edges.push({ id, net, width, from: s.pin, to: t.pin, points: [] });
      (netEdges[net] ??= []).push(id);
    }
  }

  // Size nodes from their pins.
  for (const n of nodes) {
    if (n.kind !== 'inst' && n.kind !== 'logic') continue;
    const L = n.pins.filter(p => p.side === 'W'), R = n.pins.filter(p => p.side === 'E');
    const lw = Math.max(0, ...L.map(p => textW(p.name)));
    const rw = Math.max(0, ...R.map(p => textW(p.name)));
    n.w = Math.ceil(Math.max(textW(n.label) + 2 * PAD + 30, textW(n.sub ?? '') + 2 * PAD, lw + rw + 3 * PAD + 10, 120));
    n.h = HEAD + Math.max(L.length, R.length, 1) * PITCH + 10;
  }

  const g = await layout(nodes, edges);
  return {
    module: m.name, file: m.file, pkg: m.pkg, w: g.w, h: g.h, nodes, edges, nets: netEdges, labels,
    stats: { instances: m.instances.length, ports: m.ports.length, nets: Object.keys(netEdges).length + Object.keys(labels).length },
  };
}

async function layout(nodes: VNode[], edges: VEdge[]): Promise<{ w: number; h: number }> {
  const elk = new ELK();
  const pinIndex = new Map<string, { node: VNode; pin: VPin }>();
  const children = nodes.map(n => {
    const W = n.pins.filter(p => p.side === 'W'), E = n.pins.filter(p => p.side === 'E');
    const ports = n.pins.map(p => {
      pinIndex.set(p.id, { node: n, pin: p });
      const list = p.side === 'W' ? W : E;
      const i = list.indexOf(p);
      const terminal = n.kind !== 'inst' && n.kind !== 'logic';
      return {
        id: p.id, width: 1, height: 1,
        // Fixed positions so pins sit on the drawn pitch; boundary terminals have one pin centred.
        x: p.side === 'W' ? 0 : n.w - 1,
        y: terminal ? n.h / 2 : HEAD + i * PITCH + PITCH / 2,
        layoutOptions: { 'elk.port.side': p.side === 'W' ? 'WEST' : 'EAST' },
      };
    });
    const layer = n.kind === 'in' ? 'FIRST' : (n.kind === 'out' || n.kind === 'inout') ? 'LAST' : 'NONE';
    return {
      id: n.id, width: n.w, height: n.h, ports,
      layoutOptions: {
        'elk.portConstraints': 'FIXED_POS',
        ...(layer !== 'NONE' ? { 'elk.layered.layering.layerConstraint': layer } : {}),
      },
    };
  });
  const res = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.spacing.nodeNodeBetweenLayers': '70',
      'elk.spacing.nodeNode': '28',
      'elk.layered.spacing.edgeNodeBetweenLayers': '18',
      'elk.spacing.edgeEdge': '8',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.crossingMinimization.semiInteractive': 'false',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.padding': '[top=30,left=30,bottom=30,right=30]',
      'elk.randomSeed': '1',
      // Keep terminals whose nets are drawn as labels in the port columns instead of a separate row.
      'elk.separateConnectedComponents': 'false',
    },
    children,
    edges: edges.map(e => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  });
  const byId = new Map<string, any>(res.children.map((c: any) => [c.id, c]));
  for (const n of nodes) {
    const c = byId.get(n.id);
    n.x = c.x; n.y = c.y;
    for (const p of n.pins) {
      const cp = c.ports.find((q: any) => q.id === p.id);
      p.x = n.x + (p.side === 'W' ? 0 : n.w);
      p.y = n.y + (cp ? cp.y : n.h / 2);
    }
  }
  const eById = new Map<string, any>((res.edges ?? []).map((e: any) => [e.id, e]));
  for (const e of edges) {
    const s = eById.get(e.id)?.sections?.[0];
    const a = pinIndex.get(e.from)!.pin, b = pinIndex.get(e.to)!.pin;
    if (s) {
      // ELK's start/end points sit on the 1px port box; keep them so segments stay orthogonal,
      // and extend to the drawn pin anchor (same y by construction).
      const pts: [number, number][] = [[s.startPoint.x, s.startPoint.y],
        ...(s.bendPoints ?? []).map((p: any) => [p.x, p.y] as [number, number]), [s.endPoint.x, s.endPoint.y]];
      if (Math.abs(pts[0][0] - a.x) > 0.5) pts.unshift([a.x, pts[0][1]]);
      if (Math.abs(pts[pts.length - 1][0] - b.x) > 0.5) pts.push([b.x, pts[pts.length - 1][1]]);
      e.points = pts;
    } else {
      const mx = (a.x + b.x) / 2;
      e.points = [[a.x, a.y], [mx, a.y], [mx, b.y], [b.x, b.y]];
    }
  }
  return { w: res.width ?? 800, h: res.height ?? 600 };
}
