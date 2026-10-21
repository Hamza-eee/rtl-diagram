// Extension-side state: the parsed design, discovered runs, the active run and
// its resolved findings. Views (trees, panel, diagnostics) subscribe to changes.

import * as vscode from 'vscode';
import * as path from 'path';
import { Design, Module, ParseIssue } from './model';
import { buildDesign, topCandidates } from './elab';
import { discoverSources, SourceSet } from './sources/discover';
import { parseFiles } from './sv/verible';
import { extractModules } from './sv/extract';
import { Finding, Run, loadRun } from './findings/run';
import { Resolution, resolveFinding } from './findings/resolve';
import { ViewMarkers, countAt, dutPrefix, markersFor } from './findings/markers';

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

  /** Path from `top` to the active run's DUT, or null if it is absent or not unique there. */
  dutPrefix(top: string): string[] | null {
    return this.design && this.activeRun ? dutPrefix(this.design, top, this.activeRun.dutTop) : null;
  }

  markersFor(top: string, path: string[]): ViewMarkers {
    if (!this.design) return { pins: {}, nodes: {}, nets: {}, byModule: false };
    return markersFor(this.design, this.activeRun, this.resolutions, top, path);
  }

  findingCountAt(top: string, path: string[]): number {
    return this.design ? countAt(this.design, this.activeRun, this.resolutions, top, path) : 0;
  }

  finding(idx: number): Finding | undefined {
    return this.activeRun?.findings.find(f => f.index === idx);
  }
}
