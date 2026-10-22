import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Store } from './store';
import { buildView, DEFAULT_VIEW_OPTIONS } from './graph';
import { moduleAtPath } from './elab';
import { SrcLoc } from './model';
import { primaryOf, repoPath } from './findings/run';
import { SignalRef } from './findings/resolve';
import { pathsTo } from './findings/markers';
import { anchorLabel, detachedReason, noteMarksFor } from './notes/notes';

type ThemeMode = 'auto' | 'light' | 'dark';

interface Loc { file: string; line: number; col?: number }

export class DiagramPanel implements vscode.Disposable {
  static current?: DiagramPanel;
  private panel: vscode.WebviewPanel;
  private top = '';
  private path: string[] = [];
  private disposables: vscode.Disposable[] = [];
  private ready = false;
  private pendingSelect?: { finding?: number; node?: string; note?: string };
  private renderSeq = 0;

  static show(ctx: vscode.ExtensionContext, store: Store): DiagramPanel {
    if (DiagramPanel.current) {
      DiagramPanel.current.panel.reveal(undefined, false);
      return DiagramPanel.current;
    }
    DiagramPanel.current = new DiagramPanel(ctx, store);
    return DiagramPanel.current;
  }

  private constructor(private ctx: vscode.ExtensionContext, private store: Store) {
    this.panel = vscode.window.createWebviewPanel('rtlDiagram.diagram', 'RTL Diagram', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist'), vscode.Uri.joinPath(ctx.extensionUri, 'media')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'activity.svg');
    this.panel.webview.html = this.html();
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage(m => this.onMessage(m)),
      store.onDidChange(e => { if (e === 'pending') this.postLive(); else void this.render(); }),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('rtlDiagram')) this.postTheme(); }),
    );
    const saved = ctx.workspaceState.get<{ top: string; path: string[] }>('view');
    if (saved) { this.top = saved.top; this.path = saved.path; }
  }

  dispose() {
    DiagramPanel.current = undefined;
    this.disposables.forEach(d => d.dispose());
    this.panel.dispose();
  }

  navigate(top: string, instPath: string[], select?: { finding?: number; node?: string; note?: string }) {
    this.top = top;
    this.path = instPath;
    this.pendingSelect = select;
    void this.ctx.workspaceState.update('view', { top, path: instPath });
    void this.render();
  }

  private html(): string {
    const w = this.panel.webview;
    const js = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'));
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'diagram.css'));
    const nonce = [...Array(24)].map(() => Math.floor(Math.random() * 36).toString(36)).join('');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${w.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>RTL Diagram</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
  }

  private themeMode(): ThemeMode {
    return this.ctx.workspaceState.get<ThemeMode>('theme') ?? this.store.cfg().get<ThemeMode>('theme', 'auto');
  }

  private postTheme() {
    const c = this.store.cfg();
    void this.panel.webview.postMessage({
      type: 'theme', mode: this.themeMode(),
      colors: {
        block: c.get('colors.block', ''), wire: c.get('colors.wire', ''),
        error: c.get('colors.error', ''), warning: c.get('colors.warning', ''), note: c.get('colors.note', ''),
        portGroups: c.get('colors.portGroups', {}),
      },
    });
  }

  async render() {
    if (!this.ready) return;
    const seq = ++this.renderSeq;
    const d = this.store.design;
    if (!d || !Object.keys(d.modules).length) {
      void this.panel.webview.postMessage({ type: 'empty', scanning: this.store.scanning, error: this.store.lastError, sourceMode: d?.sourceMode });
      return;
    }
    if (!this.top || !d.modules[this.top]) {
      const run = this.store.activeRun;
      this.top = run && d.modules[run.dutTop] ? run.dutTop : this.store.tops()[0];
      this.path = [];
    }
    let m = moduleAtPath(d, this.top, this.path);
    if (!m) { this.path = []; m = d.modules[this.top]; }
    const c = this.store.cfg();
    const graph = await buildView(d, m, {
      labelFanout: c.get('netLabels.minLoads', DEFAULT_VIEW_OPTIONS.labelFanout),
      labelPattern: c.get('netLabels.pattern', DEFAULT_VIEW_OPTIONS.labelPattern),
    });
    if (seq !== this.renderSeq) return;   // a newer render superseded this one
    const crumbs = [{ label: this.top, sub: '', path: [] as string[] }];
    let cur: typeof m | undefined = d.modules[this.top];
    this.path.forEach((p, i) => {
      const inst = cur?.instances.find(x => x.key === p);
      crumbs.push({ label: inst?.name ?? p, sub: inst?.moduleName ?? '', path: this.path.slice(0, i + 1) });
      cur = inst ? d.modules[inst.moduleName] : undefined;
    });
    const run = this.store.activeRun;
    const findings = run ? run.findings.map(f => {
      const r = this.store.resolutions.get(f.index);
      return {
        index: f.index, ruleId: f.ruleId, level: f.level, message: f.message,
        signal: r?.primary?.signal ?? primaryOf(f)?.name ?? '', module: r?.primary?.module,
        resolved: r?.primary?.status === 'ok', here: r?.primary?.module === m!.name,
      };
    }) : [];
    const nm = noteMarksFor(d, this.store.notes, this.top, this.path);
    const notes = {
      marks: nm.marks, here: nm.here, issues: this.store.noteIssues,
      all: this.store.notes.map(n => ({
        id: n.id, kind: n.kind, text: n.text, author: n.author, created: n.created, updated: n.updated,
        resolved: n.resolved, label: anchorLabel(n), detached: detachedReason(d, n), anchor: n.anchor,
      })),
    };
    this.panel.title = `RTL · ${m.name}`;
    void this.panel.webview.postMessage({
      type: 'view', graph, crumbs, markers: this.store.markersFor(this.top, this.path),
      run: run ? {
        id: run.runId, status: run.status, dutTop: run.dutTop, testbench: run.testbench, broken: run.broken,
        commit: run.gitCommit?.slice(0, 10), dirty: !!run.dirty,
        freshness: this.store.freshness ? {
          state: this.store.freshness.state, reason: this.store.freshness.reason,
          changed: this.store.freshness.changed.map(f => ({ file: f, rel: vscode.workspace.asRelativePath(f) })),
        } : null,
      } : null,
      live: this.liveState(),
      findings, notes, path: this.path, sourceMode: d.sourceMode, tops: this.store.tops(), top: this.top,
      select: this.pendingSelect,
    });
    if (this.pendingSelect?.finding !== undefined) this.sendDetail(this.pendingSelect.finding);
    this.pendingSelect = undefined;
  }

  private liveState() {
    return { on: this.store.live(), pending: [...this.store.pending].sort().map(f => vscode.workspace.asRelativePath(f)) };
  }

  /** Live/pending changes only need the banner and toggle updated, not a new layout. */
  private postLive() {
    if (this.ready) void this.panel.webview.postMessage({ type: 'live', live: this.liveState() });
  }

  showFinding(idx: number) {
    const run = this.store.activeRun;
    const d = this.store.design;
    const p = this.store.resolutions.get(idx)?.primary;
    if (!run || !d) return;
    if (p?.status === 'ok') {
      // Go to the exact instance the finding names: under the current top if the DUT sits there once,
      // otherwise from the DUT itself.
      const pre = this.top ? this.store.dutPrefix(this.top) : null;
      if (pre !== null) this.navigate(this.top, [...pre, ...p.instPath], { finding: idx });
      else this.navigate(run.dutTop, p.instPath, { finding: idx });
    } else {
      this.sendDetail(idx);
    }
  }

  /** Open the view where a note is shown: its pinned instance, else the module under the current top, else any top. */
  gotoNote(id: string) {
    const d = this.store.design;
    const n = this.store.notes.find(x => x.id === id);
    if (!d || !n) return;
    const a = n.anchor;
    if (a.scope && d.modules[a.scope.top]) return this.navigate(a.scope.top, a.scope.instPath, { note: id });
    const tops = [this.top, ...this.store.tops()].filter((t, i, l) => t && l.indexOf(t) === i);
    for (const t of tops) {
      if (t === a.module) return this.navigate(t, [], { note: id });
      const p = pathsTo(d, t, a.module, 1)[0];
      if (p) return this.navigate(t, p, { note: id });
    }
    if (d.modules[a.module]) this.navigate(a.module, [], { note: id });
  }

  private sendDetail(idx: number) {
    const run = this.store.activeRun;
    const f = this.store.finding(idx);
    if (!run || !f) return;
    const res = this.store.resolutions.get(idx);
    const rule = run.rules.find(r => r.id === f.ruleId);
    const loc = (l?: SrcLoc): Loc | undefined => l ? { file: l.file, line: l.line, col: l.col } : undefined;
    const repo = (rel?: string, line?: number) => {
      if (!rel) return undefined;
      const abs = repoPath(run, rel);
      return { rel, file: abs, line: line ? line - 1 : 0, exists: fs.existsSync(abs) };
    };
    const sig = (r?: SignalRef) => r && {
      signal: r.signal, role: r.role, module: r.module, status: r.status, reason: r.reason, isNet: r.isNet,
      instPath: r.instPath,
      decl: loc(r.port?.loc), dir: r.port?.dir, range: r.port ? (r.port.packed + (r.port.unpacked ? ' ' + r.port.unpacked : '')) : '',
      drivers: r.drivers.map(x => ({ kind: x.kind, text: x.text, instance: x.instance, instPort: x.instPort, loc: loc(x.loc) })),
    };
    void this.panel.webview.postMessage({
      type: 'detail',
      finding: {
        index: f.index, ruleId: f.ruleId, level: f.level, message: f.message, fingerprint: f.fingerprint, props: f.props,
        rule: rule ? { short: rule.short, full: rule.full, specRef: rule.specRef, channel: rule.channel, designRef: rule.designRef } : null,
        primary: sig(res?.primary), context: (res?.context ?? []).map(c => sig(c)),
        related: f.related.map(r => ({ ...repo(r.uri, r.line), message: r.message })),
        physical: f.physical ? repo(f.physical.uri, f.physical.line) : undefined,
        waveform: f.props.waveform ? { ...repo(f.props.waveform.file), start_ns: f.props.waveform.start_ns, end_ns: f.props.waveform.end_ns } : undefined,
        designDoc: repo(run.designDoc),
        dutTop: run.dutTop, dutInstance: run.dutInstance, runId: run.runId,
        // Contract: `reproduce` runs from the testbench directory, i.e. reports/<run_id>/../..
        tbDir: path.dirname(path.dirname(run.dir)),
        moduleChanged: this.store.moduleChanged(res?.primary?.module),
        freshness: this.store.freshness ? { state: this.store.freshness.state, reason: this.store.freshness.reason } : null,
      },
    });
  }

  private async onMessage(m: any) {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.postTheme();
        await this.render();
        return;
      case 'drill': {
        const d = this.store.design;
        const cur = d && moduleAtPath(d, this.top, this.path);
        const inst = cur?.instances.find(i => i.key === m.inst);
        if (inst && d!.modules[inst.moduleName]) this.navigate(this.top, [...this.path, m.inst]);
        return;
      }
      case 'goto':
        this.navigate(this.top, m.path ?? []);
        return;
      case 'setTop':
        this.navigate(m.top, []);
        return;
      case 'open':
        await openLoc(m.loc, m.preview !== false);
        return;
      case 'openFile':
        if (m.file && fs.existsSync(m.file)) await openLoc({ file: m.file, line: m.line ?? 0 }, false);
        else vscode.window.showWarningMessage(`File not found: ${m.rel ?? m.file}`);
        return;
      case 'reveal':
        if (m.file) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(m.file));
        return;
      case 'selectFinding':
        this.sendDetail(m.index);
        return;
      case 'showFinding':
        this.showFinding(m.index);
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        vscode.window.setStatusBarMessage('Copied to clipboard', 2000);
        return;
      case 'runInTerminal': {
        // The command comes from a findings file, so it is untrusted. The terminal turns any
        // newline or control character into keystrokes, which would run (part of) it immediately.
        const text = String(m.text ?? '');
        if (/[\x00-\x1f\x7f]/.test(text)) {
          void vscode.window.showWarningMessage(
            'The reproduce command contains a line break or control character, so it was not typed into a terminal. Use Copy and check it first.');
          return;
        }
        const t = vscode.window.createTerminal({ name: 'RTL Diagram: reproduce', cwd: m.cwd && fs.existsSync(m.cwd) ? m.cwd : undefined });
        t.show();
        t.sendText(text, false);   // typed, not executed: the user presses Enter
        return;
      }
      case 'addNote': {
        const n = await this.store.addNote(m.anchor, m.kind, String(m.text ?? ''));
        if (!n) vscode.window.showWarningMessage('The note was not saved: it is empty or there is no workspace folder to store it in.');
        else this.pendingSelect = { note: n.id };
        return;
      }
      case 'updateNote':
        this.store.updateNote(m.id, { text: m.text, kind: m.kind, resolved: m.resolved });
        this.pendingSelect = { note: m.id };
        return;
      case 'deleteNote': {
        const n = this.store.notes.find(x => x.id === m.id);
        if (!n) return;
        const ok = await vscode.window.showWarningMessage(`Delete this ${n.kind}? It is removed for everyone once the deletion is committed.`, { modal: true }, 'Delete');
        if (ok === 'Delete') this.store.deleteNote(m.id);
        return;
      }
      case 'gotoNote':
        this.gotoNote(m.id);
        return;
      case 'setLive':
        await this.store.setLive(!!m.on);
        return;
      case 'refresh':
        await vscode.commands.executeCommand('rtlDiagram.refresh');
        return;
      case 'setTheme':
        await this.ctx.workspaceState.update('theme', m.mode);
        this.postTheme();
        return;
    }
  }
}

export async function openLoc(l: Loc, preview = true) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(l.file));
  const pos = new vscode.Position(l.line, l.col ?? 0);
  await vscode.window.showTextDocument(doc, {
    selection: new vscode.Range(pos, pos), preview, viewColumn: vscode.ViewColumn.Beside,
  });
}
