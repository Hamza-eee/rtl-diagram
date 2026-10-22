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
import { execFile } from 'child_process';
import * as os from 'os';
import { MAX_NOTE_LENGTH, Note, NoteAnchor, NoteKind, NOTE_KINDS, StoredNote, isAnchor, isInside, isNote, loadNotes, newNoteId, safeNotesFolder, writeNote } from './notes/notes';
import * as fs from 'fs';
import { Serial } from './util/serial';
import { FileErrors, ISSUE_KIND_LABEL, SourceIssue, collectIssues } from './issues';
import { findProjects } from './util/projects';
import { expandGlob } from './util/glob';
import { Freshness, GitRunner, runFreshness } from './findings/freshness';

export interface SourcesOverride { mode: 'auto' | 'bender' | 'filelist' | 'glob'; filelists?: string[]; include?: string }

export class Store implements vscode.Disposable {
  design?: Design;
  sources?: SourceSet;
  runs: Run[] = [];
  activeRun?: Run;
  resolutions = new Map<number, Resolution>();
  scanning = false;
  veribleMissing = false;
  lastError?: string;

  notes: StoredNote[] = [];
  noteIssues: string[] = [];
  private authors = new Map<string, string>();

  /** Does the parsed RTL still match the active run's source? Recomputed with every resolve. */
  freshness?: Freshness;
  private freshSeq = 0;
  /** RTL files saved while live updates are paused (the diagram is not redrawn until refreshed). */
  pending = new Set<string>();

  /** Problems reading the RTL, tied to the modules they affect. */
  issues: SourceIssue[] = [];
  /** Issues the user ticked off. Session only: kept across rescans, forgotten when VS Code closes. */
  checkedIssues = new Set<string>();

  private readonly _onDidChange = new vscode.EventEmitter<'design' | 'runs' | 'active' | 'notes' | 'pending' | 'issues'>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private ctx: vscode.ExtensionContext) {}

  dispose() { this._onDidChange.dispose(); }

  cfg() { return vscode.workspace.getConfiguration('rtlDiagram'); }

  private designScans = new Serial();
  private runScans = new Serial();

  rescanDesign(): Promise<void> {
    return this.designScans.run(() => this.scanDesignOnce());
  }

  private async scanDesignOnce(): Promise<void> {
    const roots = this.roots();
    const c = this.cfg();
    const ov = this.sourcesOverride();
    this.scanning = true;
    this.lastError = undefined;
    try {
      const src = discoverSources({
        roots,
        mode: ov?.mode ?? c.get('sourceMode', 'auto'),
        benderRoots: c.get('benderRoots', []),
        benderTargets: c.get('benderTargets', []),
        filelists: ov?.filelists ?? c.get('filelists', []),
        include: ov?.include ?? c.get('include', '**/*.{sv,v}'),
        exclude: c.get('exclude', []),
      });
      if (ov) src.label += ' · set for this project';
      this.sources = src;
      const files = src.files.map(f => f.file);
      const pkgOf = new Map(src.files.map(f => [f.file, f.pkg]));
      const parsed = await parseFiles(c.get('veriblePath', 'verible-verilog-syntax'), files);
      const mods: Module[] = [];
      const fileErrors: FileErrors[] = [];
      for (const pf of parsed) {
        const fm = extractModules(pf);
        for (const m of fm) { m.pkg = pkgOf.get(pf.file); mods.push(m); }
        if (pf.errors.length) fileErrors.push({ file: pf.file, errors: pf.errors, parsed: !!pf.tree, modules: fm.map(m => m.name) });
      }
      const issues: ParseIssue[] = [];
      this.design = buildDesign(mods, files, issues, src.label);
      this.issues = collectIssues(this.design, fileErrors, src.issues, roots);
      for (const i of this.issues) issues.push({ file: i.file ?? '', message: `${ISSUE_KIND_LABEL[i.kind]} ${i.title}${i.detail ? `. ${i.detail}` : ''}`, line: i.line });
      this.resolveAll();
    } catch (e: any) {
      this.lastError = e.message;
      this.veribleMissing = /Verible not found/.test(e.message);
      void vscode.commands.executeCommand('setContext', 'rtlDiagram.veribleMissing', this.veribleMissing);
      const SET = 'Set Verible path…';
      void vscode.window.showErrorMessage(`RTL Diagram: ${e.message}`, ...(this.veribleMissing ? [SET] : [])).then(a => {
        if (a === SET) void vscode.commands.executeCommand('workbench.action.openSettings', 'rtlDiagram.veriblePath');
      });
    } finally {
      this.scanning = false;
      this.pending.clear();
      if (!this.lastError && this.veribleMissing) {
        this.veribleMissing = false;
        void vscode.commands.executeCommand('setContext', 'rtlDiagram.veribleMissing', false);
      }
      this._onDidChange.fire('design');
    }
  }

  /** Runs opened by hand ('Open Run Folder…'), remembered per project so they don't leak into another one. */
  private extraRunsKey(): string { return `extraRuns:${this.project() ?? '*'}`; }
  extraRunDirs(): string[] { return this.ctx.workspaceState.get<string[]>(this.extraRunsKey(), []).filter(d => fs.existsSync(d)); }

  async addRunDir(dir: string) {
    const l = this.extraRunDirs();
    if (!l.includes(dir)) await this.ctx.workspaceState.update(this.extraRunsKey(), [...l, dir]);
    await this.rescanRuns();
    const r = this.runs.find(x => x.dir === dir);
    if (r) this.setActive(r);
  }

  // ---------------------------------------------------------------- notes

  /** Notes folder inside each project root. Settings can't point it outside the project. */
  notesFolderName(): string { return safeNotesFolder(this.cfg().get('notesFolder', '.rtl-notes')).name; }

  // ---------------------------------------------------------------- project folder

  /** RTL projects (git repositories containing RTL) found under the workspace folders. */
  candidates: string[] = [];

  workspaceRoots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
  }

  async detectProjects() {
    this.candidates = await findProjects(this.workspaceRoots());
    void vscode.commands.executeCommand('setContext', 'rtlDiagram.needsProject', this.needsProject());
  }

  private settingProject(): string | undefined {
    const p = this.cfg().get<string>('projectFolder', '');
    if (!p) return undefined;
    const abs = path.isAbsolute(p) ? p : path.resolve(this.workspaceRoots()[0] ?? '.', p);
    return fs.existsSync(abs) ? abs : undefined;
  }

  /** The remembered choice, if it still exists. (An old '*' for "whole workspace" counts as no choice.) */
  private storedChoice(): string | undefined {
    const c = this.ctx.workspaceState.get<string>('projectFolder');
    return c && c !== '*' && fs.existsSync(c) ? c : undefined;
  }

  /**
   * The project folder in use: the setting, else the remembered choice, else the only project
   * found. Undefined means no project was detected, so the open folder itself is read.
   */
  project(): string | undefined {
    return this.settingProject() ?? this.storedChoice() ?? (this.candidates.length === 1 ? this.candidates[0] : undefined);
  }

  /** Folders opened with Browse that aren't among the detected projects, most recent first. */
  recentProjects(): string[] {
    return this.ctx.workspaceState.get<string[]>('recentProjects', [])
      .filter(f => fs.existsSync(f) && !this.candidates.includes(f));
  }

  /** True if `folder` is outside every workspace folder (opened with Browse). */
  outsideWorkspace(folder: string): boolean {
    return !this.workspaceRoots().some(r => this.inScopeOf(r, folder));
  }

  /** Several projects found and none chosen: ask, rather than mixing them or picking one. */
  needsProject(): boolean {
    return !this.settingProject() && !this.storedChoice() && this.candidates.length > 1;
  }

  /** Folders everything is read from: none while a choice is needed, else the project (or the open folder if none was detected). */
  roots(): string[] {
    if (this.needsProject()) return [];
    const p = this.project();
    return p ? [p] : this.workspaceRoots();
  }

  projectLabel(): string {
    if (this.needsProject()) return 'choose a project';
    const p = this.project();
    return p ? path.basename(p) : this.workspaceRoots().map(r => path.basename(r)).join(', ') || 'no folder open';
  }

  // ---------------------------------------------------------------- per-project sources

  private sourcesKey(): string { return `sources:${this.project() ?? '*'}`; }

  /** Sources chosen in the UI for the current project (stored by the extension, not in the repo). */
  sourcesOverride(): SourcesOverride | undefined {
    return this.ctx.workspaceState.get<SourcesOverride>(this.sourcesKey());
  }

  async setSourcesOverride(o: SourcesOverride | undefined) {
    await this.ctx.workspaceState.update(this.sourcesKey(), o);
    await this.rescanDesign();
  }

  /** Filelists (.f / .flist) in the project, for the Configure Sources menu. */
  findFilelists(): string[] {
    const out: string[] = [];
    for (const r of this.roots()) out.push(...expandGlob(r, '**/*.{f,flist}'));
    return out.slice(0, 200);
  }

  inScope(file: string): boolean {
    return this.roots().some(r => {
      const rel = path.relative(r, file);
      return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
    });
  }

  /** Use `folder` as the project. A folder outside the detected projects is remembered under "Other folders". */
  async setProject(folder: string) {
    await this.ctx.workspaceState.update('projectFolder', folder);
    if (!this.candidates.includes(folder)) {
      const recent = this.ctx.workspaceState.get<string[]>('recentProjects', []).filter(f => f !== folder);
      await this.ctx.workspaceState.update('recentProjects', [folder, ...recent].slice(0, 6));
    }
    void vscode.commands.executeCommand('setContext', 'rtlDiagram.needsProject', false);
    await this.ctx.workspaceState.update('view', undefined);
    this.activeRun = undefined;
    await Promise.all([this.rescanDesign(), this.rescanRuns()]);
    this.reloadNotes();
  }

  notesDirs(): string[] {
    return this.roots().map(r => path.join(r, this.notesFolderName()));
  }

  reloadNotes() {
    const r = loadNotes(this.notesDirs());
    this.notes = r.notes;
    const folder = safeNotesFolder(this.cfg().get('notesFolder', '.rtl-notes'));
    this.noteIssues = folder.issue ? [folder.issue, ...r.issues] : r.issues;
    this._onDidChange.fire('notes');
  }

  /** Notes go in the workspace folder that holds the module's source, so they sit with that repo. */
  private notesDirFor(module: string): string | undefined {
    const file = this.design?.modules[module]?.file;
    const root = this.roots().find(r => file && this.inScopeOf(r, file)) ?? this.roots()[0];
    return root ? path.join(root, this.notesFolderName()) : undefined;
  }

  private inScopeOf(root: string, file: string): boolean {
    const rel = path.relative(root, file);
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
  }

  /** Author name: git user.name of that repo, else the OS user. */
  private author(dir: string): Promise<string> {
    const cached = this.authors.get(dir);
    if (cached) return Promise.resolve(cached);
    return new Promise(resolve => {
      execFile('git', ['config', 'user.name'], { cwd: path.dirname(dir), timeout: 3000 }, (err, out) => {
        const name = (!err && out.trim()) || os.userInfo().username;
        this.authors.set(dir, name);
        resolve(name);
      });
    });
  }

  async addNote(anchor: NoteAnchor, kind: NoteKind, text: string): Promise<Note | undefined> {
    // The anchor comes from the webview: validate it like a note read from disk.
    if (!isAnchor(anchor)) return undefined;
    const dir = this.notesDirFor(anchor.module);
    const body = String(text ?? '').trim().slice(0, MAX_NOTE_LENGTH);
    if (!dir || !body || !NOTE_KINDS.includes(kind)) return undefined;
    const note: Note = {
      schema: 1, id: newNoteId(), kind, text: body, author: await this.author(dir),
      created: new Date().toISOString(), resolved: false, anchor,
    };
    writeNote(dir, note);
    this.reloadNotes();
    return note;
  }

  updateNote(id: string, patch: { text?: string; kind?: NoteKind; resolved?: boolean }) {
    const known = this.notes.find(x => x.id === id);
    if (!known) return;
    const dir = path.dirname(known.file);
    if (!this.notesDirs().some(d => path.resolve(d) === path.resolve(dir)) || !isInside(dir, known.file)) return;
    // Re-read the file so a change pulled since the last reload isn't overwritten with stale fields.
    let n: Note = known;
    try {
      const onDisk = JSON.parse(fs.readFileSync(known.file, 'utf8'));
      if (isNote(onDisk) && onDisk.id === known.id) n = onDisk;
    } catch { /* deleted meanwhile: write the known version back */ }
    const next: Note = {
      ...n,
      text: typeof patch.text === 'string' ? patch.text.trim().slice(0, MAX_NOTE_LENGTH) || n.text : n.text,
      kind: patch.kind && NOTE_KINDS.includes(patch.kind) ? patch.kind : n.kind,
      resolved: typeof patch.resolved === 'boolean' ? patch.resolved : n.resolved,
      updated: new Date().toISOString(),
    };
    writeNote(dir, next);                      // same folder, same <id>.json as the file it came from
    this.reloadNotes();
  }

  deleteNote(id: string) {
    const n = this.notes.find(x => x.id === id);
    if (!n) return;
    const dir = path.dirname(n.file);
    if (!this.notesDirs().some(d => path.resolve(d) === path.resolve(dir)) || !isInside(dir, n.file)) return;
    try { fs.unlinkSync(n.file); } catch { /* already gone */ }
    this.reloadNotes();
  }

  rescanRuns(): Promise<void> {
    return this.runScans.run(() => this.scanRunsOnce());
  }

  private async scanRunsOnce(): Promise<void> {
    const glob = this.cfg().get('runsGlob', '**/reports/*/run.json');
    // VS Code's file search covers workspace folders; a project opened from outside them is walked directly.
    const found = (await Promise.all(this.roots().map(async r => this.outsideWorkspace(r)
      ? expandGlob(r, glob).slice(0, 500)
      : (await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(r), glob), '**/{node_modules,.git,venv,.venv}/**', 500)).map(u => u.fsPath)))).flat();
    const dirs = new Set([...found.map(f => path.dirname(f)), ...this.extraRunDirs()]);
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
    this.freshness = undefined;
    const seq = ++this.freshSeq;
    if (!this.activeRun || !this.design) return;
    for (const f of this.activeRun.findings) this.resolutions.set(f.index, resolveFinding(this.design, this.activeRun, f));
    void this.checkFreshness(seq);
  }

  /** Compare the parsed RTL with the active run's commit (git, read-only), then notify views. */
  private async checkFreshness(seq: number) {
    const run = this.activeRun, d = this.design;
    if (!run || !d) return;
    const git: GitRunner = (args, cwd) => new Promise(resolve =>
      execFile('git', args, { cwd, timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => resolve({ ok: !err, out: String(out ?? '') })));
    const anchor = d.modules[run.dutTop]?.file ? path.dirname(d.modules[run.dutTop].file) : (this.roots()[0] ?? run.dir);
    try {
      const f = await runFreshness({ gitCommit: run.gitCommit, dirty: run.dirty, finishedAt: run.finishedAt }, d.files, anchor, git);
      if (seq !== this.freshSeq) return;            // a newer design/run superseded this check
      this.freshness = f;
      this._onDidChange.fire('active');
    } catch { /* leave unknown */ }
  }

  /** True if the module's source file differs from the active run's source. */
  moduleChanged(module: string | undefined): boolean {
    const file = module && this.design?.modules[module]?.file;
    return !!file && !!this.freshness?.changed.includes(path.resolve(file));
  }

  setIssueChecked(key: string, checked: boolean) {
    if (checked) this.checkedIssues.add(key); else this.checkedIssues.delete(key);
    this._onDidChange.fire('issues');
  }

  clearIssueChecks() {
    this.checkedIssues.clear();
    this._onDidChange.fire('issues');
  }

  // ---------------------------------------------------------------- live updates

  /** Live: redraw on every RTL save (the default). Paused: keep the diagram, list what changed. */
  live(): boolean {
    return this.ctx.workspaceState.get<boolean>('liveUpdate') ?? this.cfg().get<boolean>('liveUpdate', true);
  }

  async setLive(on: boolean) {
    await this.ctx.workspaceState.update('liveUpdate', on);
    if (on && this.pending.size) { this.pending.clear(); await this.rescanDesign(); }
    this._onDidChange.fire('pending');
  }

  markPending(file: string) {
    this.pending.add(file);
    this._onDidChange.fire('pending');
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
