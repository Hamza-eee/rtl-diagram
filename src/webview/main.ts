// Diagram webview: renders the laid-out module graph as SVG, handles pan/zoom,
// drill-in, selection, the findings drawer and the minimap.

import type { ViewGraph, VNode, VPin, VEdge } from '../graph';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): any; setState(s: any): void };
const vscode = acquireVsCodeApi();

type Level = 'error' | 'warning' | 'note' | 'none';
interface Marker { f: number; level: Level; role: 'primary' | 'context' | 'driver' }
interface Markers { pins: Record<string, Marker[]>; nodes: Record<string, { error: number; warning: number; note: number; inside: boolean }>; nets: Record<string, Marker[]>; byModule: boolean }
interface FindingRow { index: number; ruleId: string; level: Level; message: string; signal: string; module?: string; resolved: boolean; here: boolean }
interface Crumb { label: string; sub: string; path: string[] }
type NoteKind = 'note' | 'question' | 'issue';
type NoteTarget = { type: 'module' } | { type: 'port'; name: string } | { type: 'net'; name: string };
interface NoteAnchor { module: string; target: NoteTarget; scope?: { top: string; instPath: string[] } }
interface NoteView {
  id: string; kind: NoteKind; text: string; author: string; created: string; updated?: string;
  resolved: boolean; label: string; detached?: string; anchor: NoteAnchor;
}
interface NoteMark { ids: string[]; kind: NoteKind; resolved: boolean; inside: boolean }
interface NotesMsg { marks: Record<string, NoteMark>; here: string[]; all: NoteView[]; issues: string[] }
interface LiveState { on: boolean; pending: string[] }
interface ViewMsg {
  graph: ViewGraph; crumbs: Crumb[]; markers: Markers; findings: FindingRow[]; notes: NotesMsg; path: string[];
  run: {
    id: string; status: string; dutTop: string; testbench: string; broken: boolean; commit?: string; dirty: boolean;
    freshness: { state: 'same' | 'changed' | 'unknown'; reason: string; changed: { file: string; rel: string }[] } | null;
  } | null;
  live: LiveState;
  sourceMode: string; tops: string[]; top: string; select?: { finding?: number; node?: string; note?: string };
}

const SVGNS = 'http://www.w3.org/2000/svg';
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------- state
let view: ViewMsg | null = null;
let T = { x: 0, y: 0, k: 1 };
let selection: { kind: 'node' | 'pin' | 'net'; id: string } | null = null;
let activeFinding: number | null = null;
let detail: any = null;
let tab: 'findings' | 'notes' | 'details' = 'findings';
/** A note being written: where it goes, and the form state (kept across re-renders). */
let draft: { anchor: NoteAnchor; label: string; scope: { top: string; instPath: string[] } | null; kind: NoteKind; text: string; onlyHere: boolean } | null = null;
let editing: { id: string; text: string; kind: NoteKind } | null = null;
let focusNotes: string[] = [];
let live: LiveState = { on: true, pending: [] };
let drawerOpen = true;
let themeMode: 'auto' | 'light' | 'dark' = 'auto';
let portGroupColors: Record<string, string> = {};
const saved = vscode.getState() ?? {};
const viewTransforms: Record<string, typeof T> = saved.viewTransforms ?? {};
drawerOpen = saved.drawerOpen ?? true;

// ---------------------------------------------------------------- dom helpers
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}
function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...kids: (Node | null | undefined)[]): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, String(v));
  }
  for (const c of kids) if (c) e.append(c);
  return e;
}
/** Drop null/false entries so conditional children can be written inline. */
function nodes(...xs: (Node | string | null | undefined | false)[]): (Node | string)[] {
  return xs.filter((x): x is Node | string => x !== null && x !== undefined && x !== false);
}
function text(x: number, y: number, str: string, cls: string, anchor: 'start' | 'middle' | 'end' = 'start') {
  const t = s('text', { x, y, class: cls, 'text-anchor': anchor });
  t.textContent = str;
  return t;
}
function icon(name: string) {
  // Small inline icon set (stroke icons, 16px grid).
  const paths: Record<string, string> = {
    fit: 'M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4',
    plus: 'M8 3v10M3 8h10',
    minus: 'M3 8h10',
    up: 'M8 13V3M4 7l4-4 4 4',
    drawer: 'M2 3h12v10H2zM10 3v10',
    theme: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2v12',
    search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM11 11l3.5 3.5',
    open: 'M9 2h5v5M14 2 7 9M12 9v5H2V4h5',
    copy: 'M5 5h8v9H5zM3 11V2h8',
    term: 'M2 3h12v10H2zM4.5 6.5 6.5 8l-2 1.5M8 10h3.5',
    file: 'M4 1.5h5.5L12.5 4.5v10h-8.5zM9.5 1.5v3h3',
  };
  const e = s('svg', { viewBox: '0 0 16 16', width: 16, height: 16, class: 'ico', 'aria-hidden': 'true' });
  e.append(s('path', { d: paths[name] ?? '', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  return e;
}

// ---------------------------------------------------------------- layout skeleton
const app = document.getElementById('app')!;
const toolbar = h('header', { class: 'toolbar' });
const crumbsEl = h('nav', { class: 'crumbs', 'aria-label': 'Hierarchy' });
const findInput = h('input', { class: 'find', type: 'search', placeholder: 'Find block or port', 'aria-label': 'Find block or port', spellcheck: 'false' });
const findResults = h('ul', { class: 'find-results', role: 'listbox', hidden: true });
const zoomLabel = h('button', { class: 'zoom-label', title: 'Reset to 100% (0)' }, '100%');
const themeBtn = h('button', { class: 'tb-btn', title: 'Theme: follow VS Code' }, icon('theme'), h('span', { class: 'tb-btn-label' }, 'Auto'));
const drawerBtn = h('button', { class: 'tb-btn', title: 'Toggle side panel' }, icon('drawer'));
const liveBtn = h('button', { class: 'tb-btn live-btn', 'aria-pressed': 'true' }, h('span', { class: 'live-dot', 'aria-hidden': 'true' }), h('span', { class: 'tb-btn-label' }, 'Live'));
liveBtn.addEventListener('click', () => vscode.postMessage({ type: 'setLive', on: !live.on }));
const upBtn = h('button', { class: 'tb-btn', title: 'Up one level (Backspace)' }, icon('up'));
toolbar.append(
  upBtn, crumbsEl,
  h('div', { class: 'tb-spacer' }),
  h('div', { class: 'find-wrap' }, icon('search'), findInput, findResults),
  h('div', { class: 'tb-group', role: 'group', 'aria-label': 'Zoom' },
    h('button', { class: 'tb-btn', title: 'Zoom out (−)', onclick: () => zoomBy(1 / 1.25) }, icon('minus')),
    zoomLabel,
    h('button', { class: 'tb-btn', title: 'Zoom in (+)', onclick: () => zoomBy(1.25) }, icon('plus')),
    h('button', { class: 'tb-btn', title: 'Fit to window (F)', onclick: () => fit(true) }, icon('fit')),
  ),
  liveBtn, themeBtn, drawerBtn,
);
const stage = h('main', { class: 'stage', tabindex: '0', 'aria-label': 'Block diagram' });
const svg = s('svg', { class: 'canvas', role: 'img' });
const defs = s('defs');
defs.innerHTML = `<pattern id="grid" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.9" class="grid-dot"/></pattern>`;
const gridRect = s('rect', { class: 'grid', x: -1e5, y: -1e5, width: 2e5, height: 2e5, fill: 'url(#grid)' });
const world = s('g', { class: 'world' });
const gEdges = s('g', { class: 'edges' });
const gNodes = s('g', { class: 'nodes' });
const gMarks = s('g', { class: 'marks' });
const gNotes = s('g', { class: 'notes-layer' });
world.append(gridRect, gEdges, gNodes, gMarks, gNotes);
svg.append(defs, world);
const tooltip = h('div', { class: 'tip', role: 'tooltip', hidden: true });
const minimap = h('div', { class: 'minimap', title: 'Overview: drag to move' });
const miniSvg = s('svg', { class: 'mini' });
minimap.append(miniSvg);
const overlay = h('div', { class: 'overlay', hidden: true });
const moduleNotesChip = h('button', { class: 'module-notes', hidden: true });
const pendingBanner = h('div', { class: 'pending-banner', role: 'status', hidden: true });
const ctxMenu = h('div', { class: 'ctxmenu', role: 'menu', hidden: true });
stage.append(svg, tooltip, minimap, moduleNotesChip, pendingBanner, ctxMenu, overlay);

const drawer = h('aside', { class: 'drawer', 'aria-label': 'Findings and details' });
const statusEl = h('footer', { class: 'status' });
const body = h('div', { class: 'body' }, stage, drawer);
app.append(toolbar, body, statusEl);

// ---------------------------------------------------------------- transform
function applyT() {
  world.setAttribute('transform', `translate(${T.x} ${T.y}) scale(${T.k})`);
  zoomLabel.textContent = `${Math.round(T.k * 100)}%`;
  svg.classList.toggle('far', T.k < 0.45);
  drawMiniViewport();
  if (view) { viewTransforms[viewKey()] = { ...T }; persist(); }
}
function viewKey() { return view ? `${view.top}/${view.crumbs[view.crumbs.length - 1].path.join('/')}` : ''; }
function persist() { vscode.setState({ viewTransforms, drawerOpen }); }
function zoomAt(cx: number, cy: number, f: number) {
  const k = Math.min(4, Math.max(0.08, T.k * f));
  const r = k / T.k;
  T = { k, x: cx - (cx - T.x) * r, y: cy - (cy - T.y) * r };
  applyT();
}
function zoomBy(f: number) {
  const b = stage.getBoundingClientRect();
  zoomAt(b.width / 2, b.height / 2, f);
}
function fit(animate = false) {
  if (!view) return;
  const b = stage.getBoundingClientRect();
  const g = view.graph;
  const k = Math.min(1.6, Math.max(0.08, Math.min((b.width - 40) / g.w, (b.height - 40) / g.h)));
  const target = { k, x: (b.width - g.w * k) / 2, y: (b.height - g.h * k) / 2 };
  animateTo(target, animate);
}
function centerOn(x: number, y: number, k = Math.max(T.k, 0.9)) {
  const b = stage.getBoundingClientRect();
  animateTo({ k, x: b.width / 2 - x * k, y: b.height / 2 - y * k }, true);
}
let anim = 0;
function animateTo(target: typeof T, animate: boolean) {
  cancelAnimationFrame(anim);
  if (!animate || reduceMotion) { T = target; applyT(); return; }
  const from = { ...T };
  const t0 = performance.now();
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / 240);
    const e = 1 - Math.pow(1 - p, 3);
    T = { k: from.k + (target.k - from.k) * e, x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e };
    applyT();
    if (p < 1) anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}

// pan & zoom input
let drag: { x: number; y: number; tx: number; ty: number; moved: boolean } | null = null;
stage.addEventListener('wheel', e => {
  e.preventDefault();
  const b = stage.getBoundingClientRect();
  const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0018));
  zoomAt(e.clientX - b.left, e.clientY - b.top, f);
}, { passive: false });
stage.addEventListener('pointerdown', e => {
  if (e.button !== 0 && e.button !== 1) return;
  if ((e.target as Element).closest('.minimap')) return;
  // No pointer capture yet: capturing here would retarget the click/dblclick
  // that follows to the stage, so blocks could never be selected or opened.
  drag = { x: e.clientX, y: e.clientY, tx: T.x, ty: T.y, moved: false };
});
stage.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  if (!drag.moved) stage.setPointerCapture(e.pointerId);   // a real pan: keep it even if the pointer leaves
  drag.moved = true;
  stage.classList.add('panning');
  hideTip();
  T = { ...T, x: drag.tx + dx, y: drag.ty + dy };
  applyT();
});
let swallowClick = false;
stage.addEventListener('pointerup', e => {
  const wasDrag = drag?.moved;
  drag = null;
  stage.classList.remove('panning');
  swallowClick = !!wasDrag;
  if (!wasDrag && (e.target === svg || e.target === gridRect)) { select(null); }
});
// Double-click on empty space goes up one level (the opposite of double-clicking a block).
stage.addEventListener('dblclick', e => {
  if (e.target === svg || e.target === gridRect) { e.preventDefault(); goUp(); }
});
// A pan that ends over a block must not also select it.
stage.addEventListener('click', e => { if (swallowClick) { swallowClick = false; e.stopPropagation(); } }, true);
new ResizeObserver(() => { if (view) drawMiniViewport(); }).observe(stage);

// ---------------------------------------------------------------- colours
const AXI_RX = /^(?:[a-z]+_)?(?:[sm]_?axil?_?|axi_?)?(aw|w|b|ar|r)(valid|ready|addr|prot|data|strb|resp|id|len|size|burst|lock|cache|qos|region|user|last)$/i;
const CLKRST_RX = /(^|_)(a?clk|clock|a?rst|reset|a?resetn|rst_?n|nrst)(_[a-z]+)?$|^h(clk|resetn)$/i;
function pinGroup(name: string): string | null {
  let best = '';
  for (const p of Object.keys(portGroupColors)) if (name.startsWith(p) && p.length > best.length) best = p;
  if (best) return `custom:${best}`;
  if (CLKRST_RX.test(name)) return 'clk';
  const m = name.match(AXI_RX);
  if (m) return `ch-${m[1].toLowerCase()}`;
  return null;
}
function pinColorAttr(name: string): Record<string, string> {
  const g = pinGroup(name);
  if (!g) return {};
  if (g.startsWith('custom:')) return { style: `--pin:${portGroupColors[g.slice(7)]}` };
  return { 'data-group': g };
}
function tier(w?: number) { return w === undefined ? 't1' : w <= 1 ? 't1' : w <= 8 ? 't2' : 't3'; }

// ---------------------------------------------------------------- render
let nodeById = new Map<string, VNode>();
let pinById = new Map<string, { pin: VPin; node: VNode }>();
let edgeEls = new Map<string, SVGGElement>();
let pinEdges = new Map<string, string[]>();

function render(msg: ViewMsg) {
  const prevKey = view ? viewKey() : null;
  // A note draft or edit belongs to the view it was started in: drop it when the top changes
  // (which includes switching project), so it can't be saved against the wrong anchor.
  if (view && view.top !== msg.top) { draft = null; editing = null; focusNotes = []; }
  view = msg;
  const g = msg.graph;
  nodeById = new Map(g.nodes.map(n => [n.id, n]));
  pinById = new Map();
  for (const n of g.nodes) for (const p of n.pins) pinById.set(p.id, { pin: p, node: n });
  pinEdges = new Map();
  for (const e of g.edges) {
    (pinEdges.get(e.from) ?? pinEdges.set(e.from, []).get(e.from)!).push(e.id);
    (pinEdges.get(e.to) ?? pinEdges.set(e.to, []).get(e.to)!).push(e.id);
  }
  overlay.hidden = true;
  gEdges.replaceChildren(); gNodes.replaceChildren(); gMarks.replaceChildren(); gNotes.replaceChildren();
  edgeEls = new Map();
  for (const e of g.edges) drawEdge(e, msg.markers);
  drawJunctions(g);
  for (const n of g.nodes) drawNode(n, msg.markers);
  drawMarkers(msg);
  drawNotes(msg);
  svg.setAttribute('aria-label', `Block diagram of ${g.module}: ${g.stats.instances} instances, ${g.stats.ports} ports`);
  live = msg.live ?? live;
  renderLive();
  renderCrumbs();
  renderStatus();
  renderMinimap();
  const key = viewKey();
  const savedT = viewTransforms[key];
  if (key !== prevKey) { if (savedT) { T = savedT; applyT(); } else fit(false); }
  selection = null;
  if (msg.select?.finding !== undefined) {
    activeFinding = msg.select.finding;
    tab = 'details';
    focusFinding(msg.select.finding);
  } else if (msg.select?.node) {
    select({ kind: 'node', id: msg.select.node });
  } else if (msg.select?.note) {
    openNotes([msg.select.note], true);
    return;
  }
  renderDrawer();
}

function drawEdge(e: VEdge, mk: Markers) {
  const d = e.points.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ');
  const flagged = mk.nets[e.net]?.find(m => m.role === 'primary') ?? mk.nets[e.net]?.[0];
  const g = s('g', { class: `edge ${tier(e.width)}${flagged ? ` flag-${flagged.level} flag-${flagged.role}` : ''}`, 'data-net': e.net, 'data-id': e.id });
  g.append(s('path', { d, class: 'hit' }), s('path', { d, class: 'wire' }));
  // Bus notation: slash + bit count on the longest horizontal segment.
  if (e.width && e.width > 1 && e.points.length >= 2) {
    let best = -1, len = 0;
    for (let i = 0; i + 1 < e.points.length; i++) {
      const [a, b] = [e.points[i], e.points[i + 1]];
      const l = Math.abs(b[0] - a[0]);
      if (Math.abs(b[1] - a[1]) < 0.5 && l > len) { len = l; best = i; }
    }
    if (best >= 0 && len > 30) {
      const [a, b] = [e.points[best], e.points[best + 1]];
      const dir = Math.sign(b[0] - a[0]);
      const x = a[0] + dir * Math.min(24, len / 2), y = a[1];
      g.append(s('path', { d: `M${x - 4} ${y + 5}L${x + 4} ${y - 5}`, class: 'bus-slash' }), text(x + 5, y - 6, String(e.width), 'bus-w'));
    }
  }
  g.addEventListener('click', ev => { ev.stopPropagation(); select({ kind: 'net', id: e.net }); });
  g.addEventListener('pointerenter', ev => showTip(ev, netTip(e.net)));
  g.addEventListener('pointerleave', hideTip);
  gEdges.append(g);
  edgeEls.set(e.id, g);
}

function drawJunctions(g: ViewGraph) {
  for (const ids of Object.values(g.nets)) {
    if (ids.length < 2) continue;
    const count = new Map<string, number>();
    for (const id of ids) {
      const e = g.edges.find(x => x.id === id)!;
      for (const p of e.points.slice(1, -1)) { const k = `${p[0]},${p[1]}`; count.set(k, (count.get(k) ?? 0) + 1); }
    }
    for (const [k, c] of count) if (c >= 2) {
      const [x, y] = k.split(',').map(Number);
      const e = g.edges.find(x => x.id === ids[0])!;
      gEdges.append(s('circle', { cx: x, cy: y, r: 2.6, class: `junction ${tier(e.width)}`, 'data-net': e.net }));
    }
  }
}

function drawNode(n: VNode, mk: Markers) {
  const g = s('g', { class: `node k-${n.kind}${n.missing ? ' missing' : ''}${n.drillable ? ' drillable' : ''}`, 'data-id': n.id, tabindex: n.kind === 'inst' ? 0 : -1, role: 'button', 'aria-label': n.kind === 'inst' ? `${n.label}, instance of ${n.sub}` : `${n.kind} port ${n.label}` });
  const { x, y, w, h: hh } = n;
  if (n.kind === 'inst' || n.kind === 'logic') {
    if (n.generate) {
      // Stacked outline: this instance sits in a generate construct.
      g.append(s('rect', { x: x + 5, y: y - 5, width: w, height: hh, rx: 3, class: 'gen-shadow' }));
    }
    g.append(s('rect', { x, y, width: w, height: hh, rx: n.kind === 'logic' ? 10 : 3, class: 'body' }));
    if (n.kind === 'inst') {
      g.append(s('path', { d: `M${x + w / 2 - 7} ${y}a7 7 0 0 0 14 0`, class: 'notch' }));
      g.append(s('line', { x1: x, y1: y + 33, x2: x + w, y2: y + 33, class: 'head-rule' }));
    }
    g.append(text(x + 10, y + 16, n.label, n.kind === 'logic' ? 'n-title logic-title' : 'n-title'));
    g.append(text(x + 10, y + 28, n.missing ? `${n.sub} · not in sources` : (n.sub ?? ''), 'n-sub'));
    if (n.generate) {
      const tag = n.generate.length > 34 ? n.generate.slice(0, 33) + '…' : n.generate;
      g.append(text(x + w + 5, y - 9, tag, 'gen-tag', 'end'));
    }
    if (n.drillable) g.append(s('path', { d: `M${x + w - 15} ${y + 11}l4 4 4-4`, class: 'drill-hint' }));
    for (const p of n.pins) drawPin(g, n, p);
  } else {
    // Hierarchical port terminal (schematic flag shape).
    // Schematic convention: inputs sit on the left pointing into the module, outputs on the
    // right pointing out of it (both point rightward), inouts point both ways.
    const pts = n.kind === 'inout'
      ? `${x},${y + hh / 2} ${x + 10},${y} ${x + w - 10},${y} ${x + w},${y + hh / 2} ${x + w - 10},${y + hh} ${x + 10},${y + hh}`
      : `${x},${y} ${x + w - 10},${y} ${x + w},${y + hh / 2} ${x + w - 10},${y + hh} ${x},${y + hh}`;
    const p = n.pins[0];
    g.append(s('polygon', { points: pts, class: 'term', ...pinColorAttr(n.label) }));
    g.append(text(n.kind === 'inout' ? x + 14 : x + 8, y + hh / 2 + 4, n.label, 'term-label'));
    if (p) g.setAttribute('data-pin', p.id);
    if (p?.netLabels?.length) {
      // The terminal already names the net: a short stub with an open end marks "connects by label".
      const o = p.side === 'E' ? 1 : -1;
      const lg = s('g', { class: 'netlabel', 'data-net': p.netLabels[0] });
      lg.append(s('line', { x1: p.x, y1: p.y, x2: p.x + o * 12, y2: p.y, class: 'nl-lead' }), s('circle', { cx: p.x + o * 15, cy: p.y, r: 3, class: 'nl-box' }));
      g.append(lg);
    }
  }
  const m = mk.nodes[n.id];
  if (m) {
    const lvl: Level = m.error ? 'error' : m.warning ? 'warning' : 'note';
    const c = m.error + m.warning + m.note;
    const label = m.inside ? `${c} inside` : String(c);
    const bw = 12 + label.length * 6.4;
    const bx = x + w - bw / 2 - 2, by = y - 9;
    g.append(s('rect', { x: bx - bw / 2, y: by - 8, width: bw, height: 16, rx: 8, class: `badge lvl-${lvl}${m.inside ? ' inside' : ''}` }), text(bx, by + 4, label, `badge-t lvl-${lvl}${m.inside ? ' inside' : ''}`, 'middle'));
  }

  g.addEventListener('click', ev => {
    ev.stopPropagation();
    const pinEl = (ev.target as Element).closest('[data-pin]');
    if (pinEl) select({ kind: 'pin', id: pinEl.getAttribute('data-pin')! });
    else select({ kind: 'node', id: n.id });
  });
  g.addEventListener('dblclick', ev => {
    ev.stopPropagation();
    if (n.kind === 'inst' && n.drillable) drill(n);
    else if (n.loc) vscode.postMessage({ type: 'open', loc: n.loc });
  });
  g.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && n.drillable) drill(n);
    if (ev.key === ' ') { ev.preventDefault(); select({ kind: 'node', id: n.id }); }
  });
  g.addEventListener('pointermove', ev => {
    const pinEl = (ev.target as Element).closest('[data-pin]');
    if (pinEl) showTip(ev, pinTip(pinEl.getAttribute('data-pin')!));
    else showTip(ev, nodeTip(n));
  });
  g.addEventListener('pointerleave', hideTip);
  gNodes.append(g);
}

function drawPin(g: SVGGElement, n: VNode, p: VPin) {
  const out = p.side === 'E' ? 1 : -1;
  const pg = s('g', { class: `pin ${tier(p.width)}${p.open ? ' open' : ''}${p.tie ? ' tie' : ''}`, 'data-pin': p.id, ...pinColorAttr(p.name) });
  pg.append(s('line', { x1: p.x, y1: p.y, x2: p.x + out * 9, y2: p.y, class: 'stub' }));
  // Direction arrowhead on the stub: into the block for inputs, out of it for outputs, both for inouts.
  const head = (tip: number, back: number) => s('path', { d: `M${tip} ${p.y}L${back} ${p.y - 3.2}L${back} ${p.y + 3.2}Z`, class: 'pin-arrow' });
  if (p.dir === 'input') pg.append(head(p.x, p.x + out * 6));
  else if (p.dir === 'output') pg.append(head(p.x + out * 8, p.x + out * 2));
  else if (p.dir === 'inout') pg.append(head(p.x, p.x + out * 4.5), head(p.x + out * 9, p.x + out * 4.5));
  pg.append(s('rect', { x: p.side === 'E' ? p.x - 70 : p.x, y: p.y - 8, width: 70, height: 16, class: 'pin-hit' }));
  pg.append(text(p.x - out * 7, p.y + 4, p.name, 'pin-label', p.side === 'E' ? 'end' : 'start'));
  if (p.netLabels?.length) {
    drawNetLabel(pg, p.x + out * 9, p.y, out, p.netLabels[0], p.netLabels.length - 1);
  } else if (p.open) {
    const cx = p.x + out * 13;
    pg.append(s('path', { d: `M${cx - 3} ${p.y - 3}l6 6M${cx + 3} ${p.y - 3}l-6 6`, class: 'nc' }));
  } else if (p.tie && p.expr) {
    pg.append(text(p.x + out * 13, p.y - 4, p.expr, 'tie-label', p.side === 'E' ? 'start' : 'end'));
  }
  g.append(pg);
}

/** Named stub for a net drawn as labels (clock, reset, high fan-out). */
function drawNetLabel(g: SVGGElement, x: number, y: number, out: number, net: string, more: number) {
  const label = more > 0 ? `${net} +${more}` : net;
  const w = label.length * 6.2 + 12;
  const x0 = out > 0 ? x : x - w;
  const lg = s('g', { class: 'netlabel', 'data-net': net });
  lg.append(s('line', { x1: x, y1: y, x2: out > 0 ? x0 + 2 : x0 + w - 2, y2: y, class: 'nl-lead' }));
  lg.append(s('rect', { x: x0, y: y - 7, width: w, height: 14, rx: 7, class: 'nl-box' }));
  lg.append(text(x0 + w / 2, y + 3.5, label, 'nl-t', 'middle'));
  lg.addEventListener('click', ev => { ev.stopPropagation(); select({ kind: 'net', id: net }); });
  g.append(lg);
}

function drawMarkers(msg: ViewMsg) {
  for (const [pinId, list] of Object.entries(msg.markers.pins)) {
    const pp = pinById.get(pinId);
    if (!pp) continue;
    const { pin } = pp;
    const prim = list.find(m => m.role === 'primary');
    const ctx = list.find(m => m.role === 'context');
    const drv = list.find(m => m.role === 'driver');
    const m = prim ?? ctx ?? drv!;
    const g = s('g', { class: `probe lvl-${m.level} role-${m.role}`, 'data-f': m.f, 'data-pin': pinId });
    g.append(s('circle', { cx: pin.x, cy: pin.y, r: m.role === 'primary' ? 7 : 6, class: 'ring' }));
    if (prim) {
      // Probe: a leader up-and-out from the pin to a tag with the rule id.
      // Lean away from the diagram: outward from an instance pin, toward the body of a port terminal.
      const term = pp.node.kind !== 'inst' && pp.node.kind !== 'logic';
      const out = (pin.side === 'E' ? 1 : -1) * (term ? -1 : 1);
      const tx = pin.x + out * 22, ty = term ? pp.node.y - 16 : pin.y - 26;
      const row = msg.findings.find(f => f.index === prim.f);
      const more = list.filter(x => x.role === 'primary').length - 1;
      const label = `${row?.ruleId ?? 'finding'}${more > 0 ? ` +${more}` : ''}`;
      const tw = label.length * 6.6 + 14;
      const rx = out > 0 ? tx : tx - tw;
      g.append(s('path', { d: `M${pin.x + out * 5} ${pin.y - 5}L${tx} ${ty}`, class: 'leader' }));
      g.append(s('rect', { x: rx, y: ty - 9, width: tw, height: 18, rx: 4, class: 'tag' }));
      g.append(text(rx + tw / 2, ty + 4, label, 'tag-t', 'middle'));
      g.addEventListener('click', ev => { ev.stopPropagation(); openFinding(prim.f); });
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', `Finding ${label} on ${pin.name}`);
    } else if (drv) {
      g.append(text(pin.x + (pin.side === 'E' ? 10 : -10), pin.y + 15, 'driver', 'drv-t', pin.side === 'E' ? 'start' : 'end'));
    }
    g.addEventListener('pointermove', ev => showTip(ev, markerTip(list, pin.name)));
    g.addEventListener('pointerleave', hideTip);
    gMarks.append(g);
  }
}

function drill(n: VNode) {
  // Zoom toward the block before swapping views: the one orchestrated motion.
  if (!reduceMotion) {
    const b = stage.getBoundingClientRect();
    const k = Math.min(4, Math.min(b.width / n.w, b.height / n.h) * 0.7);
    animateTo({ k, x: b.width / 2 - (n.x + n.w / 2) * k, y: b.height / 2 - (n.y + n.h / 2) * k }, true);
    stage.classList.add('diving');
    setTimeout(() => { stage.classList.remove('diving'); vscode.postMessage({ type: 'drill', inst: n.key }); }, 200);
  } else vscode.postMessage({ type: 'drill', inst: n.key });
}

// ---------------------------------------------------------------- selection
function select(sel: typeof selection) {
  selection = sel;
  svg.classList.toggle('has-sel', !!sel);
  for (const el of svg.querySelectorAll('.sel, .lit')) el.classList.remove('sel', 'lit');
  if (!sel || !view) { renderDrawer(); return; }
  const lit = (net: string) => {
    svg.querySelectorAll(`.netlabel[data-net="${CSS.escape(net)}"]`).forEach(l => l.classList.add('lit'));
    for (const id of view!.graph.nets[net] ?? []) edgeEls.get(id)?.classList.add('lit'); svg.querySelectorAll(`.junction[data-net="${CSS.escape(net)}"]`).forEach(j => j.classList.add('lit'));
  };
  if (sel.kind === 'node') {
    const el = gNodes.querySelector(`[data-id="${CSS.escape(sel.id)}"]`);
    el?.classList.add('sel');
    const n = nodeById.get(sel.id);
    for (const p of n?.pins ?? []) for (const id of pinEdges.get(p.id) ?? []) edgeEls.get(id)?.classList.add('lit');
  } else if (sel.kind === 'pin') {
    const pp = pinById.get(sel.id);
    svg.querySelector(`.pin[data-pin="${CSS.escape(sel.id)}"]`)?.classList.add('sel');
    gNodes.querySelector(`[data-id="${CSS.escape(pp?.node.id ?? '')}"]`)?.classList.add('lit');
    const nets = new Set((pinEdges.get(sel.id) ?? []).map(id => view!.graph.edges.find(e => e.id === id)!.net));
    for (const n of pp?.pin.netLabels ?? []) nets.add(n);
    nets.forEach(lit);
  } else {
    lit(sel.id);
  }
  if (tab !== 'details' || activeFinding === null) { tab = 'details'; activeFinding = null; detail = null; }
  renderDrawer();
}

function focusFinding(idx: number) {
  if (!view) return;
  const pinId = Object.entries(view.markers.pins).find(([, l]) => l.some(m => m.f === idx && m.role === 'primary'))?.[0];
  for (const el of gMarks.querySelectorAll('.probe.active')) el.classList.remove('active');
  if (pinId) {
    const pp = pinById.get(pinId)!;
    selection = { kind: 'pin', id: pinId };
    for (const el of svg.querySelectorAll('.sel, .lit')) el.classList.remove('sel', 'lit');
    svg.classList.add('has-sel');
    svg.querySelector(`.pin[data-pin="${CSS.escape(pinId)}"]`)?.classList.add('sel');
    for (const id of pinEdges.get(pinId) ?? []) edgeEls.get(id)?.classList.add('lit');
    const pr = gMarks.querySelector(`.probe[data-pin="${CSS.escape(pinId)}"]`);
    if (pr) { pr.classList.remove('active'); void (pr as SVGGElement).getBBox(); pr.classList.add('active'); }
    centerOn(pp.pin.x, pp.pin.y);
  }
}

function openFinding(idx: number) {
  activeFinding = idx;
  tab = 'details';
  detail = null;
  renderDrawer();
  vscode.postMessage({ type: 'showFinding', index: idx });
}

// ---------------------------------------------------------------- tooltips
function showTip(ev: PointerEvent | MouseEvent, content: HTMLElement | null) {
  if (drag?.moved || !content) return;
  tooltip.replaceChildren(content);
  tooltip.hidden = false;
  const b = stage.getBoundingClientRect();
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  let x = ev.clientX - b.left + 14, y = ev.clientY - b.top + 16;
  if (x + tw > b.width - 8) x = ev.clientX - b.left - tw - 14;
  if (y + th > b.height - 8) y = ev.clientY - b.top - th - 12;
  tooltip.style.transform = `translate(${x}px, ${y}px)`;
}
function hideTip() { tooltip.hidden = true; }
function kv(k: string, v: string | Node) { return h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)); }
function pinTip(id: string) {
  const pp = pinById.get(id);
  if (!pp) return null;
  const { pin, node } = pp;
  const isTerm = node.kind !== 'inst' && node.kind !== 'logic';
  return h('div', {},
    h('div', { class: 'tip-title mono' }, pin.name),
    kv('direction', pin.dir), pin.range ? kv('range', pin.range) : null, pin.width ? kv('width', `${pin.width} bit${pin.width > 1 ? 's' : ''}`) : null,
    !isTerm && pin.expr !== undefined ? kv('connected', pin.expr === '' ? 'open' : pin.expr) : null,
    h('div', { class: 'tip-hint' }, 'Click to trace the net'));
}
function nodeTip(n: VNode) {
  if (n.kind !== 'inst' && n.kind !== 'logic') return pinTip(n.pins[0]?.id);
  return h('div', {},
    h('div', { class: 'tip-title' }, n.label, h('span', { class: 'mono muted' }, n.sub ? `  ${n.sub}` : '')),
    n.generate ? kv('generate', n.generate) : null,
    n.params?.length ? kv('params', n.params.map(p => `${p.name}=${p.expr}`).join(', ')) : null,
    h('div', { class: 'tip-hint' }, n.drillable ? 'Double-click to open the block' : n.kind === 'logic' ? 'Double-click to open the code' : 'Module not found in sources'));
}
function netTip(net: string) {
  const ids = view?.graph.nets[net] ?? [];
  const e = view?.graph.edges.find(x => x.id === ids[0]);
  return h('div', {}, h('div', { class: 'tip-title mono' }, net), e?.width ? kv('width', `${e.width} bit${e.width > 1 ? 's' : ''}`) : null, kv('connections', String(view?.graph.labels?.[net]?.length ?? ids.length + 1)));
}
function markerTip(list: Marker[], pin: string) {
  const rows = list.map(m => {
    const f = view?.findings.find(x => x.index === m.f);
    return h('div', { class: 'tip-f' }, h('span', { class: `dot lvl-${m.level}` }), h('span', {}, `${f?.ruleId ?? ''} · ${m.role === 'driver' ? 'direct driver of the observed signal' : m.role === 'primary' ? 'observed here' : 'context signal'}`));
  });
  return h('div', {}, h('div', { class: 'tip-title mono' }, pin), ...rows, h('div', { class: 'tip-hint' }, 'Click the tag to open the finding'));
}

// ---------------------------------------------------------------- toolbar bits
function renderCrumbs() {
  if (!view) return;
  crumbsEl.replaceChildren();
  view.crumbs.forEach((c, i) => {
    const last = i === view!.crumbs.length - 1;
    if (i) crumbsEl.append(h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'));
    if (i === 0 && view!.tops.length > 1) {
      const sel = h('select', { class: 'crumb-top', 'aria-label': 'Top module', onchange: (e: Event) => vscode.postMessage({ type: 'setTop', top: (e.target as HTMLSelectElement).value }) },
        ...view!.tops.map(t => h('option', { value: t, selected: t === view!.top }, t)));
      crumbsEl.append(sel);
    } else {
      crumbsEl.append(h('button', { class: `crumb${last ? ' current' : ''}`, 'aria-current': last ? 'page' : false, onclick: () => !last && vscode.postMessage({ type: 'goto', path: c.path }) },
        c.label, c.sub ? h('span', { class: 'crumb-sub' }, c.sub) : null));
    }
  });
  upBtn.disabled = view.crumbs.length < 2;
}
upBtn.addEventListener('click', goUp);
function goUp() {
  if (!view || view.crumbs.length < 2) return;
  vscode.postMessage({ type: 'goto', path: view.crumbs[view.crumbs.length - 2].path });
}
drawerBtn.addEventListener('click', () => { drawerOpen = !drawerOpen; body.classList.toggle('drawer-closed', !drawerOpen); persist(); });
body.classList.toggle('drawer-closed', !drawerOpen);
themeBtn.addEventListener('click', () => {
  const next = themeMode === 'auto' ? 'light' : themeMode === 'light' ? 'dark' : 'auto';
  vscode.postMessage({ type: 'setTheme', mode: next });
});
zoomLabel.addEventListener('click', () => {
  const b = stage.getBoundingClientRect();
  zoomAt(b.width / 2, b.height / 2, 1 / T.k);
});

/** Live toggle and, when paused, the banner listing RTL files saved since the diagram was drawn. */
function renderLive() {
  liveBtn.classList.toggle('paused', !live.on);
  liveBtn.setAttribute('aria-pressed', String(live.on));
  liveBtn.querySelector('.tb-btn-label')!.textContent = live.on ? 'Live' : 'Paused';
  liveBtn.title = live.on
    ? 'Live: the diagram redraws when RTL files are saved. Click to pause.'
    : 'Paused: the diagram stays as drawn. Click to go live (and refresh).';
  const n = live.pending.length;
  pendingBanner.hidden = live.on || n === 0;
  if (pendingBanner.hidden) return;
  pendingBanner.replaceChildren(
    h('span', { title: live.pending.join('\n') }, `RTL changed since this diagram was drawn: ${n} file${n === 1 ? '' : 's'} (${live.pending.slice(0, 2).join(', ')}${n > 2 ? ', …' : ''})`),
    h('button', { class: 'act primary', onclick: () => vscode.postMessage({ type: 'refresh' }) }, 'Refresh'),
    h('button', { class: 'act', onclick: () => vscode.postMessage({ type: 'setLive', on: true }) }, 'Go live'));
}

function renderStatus() {
  if (!view) return;
  const g = view.graph;
  statusEl.replaceChildren(...nodes(
    h('button', { class: 'st-link', title: 'Open module definition', onclick: () => vscode.postMessage({ type: 'openFile', file: g.file, line: 0 }) }, icon('file'), g.file.split('/').slice(-2).join('/')),
    g.pkg ? h('span', { class: 'st' }, `package ${g.pkg}`) : null,
    h('span', { class: 'st' }, `${g.stats.instances} instance${g.stats.instances === 1 ? '' : 's'} · ${g.stats.ports} ports · ${g.stats.nets} nets`),
    h('span', { class: 'st muted' }, view.sourceMode),
    h('span', { class: 'st-spacer' }),
    h('span', { class: 'st muted keys' }, 'Double-click a block to open it · double-click empty space or Backspace to go up · F fits'),
  ));
}

// find
function findCandidates(q: string) {
  if (!view || !q) return [];
  const ql = q.toLowerCase();
  const out: { label: string; sub: string; act: () => void }[] = [];
  for (const n of view.graph.nodes) {
    if (n.label.toLowerCase().includes(ql) || (n.sub ?? '').toLowerCase().includes(ql)) {
      out.push({ label: n.label, sub: n.kind === 'inst' ? n.sub ?? '' : `${n.kind} port`, act: () => { select({ kind: 'node', id: n.id }); centerOn(n.x + n.w / 2, n.y + n.h / 2); } });
    }
    if (n.kind === 'inst') for (const p of n.pins) if (p.name.toLowerCase().includes(ql)) {
      out.push({ label: `${n.label}.${p.name}`, sub: p.dir, act: () => { select({ kind: 'pin', id: p.id }); centerOn(p.x, p.y); } });
    }
  }
  return out.slice(0, 12);
}
let findIdx = 0;
function renderFind() {
  const c = findCandidates(findInput.value.trim());
  findResults.replaceChildren(...c.map((x, i) => h('li', { role: 'option', class: i === findIdx ? 'on' : '', 'aria-selected': i === findIdx, onmousedown: (e: Event) => { e.preventDefault(); x.act(); findInput.blur(); } }, h('span', { class: 'mono' }, x.label), h('span', { class: 'muted' }, x.sub))));
  findResults.hidden = !c.length;
  if (findInput.value && !c.length) { findResults.replaceChildren(h('li', { class: 'none' }, 'No block or port matches')); findResults.hidden = false; }
}
findInput.addEventListener('input', () => { findIdx = 0; renderFind(); });
findInput.addEventListener('keydown', e => {
  const c = findCandidates(findInput.value.trim());
  if (e.key === 'ArrowDown') { findIdx = Math.min(c.length - 1, findIdx + 1); renderFind(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { findIdx = Math.max(0, findIdx - 1); renderFind(); e.preventDefault(); }
  else if (e.key === 'Enter') { c[findIdx]?.act(); findInput.blur(); }
  else if (e.key === 'Escape') { findInput.value = ''; findInput.blur(); }
});
findInput.addEventListener('blur', () => setTimeout(() => { findResults.hidden = true; }, 100));

// keyboard
window.addEventListener('keydown', e => {
  const tgt = e.target as HTMLElement;
  if (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA') return;
  if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) { e.preventDefault(); goUp(); }
  else if (e.key === 'f' || e.key === 'F') fit(true);
  else if (e.key === '+' || e.key === '=') zoomBy(1.25);
  else if (e.key === '-' || e.key === '_') zoomBy(0.8);
  else if (e.key === '0') zoomLabel.click();
  else if (e.key === '/') { e.preventDefault(); findInput.focus(); }
  else if (e.key === 'Escape') select(null);
});

// ---------------------------------------------------------------- minimap
let miniScale = 1;
function renderMinimap() {
  if (!view) return;
  const g = view.graph;
  const W = 180, H = 120;
  miniScale = Math.min(W / g.w, H / g.h);
  miniSvg.setAttribute('viewBox', `0 0 ${g.w} ${g.h}`);
  miniSvg.replaceChildren();
  for (const n of g.nodes) {
    const m = view.markers.nodes[n.id];
    miniSvg.append(s('rect', { x: n.x, y: n.y, width: n.w, height: n.h, class: `mn k-${n.kind}${m ? ` lvl-${m.error ? 'error' : m.warning ? 'warning' : 'note'}` : ''}` }));
  }
  miniSvg.append(s('rect', { class: 'mv', x: 0, y: 0, width: 0, height: 0 }));
  minimap.style.width = `${Math.max(60, g.w * miniScale)}px`;
  minimap.style.height = `${Math.max(40, g.h * miniScale)}px`;
  drawMiniViewport();
}
function drawMiniViewport() {
  const r = miniSvg.querySelector('.mv');
  if (!r || !view) return;
  const b = stage.getBoundingClientRect();
  r.setAttribute('x', String(-T.x / T.k));
  r.setAttribute('y', String(-T.y / T.k));
  r.setAttribute('width', String(b.width / T.k));
  r.setAttribute('height', String(b.height / T.k));
  const g = view.graph;
  const fits = -T.x / T.k <= 0 && -T.y / T.k <= 0 && b.width / T.k - T.x / T.k >= g.w && b.height / T.k - T.y / T.k >= g.h;
  minimap.classList.toggle('idle', fits);
}
function miniMove(e: PointerEvent) {
  if (!view) return;
  const r = miniSvg.getBoundingClientRect();
  const gx = (e.clientX - r.left) / r.width * view.graph.w, gy = (e.clientY - r.top) / r.height * view.graph.h;
  const b = stage.getBoundingClientRect();
  T = { ...T, x: b.width / 2 - gx * T.k, y: b.height / 2 - gy * T.k };
  applyT();
}
minimap.addEventListener('pointerdown', e => { e.stopPropagation(); minimap.setPointerCapture(e.pointerId); miniMove(e); minimap.onpointermove = miniMove; });
minimap.addEventListener('pointerup', () => { minimap.onpointermove = null; });

// ---------------------------------------------------------------- drawer
function btn(label: string, onclick: () => void, ico?: string, cls = 'act') {
  return h('button', { class: cls, onclick }, ico ? icon(ico) : null, label);
}
function locLink(label: string, loc: any, title?: string) {
  if (!loc) return h('span', { class: 'muted' }, label);
  return h('button', { class: 'link mono', title: title ?? `${loc.file}:${loc.line + 1}`, onclick: () => vscode.postMessage({ type: 'open', loc }) }, label);
}
function fileLink(x: any, label?: string) {
  if (!x) return null;
  if (!x.exists) return h('span', { class: 'muted mono', title: `${x.file} (not found in this workspace)` }, label ?? x.rel);
  return h('button', { class: 'link mono', title: x.file, onclick: () => vscode.postMessage({ type: 'openFile', file: x.file, line: x.line, rel: x.rel }) }, label ?? `${x.rel}${x.line ? `:${x.line + 1}` : ''}`);
}

function renderDrawer() {
  const tabs = h('div', { class: 'tabs', role: 'tablist' },
    h('button', { role: 'tab', class: tab === 'findings' ? 'on' : '', 'aria-selected': tab === 'findings', onclick: () => { tab = 'findings'; renderDrawer(); } },
      'Findings', view?.findings.length ? h('span', { class: 'count' }, String(view.findings.length)) : null),
    h('button', { role: 'tab', class: tab === 'notes' ? 'on' : '', 'aria-selected': tab === 'notes', onclick: () => { tab = 'notes'; renderDrawer(); } },
      'Notes', view?.notes.here.length ? h('span', { class: 'count' }, String(view.notes.here.length)) : null),
    h('button', { role: 'tab', class: tab === 'details' ? 'on' : '', 'aria-selected': tab === 'details', onclick: () => { tab = 'details'; renderDrawer(); } }, 'Details'),
  );
  const content = h('div', { class: 'drawer-body', role: 'tabpanel' });
  const hadFocus = document.activeElement?.classList.contains('note-input');
  if (tab === 'findings') content.append(findingsList());
  else if (tab === 'notes') content.append(notesPanel());
  else if (activeFinding !== null) content.append(detail && detail.index === activeFinding ? findingCard(detail) : h('p', { class: 'muted pad' }, 'Loading finding…'));
  else content.append(selectionCard());
  drawer.replaceChildren(runHeader(), tabs, content);
  if (hadFocus) {
    const ta = drawer.querySelector<HTMLTextAreaElement>('.note-input');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
}

function runHeader() {
  const r = view?.run;
  if (!r) return h('div', { class: 'run-head none' }, h('div', { class: 'run-title' }, 'No verification run shown'), h('div', { class: 'muted' }, 'Pick a run in the Verification runs view to mark its findings here.'));
  const t = view!.findings;
  const n = (l: Level) => t.filter(f => f.level === l).length;
  return h('div', { class: `run-head st-${r.broken ? 'broken' : r.status}` },
    h('div', { class: 'run-title' }, h('span', { class: 'run-state' }, r.broken ? 'Broken run' : r.status === 'pass' ? 'Passed' : 'Failed'), h('span', { class: 'mono' }, r.id)),
    h('div', { class: 'muted' }, `${r.testbench} · DUT ${r.dutTop}`),
    freshnessNote(r),
    view!.markers.byModule ? h('div', { class: 'warn small' }, `${r.dutTop} is not instantiated exactly once under ${view!.top}, so findings are shown on every instance of the flagged module.`) : null,
    h('div', { class: 'run-counts' },
      h('span', { class: 'cnt lvl-error' }, `${n('error')} error${n('error') === 1 ? '' : 's'}`),
      h('span', { class: 'cnt lvl-warning' }, `${n('warning')} warning${n('warning') === 1 ? '' : 's'}`),
      h('span', { class: 'cnt lvl-note' }, `${n('note')} note${n('note') === 1 ? '' : 's'}`)),
  );
}

/** Does the RTL still match what this run was taken from? */
function freshnessNote(r: NonNullable<ViewMsg['run']>) {
  const f = r.freshness;
  if (!f) return h('div', { class: 'muted small fresh' }, 'Checking whether the RTL matches this run…');
  if (f.state === 'same') return h('div', { class: 'muted small fresh ok' }, f.reason);
  if (f.state === 'unknown') return h('div', { class: 'muted small fresh' }, f.reason);
  return h('div', { class: 'fresh-warn' },
    h('div', {}, h('strong', {}, 'RTL changed since this run. '), f.reason, ' Findings in these files may point at code the test never ran:'),
    h('ul', { class: 'plain' }, ...f.changed.slice(0, 6).map(c =>
      h('li', {}, h('button', { class: 'link mono', onclick: () => vscode.postMessage({ type: 'openFile', file: c.file, line: 0 }) }, c.rel)))),
    f.changed.length > 6 ? h('div', { class: 'muted small' }, `and ${f.changed.length - 6} more`) : null);
}

function findingsList() {
  if (!view?.run) return h('p', { class: 'muted pad' }, 'Without a run, the diagram is a plain design browser. Findings appear here when a run is active.');
  if (!view.findings.length) return h('div', { class: 'pad clean' }, h('div', { class: 'clean-title' }, 'No findings in this run'), h('p', { class: 'muted' }, 'Every rule in the verification plan was checked and is clean.'));
  const order = (f: FindingRow) => (f.here ? 0 : f.resolved ? 1 : 2) * 10 + ({ error: 0, warning: 1, note: 2, none: 3 }[f.level]);
  const rows = [...view.findings].sort((a, b) => order(a) - order(b) || a.index - b.index);
  const ul = h('ul', { class: 'flist' });
  let lastGroup = '';
  for (const f of rows) {
    const group = f.here ? 'In this block' : f.resolved ? 'Elsewhere in the design' : 'Not found in the RTL';
    if (group !== lastGroup) { ul.append(h('li', { class: 'fgroup' }, group)); lastGroup = group; }
    ul.append(h('li', {},
      h('button', { class: `frow lvl-${f.level}${activeFinding === f.index ? ' on' : ''}`, onclick: () => openFinding(f.index) },
        h('span', { class: `dot lvl-${f.level}`, 'aria-label': f.level }),
        h('span', { class: 'frow-main' },
          h('span', { class: 'frow-top' }, h('span', { class: 'rule mono' }, f.ruleId), h('span', { class: 'sig mono' }, f.signal || '–'), f.resolved && !f.here ? h('span', { class: 'muted' }, `in ${f.module}`) : null),
          h('span', { class: 'frow-msg' }, f.message)))));
  }
  return ul;
}

function selectionCard() {
  if (!view) return h('div');
  if (!selection) {
    const g = view.graph;
    return h('div', { class: 'pad' },
      h('h2', { class: 'card-title mono' }, g.module),
      h('p', { class: 'muted' }, `${g.stats.instances} instances, ${g.stats.ports} ports, ${g.stats.nets} nets.`),
      h('p', { class: 'muted' }, 'Select a block, port or wire to see its details. Double-click a block to open it; double-click empty space to go up a level.'),
      h('div', { class: 'legend' },
        legendRow('wire t1', '1 bit'), legendRow('wire t2', '2–8 bits'), legendRow('wire t3', 'more than 8 bits'),
        legendRow('nc', 'port left open'), legendRow('gen', 'inside a generate block')));
  }
  if (selection.kind === 'node') {
    const n = nodeById.get(selection.id)!;
    if (n.kind !== 'inst' && n.kind !== 'logic') return pinCard(n.pins[0].id);
    const conns = n.pins.filter(p => !p.open).length;
    return h('div', { class: 'pad' },
      h('h2', { class: 'card-title' }, n.label, n.sub ? h('span', { class: 'mono muted' }, ` ${n.sub}`) : null),
      n.missing ? h('p', { class: 'warn' }, `Module ${n.sub} is not in the parsed sources, so its ports come only from this instantiation.`) : null,
      n.generate ? kv('generate', h('span', { class: 'mono' }, n.generate)) : null,
      n.params?.length ? kv('parameters', h('span', { class: 'mono' }, n.params.map(p => `${p.name} = ${p.expr}`).join('\n'))) : null,
      kv('pins', `${n.pins.length} (${conns} connected, ${n.pins.length - conns} open)`),
      h('div', { class: 'actions' },
        n.drillable ? btn('Open block', () => drill(n), 'up', 'act primary') : null,
        n.loc ? btn(n.kind === 'logic' ? 'Go to code' : 'Go to instance', () => vscode.postMessage({ type: 'open', loc: n.loc }), 'open') : null,
        n.defLoc ? btn('Go to definition', () => vscode.postMessage({ type: 'open', loc: n.defLoc }), 'file') : null));
  }
  if (selection.kind === 'pin') return pinCard(selection.id);
  const net = selection.id;
  const ids = view.graph.nets[net] ?? [];
  const ends = new Set<string>();
  for (const id of ids) { const e = view.graph.edges.find(x => x.id === id)!; ends.add(e.from); ends.add(e.to); }
  for (const pid of view.graph.labels?.[net] ?? []) ends.add(pid);
  return h('div', { class: 'pad' },
    h('h2', { class: 'card-title mono' }, net),
    h('p', { class: 'muted' }, view.graph.labels?.[net] ? 'Net in this module, drawn as labels (see the rtlDiagram.netLabels settings). Connects:' : 'Net in this module, connecting:'),
    h('ul', { class: 'plain' }, ...[...ends].map(pid => {
      const pp = pinById.get(pid)!;
      const label = pp.node.kind === 'inst' ? `${pp.node.label}.${pp.pin.name}` : pp.node.kind === 'logic' ? `logic (${pp.pin.dir === 'output' ? 'drives' : 'reads'})` : `port ${pp.pin.name}`;
      return h('li', {}, h('button', { class: 'link mono', onclick: () => select({ kind: 'pin', id: pid }) }, label), h('span', { class: 'muted' }, ` ${pp.pin.dir}`));
    })));
}
function legendRow(kind: string, label: string) {
  const sw = s('svg', { width: 36, height: 14, class: 'lg' });
  if (kind.startsWith('wire')) sw.append(s('line', { x1: 2, y1: 7, x2: 34, y2: 7, class: `lg-${kind.replace(' ', '-')}` }));
  else if (kind === 'nc') sw.append(s('line', { x1: 2, y1: 7, x2: 18, y2: 7, class: 'lg-wire-t1' }), s('path', { d: 'M20 4l6 6M26 4l-6 6', class: 'lg-nc' }));
  else sw.append(s('rect', { x: 8, y: 2, width: 22, height: 10, class: 'lg-gen' }), s('rect', { x: 4, y: 4, width: 22, height: 10, class: 'lg-body' }));
  return h('div', { class: 'lg-row' }, sw, h('span', {}, label));
}
function pinCard(id: string) {
  const pp = pinById.get(id)!;
  const { pin, node } = pp;
  const isTerm = node.kind !== 'inst' && node.kind !== 'logic';
  const marks = view?.markers.pins[id] ?? [];
  return h('div', { class: 'pad' },
    h('h2', { class: 'card-title mono' }, isTerm ? pin.name : `${node.label}.${pin.name}`),
    kv('direction', pin.dir), pin.range ? kv('range', h('span', { class: 'mono' }, pin.range)) : null,
    pin.width ? kv('width', `${pin.width} bit${pin.width > 1 ? 's' : ''}`) : null,
    !isTerm && node.kind === 'inst' ? kv('connected to', h('span', { class: 'mono' }, pin.open ? 'open' : pin.expr ?? '')) : null,
    marks.length ? h('div', { class: 'pin-marks' }, ...marks.map(m => {
      const f = view!.findings.find(x => x.index === m.f);
      return h('button', { class: `frow lvl-${m.level}`, onclick: () => openFinding(m.f) }, h('span', { class: `dot lvl-${m.level}` }), h('span', { class: 'frow-main' }, h('span', { class: 'frow-top' }, h('span', { class: 'rule mono' }, f?.ruleId ?? ''), h('span', { class: 'muted' }, m.role === 'driver' ? 'direct driver of the observed signal' : m.role === 'primary' ? 'observed here' : 'context signal')), h('span', { class: 'frow-msg' }, f?.message ?? '')));
    })) : null,
    h('div', { class: 'actions' },
      pin.loc ? btn('Go to declaration', () => vscode.postMessage({ type: 'open', loc: pin.loc }), 'open', 'act primary') : null));
}

function findingCard(f: any) {
  const p = f.primary;
  const props = f.props ?? {};
  const sr = f.rule?.specRef;
  const card = h('div', { class: `fcard lvl-${f.level}` });
  card.append(...nodes(
    h('div', { class: 'fc-head' },
      h('span', { class: `chip lvl-${f.level}` }, f.level),
      h('span', { class: 'mono fc-rule' }, f.ruleId),
      f.rule?.channel ? h('span', { class: 'chip ghost' }, f.rule.channel) : null),
    f.rule?.short ? h('div', { class: 'fc-short' }, f.rule.short) : null,
    h('p', { class: 'fc-msg' }, f.message),
    f.moduleChanged ? h('p', { class: 'fresh-warn small' }, 'This module\'s file changed since the run. The declaration and drivers below are from the current code, which may not be what the test ran.') : null,
  ));

  // Observed at: where the testbench saw the problem. Deliberately not phrased as a cause.
  const where = h('section', { class: 'fc-sec' }, h('h3', {}, 'Observed at'));
  if (p && p.status === 'ok') {
    where.append(
      h('p', { class: 'muted small' }, 'Where the testbench saw the problem. The cause may be elsewhere, upstream of this signal.'),
      h('div', { class: 'fc-sig' },
        locLink(p.signal, p.decl, 'Go to the port declaration'),
        h('span', { class: 'muted' }, ` ${p.isNet ? 'net' : p.dir ?? ''} ${p.range ?? ''} in `),
        h('span', { class: 'mono' }, p.module)),
      h('div', { class: 'actions' },
        p.decl ? btn('Go to declaration', () => vscode.postMessage({ type: 'open', loc: p.decl }), 'open', 'act primary') : null,
        btn('Show on diagram', () => vscode.postMessage({ type: 'showFinding', index: f.index }), 'fit')),
    );
    if (p.drivers?.length) {
      where.append(h('h4', {}, `Direct drivers (${p.drivers.length})`),
        h('p', { class: 'muted small' }, 'Statements in this module that assign the signal. Candidates to inspect, not a diagnosis.'),
        h('ul', { class: 'drivers' }, ...p.drivers.map((d: any) =>
        h('li', {}, h('span', { class: 'chip ghost' }, d.kind === 'instance' ? 'instance' : d.kind), locLink(d.text, d.loc)))));
    } else {
      where.append(h('p', { class: 'muted' }, p.dir === 'input' ? 'Input port: driven from outside this module. Look at what drives it in the parent.' : 'No statement in this module assigns it.'));
    }
  } else {
    where.append(h('p', { class: 'warn' }, `Port ${p?.signal ?? '(none)'}: ${p?.reason ?? 'the finding names no primary signal'}.`),
      h('p', { class: 'muted' }, `The run names DUT ${f.dutTop} at ${f.dutInstance}. Check that the RTL sources include it and that the port name matches the design document.`));
  }
  if (f.context?.length) {
    where.append(h('h4', {}, 'Context signals'), h('div', { class: 'ctx' }, ...f.context.map((c: any) =>
      c.status === 'ok' ? locLink(c.signal, c.decl) : h('span', { class: 'muted mono', title: c.reason }, `${c.signal}?`))));
  }
  card.append(where);

  // Observed
  if (props.signals && Object.keys(props.signals).length) {
    card.append(h('section', { class: 'fc-sec' }, h('h3', {}, 'Signal values at first occurrence'),
      h('table', { class: 'sigs' }, ...Object.entries(props.signals).map(([k, v]) =>
        h('tr', { class: k === p?.signal ? 'prim' : '' }, h('td', { class: 'mono' }, k), h('td', { class: 'mono val' }, String(v)))))));
  }

  // Test
  card.append(h('section', { class: 'fc-sec' }, h('h3', {}, 'Test'),
    h('div', { class: 'grid2' },
      kv('test', h('span', { class: 'mono' }, props.test ?? '–')), kv('seed', String(props.seed ?? '–')),
      kv('cycle', String(props.cycle ?? '–')), kv('sim time', props.sim_time_ns !== undefined ? `${props.sim_time_ns} ns` : '–'),
      kv('occurrences', String(props.occurrences ?? '–')), kv('channel', props.channel ?? '–'))));

  if (props.reproduce) {
    card.append(h('section', { class: 'fc-sec' }, h('h3', {}, 'Reproduce'),
      h('pre', { class: 'code' }, props.reproduce),
      h('p', { class: 'muted small' }, 'Run from the testbench directory.'),
      h('div', { class: 'actions' },
        btn('Copy', () => vscode.postMessage({ type: 'copy', text: props.reproduce }), 'copy'),
        btn('Type in terminal', () => vscode.postMessage({ type: 'runInTerminal', text: props.reproduce, cwd: f.tbDir }), 'term'))));
  }
  if (f.waveform) {
    card.append(h('section', { class: 'fc-sec' }, h('h3', {}, 'Waveform'),
      fileLink({ ...f.waveform, exists: false }, f.waveform.rel),
      h('p', { class: 'muted small' }, `${f.waveform.start_ns ?? '?'} ns to ${f.waveform.end_ns ?? '?'} ns`),
      f.waveform.exists ? h('div', { class: 'actions' }, btn('Reveal file', () => vscode.postMessage({ type: 'reveal', file: f.waveform.file }), 'open')) : null));
  }

  // Requirement
  if (f.rule) {
    card.append(h('section', { class: 'fc-sec' }, h('h3', {}, 'Requirement'),
      h('p', {}, f.rule.full || f.rule.short),
      sr ? h('p', { class: 'muted' }, `${sr.doc} §${sr.section}${sr.page ? `, page ${sr.page}` : ''}`) : h('p', { class: 'muted' }, 'Design-specific requirement (from the design document).'),
      f.designDoc ? h('div', {}, fileLink(f.designDoc, `Design document: ${f.designDoc.rel}`)) : null));
  }
  if (f.related?.length || f.physical) {
    card.append(h('section', { class: 'fc-sec' }, h('h3', {}, 'Detected by'),
      h('ul', { class: 'plain' }, ...f.related.map((r: any) => h('li', {}, fileLink(r), r.message ? h('span', { class: 'muted' }, ` ${r.message}`) : null))),
      f.physical ? h('div', {}, h('span', { class: 'muted' }, 'Defined in '), fileLink(f.physical)) : null));
  }
  card.append(h('section', { class: 'fc-sec' }, h('h3', {}, 'Triage'),
    h('div', { class: 'grid2' },
      kv('classification', props.classification ?? '–'), kv('status', props.triage_status ?? '–'),
      kv('bug', props.bug_id ?? '–'), kv('fingerprint', h('span', { class: 'mono' }, f.fingerprint || '–')))));
  return card;
}

// ---------------------------------------------------------------- notes

const KIND_LABEL: Record<NoteKind, string> = { note: 'Note', question: 'Question', issue: 'Issue' };

/** Speech-bubble glyph with an optional count. */
function bubble(x: number, y: number, m: NoteMark, key: string) {
  const g = s('g', { class: `nb kind-${m.kind}${m.resolved ? ' resolved' : ''}`, 'data-notes': key, role: 'button', tabindex: 0,
    'aria-label': `${m.ids.length} ${m.ids.length === 1 ? 'note' : 'notes'}` });
  const w = m.ids.length > 1 ? 22 : 16;
  g.append(s('path', { d: `M${x} ${y}h${w}a3 3 0 0 1 3 3v7a3 3 0 0 1 -3 3h-${w - 7}l-4 4v-4h-${3}a3 3 0 0 1 -3 -3v-7a3 3 0 0 1 3 -3z`, class: 'nb-shape' }));
  if (m.ids.length > 1) g.append(text(x + w / 2 + 1, y + 9.5, String(m.ids.length), 'nb-t', 'middle'));
  else g.append(s('path', { d: `M${x + 4} ${y + 5}h9M${x + 4} ${y + 8.5}h6`, class: 'nb-lines' }));
  const open = (ev: Event) => { ev.stopPropagation(); openNotes(m.ids, false); };
  g.addEventListener('click', open);
  g.addEventListener('keydown', ev => { if ((ev as KeyboardEvent).key === 'Enter') open(ev); });
  g.addEventListener('pointermove', ev => {
    const notes = m.ids.map(id => view?.notes.all.find(n => n.id === id)).filter(Boolean) as NoteView[];
    showTip(ev, h('div', {}, ...notes.slice(0, 3).map(n => h('div', { class: 'tip-note' },
      h('span', { class: `chip kind-${n.kind}` }, KIND_LABEL[n.kind]), ' ', n.text.length > 120 ? n.text.slice(0, 119) + '…' : n.text)),
      notes.length > 3 ? h('div', { class: 'tip-hint' }, `+${notes.length - 3} more`) : null,
      h('div', { class: 'tip-hint' }, 'Click to open in the Notes panel')));
  });
  g.addEventListener('pointerleave', hideTip);
  gNotes.append(g);
}

function drawNotes(msg: ViewMsg) {
  moduleNotesChip.hidden = true;
  for (const [key, m] of Object.entries(msg.notes.marks)) {
    if (key === 'module') {
      moduleNotesChip.hidden = false;
      moduleNotesChip.className = `module-notes kind-${m.kind}${m.resolved ? ' resolved' : ''}`;
      moduleNotesChip.textContent = `${m.ids.length} ${m.ids.length === 1 ? 'note' : 'notes'} on ${msg.graph.module}`;
      moduleNotesChip.onclick = () => openNotes(m.ids, false);
      continue;
    }
    if (key.startsWith('net:')) {
      const net = key.slice(4);
      const e = msg.graph.edges.find(x => x.net === net);
      if (e && e.points.length >= 2) {
        let best = 0, len = -1;
        for (let i = 0; i + 1 < e.points.length; i++) {
          const l = Math.hypot(e.points[i + 1][0] - e.points[i][0], e.points[i + 1][1] - e.points[i][1]);
          if (l > len) { len = l; best = i; }
        }
        const [a, b] = [e.points[best], e.points[best + 1]];
        bubble((a[0] + b[0]) / 2 - 8, (a[1] + b[1]) / 2 - 20, m, key);
      } else {
        const pid = msg.graph.labels?.[net]?.[0];
        const pp = pid ? pinById.get(pid) : undefined;
        if (pp) bubble(pp.pin.x + (pp.pin.side === 'E' ? 10 : -26), pp.pin.y - 22, m, key);
      }
      continue;
    }
    const pp = pinById.get(key);
    if (pp && pp.node.kind === 'inst') {
      const out = pp.pin.side === 'E' ? 1 : -1;
      bubble(pp.pin.x + (out > 0 ? 12 : -28), pp.pin.y - 21, m, key);
      continue;
    }
    const nodeId = key.endsWith('/p') ? key.slice(0, -2) : key;
    const n = nodeById.get(nodeId);
    // Blocks: top-left corner. Port terminals: beside the arrow on the outer side, clear of finding tags above.
    if (n) {
      if (n.kind === 'inst') bubble(n.x + 6, n.y - 19, m, key);
      else if (n.kind === 'in') bubble(n.x - 24, n.y + n.h / 2 - 9, m, key);
      else bubble(n.x + n.w + 5, n.y + n.h / 2 - 9, m, key);
    }
  }
}

function openNotes(ids: string[], center: boolean) {
  focusNotes = ids;
  tab = 'notes';
  if (!drawerOpen) { drawerOpen = true; body.classList.remove('drawer-closed'); persist(); }
  renderDrawer();
  drawer.querySelector('.note.focus')?.scrollIntoView({ block: 'nearest' });
  if (center && view) {
    const key = Object.entries(view.notes.marks).find(([, m]) => ids.some(id => m.ids.includes(id)))?.[0];
    const el = key ? gNotes.querySelector(`[data-notes="${CSS.escape(key)}"]`) as SVGGraphicsElement | null : null;
    if (el) { const b = el.getBBox(); centerOn(b.x + b.width / 2, b.y + b.height / 2); }
  }
}

/** What a right-click points at, as a note anchor. Instances below the view can be pinned with "only this instance". */
function anchorAt(target: Element): { anchor: NoteAnchor; label: string; scope: { top: string; instPath: string[] } | null } | null {
  if (!view) return null;
  const mod = view.graph.module;
  const cur = view.path;
  const here = cur.length ? { top: view.top, instPath: cur } : null;
  const pinEl = target.closest('[data-pin]');
  const netEl = target.closest('.edge, .netlabel, .junction');
  const nodeEl = target.closest('.node');
  if (pinEl) {
    const pp = pinById.get(pinEl.getAttribute('data-pin')!);
    if (!pp) return null;
    const { pin, node } = pp;
    if (node.kind === 'inst') {
      if (node.missing || !node.sub) return null;
      return { anchor: { module: node.sub, target: { type: 'port', name: pin.name } }, label: `${node.sub}.${pin.name} (${node.label})`, scope: { top: view.top, instPath: [...cur, node.key!] } };
    }
    if (node.kind === 'logic') return { anchor: { module: mod, target: { type: 'net', name: pin.name } }, label: `net ${pin.name} in ${mod}`, scope: here };
    return { anchor: { module: mod, target: { type: 'port', name: pin.name } }, label: `${mod}.${pin.name}`, scope: here };
  }
  if (netEl) {
    const net = netEl.getAttribute('data-net')!;
    return { anchor: { module: mod, target: { type: 'net', name: net } }, label: `net ${net} in ${mod}`, scope: here };
  }
  if (nodeEl) {
    const n = nodeById.get(nodeEl.getAttribute('data-id')!);
    if (n?.kind === 'inst') {
      if (n.missing || !n.sub) return null;
      return { anchor: { module: n.sub, target: { type: 'module' } }, label: `${n.sub} (${n.label})`, scope: { top: view.top, instPath: [...cur, n.key!] } };
    }
  }
  return { anchor: { module: mod, target: { type: 'module' } }, label: mod, scope: here };
}

function startNote(a: NonNullable<ReturnType<typeof anchorAt>>) {
  draft = { ...a, kind: 'note', text: '', onlyHere: false };
  editing = null;
  focusNotes = [];
  tab = 'notes';
  if (!drawerOpen) { drawerOpen = true; body.classList.remove('drawer-closed'); persist(); }
  renderDrawer();
  drawer.querySelector<HTMLTextAreaElement>('.note-input')?.focus();
}

stage.addEventListener('contextmenu', e => {
  if (!view || (e.target as Element).closest('.minimap')) return;
  e.preventDefault();
  hideTip();
  const a = anchorAt(e.target as Element);
  const items: HTMLElement[] = [];
  if (a) items.push(h('button', { role: 'menuitem', onclick: () => { hideMenu(); startNote(a); } }, `Add note on ${a.label}…`));
  else items.push(h('div', { class: 'ctx-none' }, 'Notes need the module to be in the parsed sources'));
  ctxMenu.replaceChildren(...items);
  ctxMenu.hidden = false;
  const b = stage.getBoundingClientRect();
  const x = Math.min(e.clientX - b.left, b.width - ctxMenu.offsetWidth - 8);
  const y = Math.min(e.clientY - b.top, b.height - ctxMenu.offsetHeight - 8);
  ctxMenu.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
  (ctxMenu.querySelector('button') as HTMLButtonElement | null)?.focus();
});
function hideMenu() { ctxMenu.hidden = true; }
window.addEventListener('pointerdown', e => { if (!ctxMenu.hidden && !(e.target as Element).closest('.ctxmenu')) hideMenu(); });
window.addEventListener('keydown', e => { if (e.key === 'Escape' && !ctxMenu.hidden) hideMenu(); });

function kindPicker(value: NoteKind, onChange: (k: NoteKind) => void) {
  return h('div', { class: 'kinds', role: 'radiogroup', 'aria-label': 'Kind' },
    ...(['note', 'question', 'issue'] as NoteKind[]).map(k => h('button', {
      role: 'radio', 'aria-checked': k === value, class: `kind-btn kind-${k}${k === value ? ' on' : ''}`,
      onclick: () => onChange(k),
    }, KIND_LABEL[k])));
}

function noteForm() {
  const d = draft!;
  const save = () => {
    if (!d.text.trim()) return;
    const anchor: NoteAnchor = { ...d.anchor, ...(d.onlyHere && d.scope ? { scope: d.scope } : {}) };
    vscode.postMessage({ type: 'addNote', anchor, kind: d.kind, text: d.text });
    draft = null;
    renderDrawer();
  };
  const ta = h('textarea', { class: 'note-input', rows: 4, placeholder: d.kind === 'question' ? 'What would you like to ask?' : d.kind === 'issue' ? 'What looks wrong, and where did you see it?' : 'Write a note', 'aria-label': 'Note text' }) as HTMLTextAreaElement;
  ta.value = d.text;
  ta.addEventListener('input', () => { d.text = ta.value; (form.querySelector('.act.primary') as HTMLButtonElement).disabled = !ta.value.trim(); });
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(); if (e.key === 'Escape') { draft = null; renderDrawer(); } });
  const form = h('div', { class: 'note-form' },
    h('div', { class: 'nf-title' }, 'New note on ', h('span', { class: 'mono' }, d.label)),
    kindPicker(d.kind, k => { d.kind = k; renderDrawer(); }),
    ta,
    d.scope ? h('label', { class: 'nf-scope' },
      h('input', { type: 'checkbox', checked: d.onlyHere, onchange: (e: Event) => { d.onlyHere = (e.target as HTMLInputElement).checked; } }),
      h('span', {}, 'Only this instance ', h('span', { class: 'mono muted' }, [d.scope.top, ...d.scope.instPath].join('.')))) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'act primary', disabled: !d.text.trim(), onclick: save }, 'Add note'),
      h('button', { class: 'act', onclick: () => { draft = null; renderDrawer(); } }, 'Cancel'),
      h('span', { class: 'muted small' }, '⌘/Ctrl+Enter')));
  return form;
}

function noteCard(n: NoteView) {
  const isEditing = editing?.id === n.id;
  const when = new Date(n.updated ?? n.created);
  const card = h('article', { class: `note kind-${n.kind}${n.resolved ? ' resolved' : ''}${focusNotes.includes(n.id) ? ' focus' : ''}`, 'data-note': n.id });
  card.append(h('div', { class: 'note-head' },
    h('span', { class: `chip kind-${n.kind}` }, KIND_LABEL[n.kind]),
    h('button', { class: 'link mono note-where', title: 'Show on the diagram', onclick: () => vscode.postMessage({ type: 'gotoNote', id: n.id }) }, n.label),
    n.resolved ? h('span', { class: 'muted small' }, 'resolved') : null));
  if (n.detached) card.append(h('p', { class: 'warn small' }, `Detached: ${n.detached}.`));
  if (isEditing) {
    const ta = h('textarea', { class: 'note-input', rows: 4, 'aria-label': 'Edit note' }) as HTMLTextAreaElement;
    ta.value = editing!.text;
    ta.addEventListener('input', () => { editing!.text = ta.value; });
    const commit = () => { vscode.postMessage({ type: 'updateNote', id: n.id, text: editing!.text, kind: editing!.kind }); editing = null; renderDrawer(); };
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit(); if (e.key === 'Escape') { editing = null; renderDrawer(); } });
    card.append(kindPicker(editing!.kind, k => { editing!.kind = k; renderDrawer(); }), ta,
      h('div', { class: 'actions' }, h('button', { class: 'act primary', onclick: commit }, 'Save'), h('button', { class: 'act', onclick: () => { editing = null; renderDrawer(); } }, 'Cancel')));
  } else {
    card.append(h('p', { class: 'note-text' }, n.text));
  }
  card.append(h('div', { class: 'note-meta' },
    h('span', { class: 'muted small' }, `${n.author} · ${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}${n.updated ? ' (edited)' : ''}`),
    isEditing ? null : h('span', { class: 'note-actions' },
      h('button', { class: 'link small', onclick: () => { editing = { id: n.id, text: n.text, kind: n.kind }; draft = null; renderDrawer(); } }, 'Edit'),
      h('button', { class: 'link small', onclick: () => vscode.postMessage({ type: 'updateNote', id: n.id, resolved: !n.resolved }) }, n.resolved ? 'Reopen' : 'Resolve'),
      h('button', { class: 'link small danger', onclick: () => vscode.postMessage({ type: 'deleteNote', id: n.id }) }, 'Delete'))));
  return card;
}

function notesPanel() {
  const wrap = h('div', { class: 'notes-panel' });
  if (draft) wrap.append(noteForm());
  const all = view?.notes.all ?? [];
  const here = new Set(view?.notes.here ?? []);
  const order = (a: NoteView, b: NoteView) => Number(a.resolved) - Number(b.resolved) || b.created.localeCompare(a.created);
  const groups: [string, NoteView[]][] = [
    ['In this view', all.filter(n => here.has(n.id) || focusNotes.includes(n.id)).sort(order)],
    ['Elsewhere in the design', all.filter(n => !here.has(n.id) && !focusNotes.includes(n.id) && !n.detached).sort(order)],
    ['Detached', all.filter(n => !here.has(n.id) && !focusNotes.includes(n.id) && n.detached).sort(order)],
  ];
  if (!all.length && !draft) {
    wrap.append(h('div', { class: 'pad' },
      h('p', {}, 'No notes yet.'),
      h('p', { class: 'muted' }, 'Right-click a port, wire, block or empty space and choose Add note. Notes are saved as files in the .rtl-notes folder; commit them to share with the team.')));
  }
  for (const [title, list] of groups) {
    if (!list.length) continue;
    wrap.append(h('div', { class: 'fgroup' }, title), ...list.map(noteCard));
  }
  for (const i of view?.notes.issues ?? []) wrap.append(h('p', { class: 'warn small pad' }, i));
  return wrap;
}

// ---------------------------------------------------------------- messages
window.addEventListener('message', ev => {
  const m = ev.data;
  switch (m.type) {
    case 'view':
      render(m);
      break;
    case 'live':
      live = m.live;
      renderLive();
      break;
    case 'detail':
      detail = m.finding;
      activeFinding = m.finding.index;
      tab = 'details';
      renderDrawer();
      break;
    case 'theme': {
      themeMode = m.mode;
      document.body.dataset.theme = m.mode;
      const label = { auto: 'Auto', light: 'Light', dark: 'Dark' }[themeMode];
      themeBtn.querySelector('.tb-btn-label')!.textContent = label;
      themeBtn.title = themeMode === 'auto' ? 'Theme: follow VS Code (click for light)' : `Theme: ${label.toLowerCase()} (click to change)`;
      const st = document.documentElement.style;
      const c = m.colors ?? {};
      for (const k of ['block', 'wire', 'error', 'warning', 'note']) {
        if (c[k]) st.setProperty(`--user-${k}`, c[k]); else st.removeProperty(`--user-${k}`);
      }
      portGroupColors = c.portGroups ?? {};
      if (view) render({ ...view, select: undefined });
      break;
    }
    case 'empty':
      view = null;
      gEdges.replaceChildren(); gNodes.replaceChildren(); gMarks.replaceChildren();
      overlay.hidden = false;
      overlay.replaceChildren(h('div', { class: 'empty' },
        h('h2', {}, m.scanning ? 'Reading the RTL…' : m.error ? 'Could not parse the RTL' : 'No SystemVerilog modules found'),
        h('p', { class: 'muted' }, m.scanning ? 'Parsing source files with Verible.' : m.error ?? 'Add a Bender.yml, set rtlDiagram.filelists, or adjust rtlDiagram.include, then rescan.'),
        m.sourceMode ? h('p', { class: 'muted mono' }, m.sourceMode) : null));
      renderDrawer();
      break;
  }
});

renderDrawer();
vscode.postMessage({ type: 'ready' });
