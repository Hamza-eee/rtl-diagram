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

export class Store implements vscode.Disposable {
  design?: Design;
  sources?: SourceSet;
  runs: Run[] = [];
  activeRun?: Run;
  resolutions = new Map<number, Resolution>();
  scanning = false;
  lastError?: string;

  notes: StoredNote[] = [];
  noteIssues: string[] = [];
  private authors = new Map<string, string>();

  private readonly _onDidChange = new vscode.EventEmitter<'design' | 'runs' | 'active' | 'notes'>();
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
    this.scanning = true;
    this.lastError = undefined;
    try {
      const src = discoverSources({
        roots,
        mode: c.get('sourceMode', 'auto'),
        benderRoots: c.get('benderRoots', []),
        benderTargets: c.get('benderTargets', []),
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

  // ---------------------------------------------------------------- notes

  /** Notes folder inside each project root. Settings can't point it outside the project. */
  notesFolderName(): string { return safeNotesFolder(this.cfg().get('notesFolder', '.rtl-notes')).name; }

  // ---------------------------------------------------------------- project folder

  /** The chosen project folder (setting first, then the per-workspace choice), if it still exists. */
  project(): string | undefined {
    const p = this.cfg().get<string>('projectFolder', '') || this.ctx.workspaceState.get<string>('projectFolder');
    if (!p) return undefined;
    const abs = path.isAbsolute(p) ? p : path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '.', p);
    return fs.existsSync(abs) ? abs : undefined;
  }

  /** Folders everything is read from: the project folder if one is chosen, else every workspace folder. */
  roots(): string[] {
    const p = this.project();
    return p ? [p] : (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
  }

  inScope(file: string): boolean {
    return this.roots().some(r => {
      const rel = path.relative(r, file);
      return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
    });
  }

  async setProject(folder: string | undefined) {
    await this.ctx.workspaceState.update('projectFolder', folder);
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
    const uris = (await Promise.all(this.roots().map(r =>
      vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(r), glob), '**/{node_modules,.git,venv,.venv}/**', 500)))).flat();
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
