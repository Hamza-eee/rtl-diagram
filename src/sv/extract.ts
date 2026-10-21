// Walks a Verible CST and extracts modules, ports, parameters, instances and drivers.
// Purely syntactic and deterministic: what is not written in the source is not invented.

import { CstNode, ParsedFile } from './verible';
import { Connection, Direction, Driver, DriverKind, Instance, Module, Param, Port, SrcLoc } from '../model';

type N = CstNode | null | undefined;
/** One enclosing generate construct: its block label ('' if unlabelled) and a one-line description. */
interface Gen { label: string; desc: string }

const DIRS = new Set(['input', 'output', 'inout', 'ref']);
// Tags whose contents are index/select expressions, not signal references in their own right.
const INDEX_TAGS = new Set(['kDimensionScalar', 'kDimensionRange', 'kDimensionSlice', 'kSelectVariableDimension',
  'kDeclarationDimensions', 'kPackedDimensions', 'kUnpackedDimensions', 'kHierarchyExtension']);

class Src {
  private lineStarts: number[] = [0];
  constructor(readonly file: string, readonly buf: Buffer) {
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) this.lineStarts.push(i + 1);
  }
  pos(off: number): { line: number; col: number } {
    let lo = 0, hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= off) lo = mid; else hi = mid - 1;
    }
    // Column in UTF-16 units, as VS Code expects.
    const col = this.buf.subarray(this.lineStarts[lo], off).toString('utf8').length;
    return { line: lo, col };
  }
  text(a: number, b: number) { return this.buf.subarray(a, b).toString('utf8'); }
}

function kids(n: N): CstNode[] {
  return (n?.children ?? []).filter((c): c is CstNode => !!c);
}

function span(n: N): [number, number] | null {
  if (!n) return null;
  if (n.start !== undefined && n.end !== undefined) return [n.start, n.end];
  let a = Infinity, b = -Infinity;
  for (const c of kids(n)) {
    const s = span(c);
    if (s) { a = Math.min(a, s[0]); b = Math.max(b, s[1]); }
  }
  return a === Infinity ? null : [a, b];
}

function find(n: N, tag: string): CstNode | undefined {
  for (const c of kids(n)) if (c.tag === tag) return c;
  return undefined;
}

function findDeep(n: N, tag: string, stop?: Set<string>): CstNode | undefined {
  for (const c of kids(n)) {
    if (c.tag === tag) return c;
    if (stop?.has(c.tag)) continue;
    const r = findDeep(c, tag, stop);
    if (r) return r;
  }
  return undefined;
}

function findAll(n: N, tag: string, out: CstNode[] = [], stop?: Set<string>): CstNode[] {
  for (const c of kids(n)) {
    if (c.tag === tag) out.push(c);
    if (stop?.has(c.tag)) continue;
    findAll(c, tag, out, stop);
  }
  return out;
}

function isToken(n: CstNode) { return n.children === undefined; }

class Extractor {
  constructor(private src: Src) {}

  text(n: N): string {
    const s = span(n);
    return s ? this.src.text(s[0], s[1]) : '';
  }
  oneLine(n: N, max = 140): string {
    const t = this.text(n).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  }
  loc(n: N): SrcLoc {
    const s = span(n) ?? [0, 0];
    const a = this.src.pos(s[0]), b = this.src.pos(s[1]);
    return { file: this.src.file, line: a.line, col: a.col, endLine: b.line, endCol: b.col };
  }

  /** Identifiers referenced by an expression, skipping index expressions and callee names. */
  signals(n: N, out: string[] = []): string[] {
    for (const c of kids(n)) {
      if (INDEX_TAGS.has(c.tag)) continue;
      if (c.tag === 'kFunctionCall' && find(c, 'kParenGroup')) {
        // real call f(args): skip the callee, keep the args
        this.signals(find(c, 'kParenGroup'), out);
        continue;
      }
      if (c.tag === 'kUnqualifiedId') {
        const id = kids(c).find(t => isToken(t) && t.tag === 'SymbolIdentifier');
        if (id?.text && !out.includes(id.text)) out.push(id.text);
        continue;
      }
      if (c.tag === 'kParamByName' || c.tag === 'kActualParameterList') continue;
      this.signals(c, out);
    }
    return out;
  }

  /** First SymbolIdentifier token at this node's own level or inside a direct kUnqualifiedId. */
  ownName(n: N): CstNode | undefined {
    for (const c of kids(n)) {
      if (isToken(c) && c.tag === 'SymbolIdentifier') return c;
      if (c.tag === 'kUnqualifiedId') {
        const t = kids(c).find(t => isToken(t) && t.tag === 'SymbolIdentifier');
        if (t) return t;
      }
    }
    return undefined;
  }

  module(decl: CstNode): Module | null {
    const header = find(decl, 'kModuleHeader');
    if (!header) return null;
    const nameTok = kids(header).find(t => isToken(t) && t.tag === 'SymbolIdentifier');
    if (!nameTok?.text) return null;
    const kw = kids(header).find(t => isToken(t));
    const m: Module = {
      name: nameTok.text,
      file: this.src.file,
      params: [], ports: [], instances: [], drivers: [], reads: [], nets: [],
      loc: this.loc(decl),
      headerLoc: this.loc({ tag: 'x', children: [kw ?? nameTok, nameTok] }),
    };

    const fpl = find(header, 'kFormalParameterListDeclaration');
    for (const p of findAll(fpl, 'kParamDeclaration')) this.param(p, m, false);

    const portList = findDeep(find(header, 'kParenGroup'), 'kPortDeclarationList')
      ?? findDeep(find(header, 'kParenGroup'), 'kPortList');
    if (portList) this.ansiPorts(portList, m);

    const items = find(decl, 'kModuleItemList');
    this.items(items, m, []);
    // Unique keys: the same instance name may appear in several if/else generate branches.
    const seen = new Map<string, number>();
    for (const inst of m.instances) {
      const k = (seen.get(inst.name) ?? 0) + 1;
      seen.set(inst.name, k);
      inst.key = k === 1 ? inst.name : `${inst.name}#${k}`;
    }
    return m;
  }

  param(p: CstNode, m: Module, bodyLevel: boolean) {
    const kw = kids(p).find(t => isToken(t) && (t.tag === 'parameter' || t.tag === 'localparam'));
    const pt = find(p, 'kParamType');
    if (!pt) return;
    // The name is the last identifier of kParamType outside its type info.
    let nameTok: CstNode | undefined;
    for (const c of kids(pt)) {
      if (c.tag === 'kTypeInfo' || c.tag === 'kPackedDimensions' || c.tag === 'kUnpackedDimensions') continue;
      if (isToken(c) && c.tag === 'SymbolIdentifier') nameTok = c;
      if (c.tag === 'kUnqualifiedId') nameTok = kids(c).find(t => t.tag === 'SymbolIdentifier') ?? nameTok;
    }
    if (!nameTok?.text) return;
    const ta = find(p, 'kTrailingAssign');
    const value = ta ? this.text(ta).replace(/^\s*=\s*/, '').trim() : undefined;
    const local = kw?.tag === 'localparam' || (bodyLevel && m.params.some(x => !x.local));
    m.params.push({ name: nameTok.text, value, local, loc: this.loc(nameTok) });
  }

  ansiPorts(list: CstNode, m: Module) {
    let prev = null as Omit<Port, 'name' | 'loc' | 'unpacked'> | null;
    for (const c of kids(list)) {
      if (c.tag === 'kPortDeclaration') {
        const dirTok = kids(c).find(t => isToken(t) && DIRS.has(t.tag));
        const dt = find(c, 'kDataType');
        const nameTok = this.ownName(c);
        if (!nameTok?.text) continue;
        const packedN = findDeep(dt, 'kPackedDimensions');
        const packed = this.oneLine(packedN);
        // Type text: tokens between direction and name, minus packed dims (e.g. "logic", "wire", "my_pkg::t").
        const typeParts: string[] = [];
        for (const k of kids(c)) {
          if (k === dirTok || k === nameTok || k.tag === 'kUnqualifiedId' || k.tag === 'kUnpackedDimensions') continue;
          if (k.tag === 'kDataType') {
            const t = this.oneLine(k).replace(packed, '').trim();
            if (t) typeParts.push(t);
          } else if (isToken(k)) typeParts.push(k.text ?? k.tag);
          else typeParts.push(this.oneLine(k));
        }
        const dir: Direction = dirTok ? (dirTok.tag as Direction) : (prev?.dir ?? 'unknown');
        prev = { dir, type: typeParts.join(' ').trim(), packed };
        m.ports.push({ ...prev, name: nameTok.text, unpacked: this.oneLine(find(c, 'kUnpackedDimensions')), loc: this.loc(nameTok) });
      } else if (c.tag === 'kPort') {
        // Either a continuation of the previous ANSI declaration (`input a, b`) or a non-ANSI name.
        const ref = find(c, 'kPortReference');
        const nameTok = this.ownName(ref);
        if (!nameTok?.text) continue;
        m.ports.push({
          name: nameTok.text,
          dir: prev?.dir ?? 'unknown',
          type: prev?.type ?? '',
          packed: prev?.packed ?? '',
          unpacked: this.oneLine(findDeep(ref, 'kUnpackedDimensions')),
          loc: this.loc(nameTok),
        });
      }
    }
  }

  /** Body port declarations (non-ANSI): fill in direction/type/range for header names. */
  bodyPorts(d: CstNode, m: Module) {
    const dirTok = kids(d).find(t => isToken(t) && DIRS.has(t.tag));
    const dt = find(d, 'kDataType');
    const packed = this.oneLine(findDeep(dt, 'kPackedDimensions'));
    const typeTokens = kids(d).filter(t => isToken(t) && !DIRS.has(t.tag) && t.tag !== ';' && t.tag !== ',').map(t => t.text ?? t.tag);
    const dtText = this.oneLine(dt).replace(packed, '').trim();
    const type = [...typeTokens, dtText].filter(Boolean).join(' ');
    const names: CstNode[] = [];
    for (const lst of kids(d)) {
      if (lst === dt || isToken(lst)) continue;
      for (const tag of ['kIdentifierUnpackedDimensions', 'kPortIdentifier']) {
        for (const it of findAll({ tag: 'x', children: [lst] }, tag)) {
          const t = this.ownName(it);
          if (t) names.push(t);
        }
      }
    }
    for (const t of names) {
      const port: Port = {
        name: t.text!, dir: (dirTok?.tag as Direction) ?? 'unknown', type, packed, unpacked: '', loc: this.loc(t),
      };
      const i = m.ports.findIndex(p => p.name === t.text);
      if (i >= 0) m.ports[i] = port; else m.ports.push(port);
    }
  }

  items(list: N, m: Module, gen: Gen[]) {
    for (const c of kids(list)) this.item(c, m, gen);
  }

  item(c: CstNode, m: Module, gen: Gen[]) {
    switch (c.tag) {
      case 'kParamDeclaration':
        this.param(c, m, true);
        return;
      case 'kModulePortDeclaration':
        this.bodyPorts(c, m);
        return;
      case 'kNetDeclaration': {
        for (const v of findAll(c, 'kNetVariable')) { const t = this.ownName(v); if (t?.text) m.nets.push(t.text); }
        for (const v of findAll(c, 'kNetDeclarationAssignment')) {
          const t = this.ownName(v);
          if (t?.text) { m.nets.push(t.text); this.driver(m, t.text, 'assign', v); this.read(m, find(v, 'kTrailingAssign')); }
        }
        return;
      }
      case 'kDataDeclaration': {
        const base = find(c, 'kInstantiationBase');
        const list = find(base, 'kGateInstanceRegisterVariableList');
        for (const g of kids(list)) {
          if (g.tag === 'kGateInstance') this.instance(base!, g, m, gen);
          else if (g.tag === 'kRegisterVariable') {
            const t = this.ownName(g);
            // `logic r = '0;` declares a variable with an initial value (IEEE 1800 §6.8), not a
            // continuous driver, so the initializer is neither a driver nor a read. Net declaration
            // assignments (`wire w = a;`) are continuous and handled under kNetDeclaration.
            if (t?.text) m.nets.push(t.text);
          }
        }
        return;
      }
      case 'kContinuousAssignmentStatement':
        for (const a of findAll(c, 'kNetVariableAssignment')) this.lhs(a, m, 'assign', a);
        this.read(m, c);
        return;
      case 'kAlwaysStatement':
      case 'kInitialStatement': {
        const kw = kids(c).find(isToken);
        const kind: DriverKind = c.tag === 'kInitialStatement' ? 'initial'
          : (['always_ff', 'always_comb', 'always_latch'].includes(kw?.tag ?? '') ? kw!.tag as DriverKind : 'always');
        for (const tag of ['kNetVariableAssignment', 'kNonblockingAssignmentStatement', 'kBlockingAssignmentStatement', 'kAssignModifyStatement']) {
          for (const a of findAll(c, tag)) this.lhs(a, m, kind, a);
        }
        this.read(m, c);
        return;
      }
      case 'kGenerateRegion':
        this.items(find(c, 'kGenerateItemList'), m, gen);
        return;
      case 'kLoopGenerateConstruct': {
        const hdr = this.oneLine(find(c, 'kLoopHeader'), 80);
        const blk = find(c, 'kGenerateBlock');
        const label = this.label(blk);
        this.genBody(blk ?? c, m, [...gen, { label, desc: `${label ? label + ': ' : ''}${hdr}` }]);
        return;
      }
      case 'kConditionalGenerateConstruct': {
        for (const clause of kids(c)) {
          const hdr = this.oneLine(findDeep(clause, 'kGenerateIfHeader') ?? findDeep(clause, 'kGenerateElseHeader'), 80) || 'else';
          const blk = findDeep(clause, 'kGenerateBlock');
          const label = this.label(blk);
          this.genBody(blk ?? clause, m, [...gen, { label, desc: `${label ? label + ': ' : ''}${hdr}` }]);
        }
        return;
      }
      case 'kCaseGenerateConstruct': {
        this.genBody(c, m, [...gen, { label: '', desc: this.oneLine(c, 60) }]);
        return;
      }
      case 'kGenerateBlock':
        this.genBody(c, m, gen);
        return;
      default:
        return;
    }
  }

  genBody(n: CstNode, m: Module, gen: Gen[]) {
    const list = find(n, 'kGenerateItemList');
    if (list) return this.items(list, m, gen);
    for (const c of kids(n)) {
      if (c.tag === 'kGenerateItemList') this.items(c, m, gen);
      else this.item(c, m, gen);
    }
  }

  label(blk: N): string {
    const l = findDeep(find(blk, 'kBegin'), 'kLabel');
    return l ? this.oneLine(l).replace(/^:\s*/, '') : '';
  }

  lhs(a: CstNode, m: Module, kind: DriverKind, stmt: CstNode) {
    const lp = find(a, 'kLPValue') ?? kids(a)[0];
    for (const s of this.signals(lp)) this.driver(m, s, kind, stmt);
  }

  read(m: Module, n: N) {
    for (const s of this.signals(n)) if (!m.reads.includes(s)) m.reads.push(s);
  }

  driver(m: Module, signal: string, kind: DriverKind, stmt: CstNode) {
    m.drivers.push({ signal, kind, text: this.oneLine(stmt), loc: this.loc(stmt) });
  }

  instance(base: CstNode, g: CstNode, m: Module, gen: Gen[]) {
    const it = find(base, 'kInstantiationType');
    const dt = find(it, 'kDataType') ?? it;
    // Module name: first identifier in the type, outside the parameter list.
    const typeId = findDeep(dt, 'kUnqualifiedId');
    const modTok = typeId ? kids(typeId).find(t => t.tag === 'SymbolIdentifier') : undefined;
    const instTok = kids(g).find(t => isToken(t) && t.tag === 'SymbolIdentifier');
    if (!modTok?.text || !instTok?.text) return;

    const params: Instance['params'] = [];
    const apl = findDeep(dt, 'kActualParameterList');
    let pos = 0;
    for (const pb of findAll(apl, 'kParamByName')) {
      const nm = kids(pb).find(t => t.tag === 'SymbolIdentifier');
      params.push({ name: nm?.text ?? '', expr: this.oneLine(find(pb, 'kParenGroup')).replace(/^\(|\)$/g, '').trim() });
    }
    if (!params.length && apl) {
      const pg = find(apl, 'kParenGroup');
      const inner = kids(pg).find(k => !isToken(k));
      for (const e of kids(inner)) if (!isToken(e)) params.push({ name: `#${pos++}`, expr: this.oneLine(e) });
    }

    const conns: Connection[] = [];
    let wildcard = false;
    const pal = findDeep(find(g, 'kParenGroup'), 'kPortActualList');
    let idx = 0;
    for (const c of kids(pal)) {
      if (c.tag === 'kActualNamedPort') {
        const toks = kids(c).filter(isToken);
        if (toks.some(t => t.tag === '.*' || t.text === '.*')) { wildcard = true; continue; }
        const nm = toks.find(t => t.tag === 'SymbolIdentifier');
        const pg = find(c, 'kParenGroup');
        if (!nm?.text) continue;
        if (!pg) {
          conns.push({ port: nm.text, expr: nm.text, signals: [nm.text], implicit: true, loc: this.loc(c) });
        } else {
          const expr = this.oneLine(pg).replace(/^\(|\)$/g, '').trim();
          conns.push({ port: nm.text, expr, signals: this.signals(pg), loc: this.loc(c) });
        }
        idx++;
      } else if (c.tag === 'kActualPositionalPort') {
        conns.push({ port: '', position: idx++, expr: this.oneLine(c), signals: this.signals(c), loc: this.loc(c) });
      } else if (isToken(c) && (c.tag === '.*' || c.text === '.*')) {
        wildcard = true;
      }
    }
    m.instances.push({
      name: instTok.text + this.oneLine(find(g, 'kUnpackedDimensions')),
      key: '',   // assigned once the whole module is read
      moduleName: modTok.text,
      params, connections: conns, wildcard,
      generate: gen.length ? gen.map(x => x.desc).join(' / ') : undefined,
      genScopes: gen.map(x => x.label),
      loc: this.loc(g),
    });
  }
}

export function extractModules(pf: ParsedFile): Module[] {
  if (!pf.tree) return [];
  const ex = new Extractor(new Src(pf.file, pf.buf));
  const out: Module[] = [];
  for (const d of findAll(pf.tree, 'kModuleDeclaration', [], new Set(['kModuleItemList']))) {
    const m = ex.module(d);
    if (m) out.push(m);
  }
  return out;
}

export const _internal = { span, kids, find, findAll };
