// Extension-side state: the parsed design, discovered runs, the active run and
// its resolved findings. Views (trees, panel, diagnostics) subscribe to changes.

import * as vscode from 'vscode';
import * as path from 'path';
import { Design, Module, ParseIssue } from './model';
import { buildDesign, topCandidates } from './elab';
import { discoverSources, SourceSet } from './sources/discover';
import { parseFiles } from './sv/verible';
import { extractModules } from './sv/extract';
import { Finding, Level, Run, loadRun } from './findings/run';
import { Resolution, resolveFinding } from './findings/resolve';

export interface Marker { f: number; level: Level; role: 'primary' | 'context' | 'driver' }
export interface ViewMarkers {
  pins: Record<string, Marker[]>;
  nodes: Record<string, { error: number; warning: number; note: number; inside: boolean }>;
  nets: Record<string, Marker[]>;
}

export class Store implements vscode.Disposable {
  design?: Design;
  sources?: SourceSet;
  runs: Run[] = [];
  activeRun?: Run;
  resolutions = new Map<number, Resolution>();
  scanning = false;
  lastError?: string;

  private readonly _onDidChange = new vscode.EventEmitter<'design' | 'runs' | 'active'>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private ctx: vscode.ExtensionContext) {}

  dispose() { this._onDidChange.dispose(); }

  cfg() { return vscode.workspace.getConfiguration('rtlDiagram'); }

  async rescanDesign(): Promise<void> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const c = this.cfg();
    this.scanning = true;
    this.lastError = undefined;
    try {
      const src = discoverSources({
        roots,
        mode: c.get('sourceMode', 'auto'),
        benderRoots: c.get('benderRoots', []),
        filelists: c.get('filelists', []),
        include: c.get('include', '**/*.{sv,v}'),
        exclude: c.get('exclude', []),
      });
      this.sources = src;
      const files = src.files.map(f => f.file);
      const pkgOf = new Map(src.files.map(f => [f.file, f.pkg]));
      const parsed = await parseFiles(c.get('veriblePath', 'verible-verilog-syntax'), files);
      const mods: Module[] = [];
      const issues: ParseIssue[] = src.issues.map(m => ({ file: '', message: m }));
      for (const pf of parsed) {
        for (const e of pf.errors) issues.push({ file: pf.file, message: `syntax error: ${e.text ?? e.phase ?? ''}`.trim(), line: e.line });
        for (const m of extractModules(pf)) { m.pkg = pkgOf.get(pf.file); mods.push(m); }
      }
      this.design = buildDesign(mods, files, issues, src.label);
      for (const [name, fs] of Object.entries(this.design.duplicates)) {
        issues.push({ file: fs[0], message: `module ${name} is declared in ${fs.length} files; using the first: ${fs.map(f => path.basename(f)).join(', ')}` });
      }
      this.resolveAll();
    } catch (e: any) {
      this.lastError = e.message;
      vscode.window.showErrorMessage(`RTL Diagram: ${e.message}`);
    } finally {
      this.scanning = false;
      this._onDidChange.fire('design');
    }
  }

  extraRunDirs(): string[] { return this.ctx.workspaceState.get<string[]>('extraRuns', []); }

  async addRunDir(dir: string) {
    const l = this.extraRunDirs();
    if (!l.includes(dir)) await this.ctx.workspaceState.update('extraRuns', [...l, dir]);
    await this.rescanRuns();
    const r = this.runs.find(x => x.dir === dir);
    if (r) this.setActive(r);
  }

  async rescanRuns(): Promise<void> {
    const glob = this.cfg().get('runsGlob', '**/reports/*/run.json');
    const uris = await vscode.workspace.findFiles(glob, '**/{node_modules,.git,venv,.venv}/**', 500);
    const dirs = new Set([...uris.map(u => path.dirname(u.fsPath)), ...this.extraRunDirs()]);
    const prevActive = this.activeRun?.dir;
    this.runs = [...dirs].map(d => loadRun(d)).sort((a, b) => b.runId.localeCompare(a.runId));
    this.activeRun = this.runs.find(r => r.dir === prevActive);
    this.resolveAll();
    this._onDidChange.fire('runs');
  }

  setActive(run: Run | undefined) {
    this.activeRun = run;
    this.resolveAll();
    this._onDidChange.fire('active');
  }

  private resolveAll() {
    this.resolutions.clear();
    if (!this.activeRun || !this.design) return;
    for (const f of this.activeRun.findings) this.resolutions.set(f.index, resolveFinding(this.design, this.activeRun, f));
  }

  tops(): string[] { return this.design ? topCandidates(this.design) : []; }

  /** Instance path from `top` to the first instance of `target`, depth-first in source order. */
  pathTo(top: string, target: string): string[] | undefined {
    const d = this.design;
    if (!d) return undefined;
    if (top === target) return [];
    const seen = new Set<string>();
    const dfs = (mod: string): string[] | undefined => {
      if (seen.has(mod)) return undefined;
      seen.add(mod);
      for (const i of d.modules[mod]?.instances ?? []) {
        if (i.moduleName === target) return [i.name];
        const r = dfs(i.moduleName);
        if (r) return [i.name, ...r];
      }
      return undefined;
    };
    return dfs(top);
  }

  /** Modules reachable below `mod` (for "finding inside this block" badges). */
  private below(mod: string, acc = new Set<string>()): Set<string> {
    for (const i of this.design?.modules[mod]?.instances ?? []) {
      if (!acc.has(i.moduleName)) { acc.add(i.moduleName); this.below(i.moduleName, acc); }
    }
    return acc;
  }

  markersFor(mod: Module): ViewMarkers {
    const out: ViewMarkers = { pins: {}, nodes: {}, nets: {} };
    const run = this.activeRun;
    if (!run) return out;
    const push = (rec: Record<string, Marker[]>, k: string, mk: Marker) => {
      const l = (rec[k] ??= []);
      if (!l.some(x => x.f === mk.f && x.role === mk.role)) l.push(mk);
    };
    const bump = (id: string, level: Level, inside: boolean) => {
      const n = (out.nodes[id] ??= { error: 0, warning: 0, note: 0, inside: false });
      if (level === 'error' || level === 'warning' || level === 'note') n[level]++;
      n.inside ||= inside;
    };
    for (const f of run.findings) {
      const res = this.resolutions.get(f.index);
      if (!res) continue;
      const refs = [...(res.primary ? [res.primary] : []), ...res.context];
      const badged = new Set<string>();
      for (const ref of refs) {
        if (ref.status !== 'ok' || !ref.module) continue;
        const role = ref === res.primary ? 'primary' : 'context';
        const mk: Marker = { f: f.index, level: f.level, role };
        if (ref.module === mod.name) {
          if (ref.port) push(out.pins, `port:${ref.signal}/p`, mk);
          push(out.nets, ref.signal, mk);
          if (role === 'primary') {
            for (const d of ref.drivers) {
              const dm: Marker = { f: f.index, level: f.level, role: 'driver' };
              if (d.kind === 'instance' && d.instance && d.instPort) push(out.pins, `inst:${d.instance}/${d.instPort}`, dm);
              else push(out.pins, `logic/${ref.signal}`, dm);
            }
          }
        }
        for (const inst of mod.instances) {
          const id = `inst:${inst.name}`;
          if (inst.moduleName === ref.module) {
            if (ref.port) push(out.pins, `${id}/${ref.signal}`, mk);
            if (!badged.has(id)) { badged.add(id); bump(id, f.level, false); }
          } else if (this.below(inst.moduleName).has(ref.module) && !badged.has(id)) {
            badged.add(id);
            bump(id, f.level, true);
          }
        }
      }
    }
    return out;
  }

  finding(idx: number): Finding | undefined {
    return this.activeRun?.findings.find(f => f.index === idx);
  }
}
