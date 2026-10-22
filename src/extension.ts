import * as vscode from 'vscode';
import * as path from 'path';
import { Store } from './store';
import { HierarchyTree } from './views/hierTree';
import { RunsTree } from './views/runsTree';
import { DiagramPanel, openLoc } from './panel';
import { clearCache } from './sv/verible';
import { findProjects } from './util/projects';
import * as fs from 'fs';

export async function activate(ctx: vscode.ExtensionContext) {
  const store = new Store(ctx);
  ctx.subscriptions.push(store);

  const hier = new HierarchyTree(store);
  const hierView = vscode.window.createTreeView('rtlDiagram.hierarchy', { treeDataProvider: hier });
  // The Hierarchy view's title shows which project is open (or that one must be chosen).
  const updateHierTitle = () => { hierView.description = store.projectLabel(); };
  store.onDidChange(updateHierTitle);
  const runs = new RunsTree(store);
  ctx.subscriptions.push(
    hierView,
    vscode.window.registerTreeDataProvider('rtlDiagram.runs', runs),
  );

  // Status bar: where the RTL comes from.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.command = 'rtlDiagram.chooseProject';
  ctx.subscriptions.push(status);
  const updateStatus = () => {
    const d = store.design;
    if (store.scanning) status.text = '$(sync~spin) RTL: scanning…';
    else if (store.lastError) status.text = '$(error) RTL: parser error';
    else {
      status.text = store.needsProject() ? '$(repo) RTL: choose a project' : `$(circuit-board) RTL: ${store.projectLabel()} · ${d?.sourceMode ?? 'no sources'}`;
    }
    status.tooltip = store.lastError ?? `Project: ${store.needsProject() ? 'not chosen yet' : store.project() ?? 'all workspace folders'}\nClick to open another project.`;
    status.show();
  };

  // Problems panel: one diagnostic per resolved finding, on the port declaration.
  const diags = vscode.languages.createDiagnosticCollection('rtlDiagram');
  ctx.subscriptions.push(diags);
  const updateDiagnostics = () => {
    diags.clear();
    const run = store.activeRun;
    if (!run) return;
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const f of run.findings) {
      const p = store.resolutions.get(f.index)?.primary;
      const loc = p?.port?.loc;
      if (!loc) continue;
      const range = new vscode.Range(loc.line, loc.col, loc.endLine, loc.endCol);
      const sev = f.level === 'error' ? vscode.DiagnosticSeverity.Error : f.level === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
      const stale = store.moduleChanged(store.resolutions.get(f.index)?.primary?.module) ? ' (this file changed since the run)' : '';
      const d = new vscode.Diagnostic(range, `${f.message} [${f.props.test ?? ''}${f.props.seed !== undefined ? `, seed ${f.props.seed}` : ''}]${stale}`, sev);
      d.source = `verif ${run.runId}`;
      d.code = f.ruleId;
      (byFile.get(loc.file) ?? byFile.set(loc.file, []).get(loc.file)!).push(d);
    }
    for (const [file, list] of byFile) diags.set(vscode.Uri.file(file), list);
  };

  ctx.subscriptions.push(store.onDidChange(() => { updateStatus(); updateDiagnostics(); }));

  const openPanel = () => DiagramPanel.show(ctx, store);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('rtlDiagram.openDiagram', () => { openPanel(); }),
    vscode.commands.registerCommand('rtlDiagram.refresh', async () => {
      clearCache();
      updateStatus();
      await Promise.all([store.rescanDesign(), store.rescanRuns()]);
    }),
    vscode.commands.registerCommand('rtlDiagram.openRun', async () => {
      const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Open run', title: 'Choose a run directory (contains run.json)' });
      if (pick?.[0]) await store.addRunDir(pick[0].fsPath);
    }),
    vscode.commands.registerCommand('rtlDiagram.activateRun', (dir: string) => {
      const r = store.runs.find(x => x.dir === dir);
      store.setActive(store.activeRun?.dir === dir ? store.activeRun : r);
      openPanel();
    }),
    vscode.commands.registerCommand('rtlDiagram.clearRun', () => store.setActive(undefined)),
    vscode.commands.registerCommand('rtlDiagram.selectTop', async () => {
      const tops = store.tops();
      const pick = await vscode.window.showQuickPick(tops.map(t => ({ label: t, description: store.design?.modules[t]?.pkg })), { title: 'Top module' });
      if (pick) openPanel().navigate(pick.label, []);
    }),
    vscode.commands.registerCommand('rtlDiagram.showModule', (a: { top: string; path: string[] }) => {
      openPanel().navigate(a.top, a.path ?? []);
    }),
    vscode.commands.registerCommand('rtlDiagram.showFinding', (dir: string, idx: number) => {
      if (store.activeRun?.dir !== dir) store.setActive(store.runs.find(r => r.dir === dir));
      openPanel().showFinding(idx);
    }),
    vscode.commands.registerCommand('rtlDiagram.toggleLive', async () => {
      await store.setLive(!store.live());
      vscode.window.setStatusBarMessage(store.live() ? 'RTL Diagram: live updates on' : 'RTL Diagram: live updates paused', 2500);
    }),
    vscode.commands.registerCommand('rtlDiagram.chooseProject', async () => {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Looking for RTL projects…' }, () => store.detectProjects());
      const current = store.needsProject() ? undefined : store.project();
      const whole = !store.needsProject() && !current;
      type Item = vscode.QuickPickItem & { folder?: string; browse?: boolean; whole?: boolean };
      const items: Item[] = [
        ...store.candidates.map(f => ({
          label: `${f === current ? '$(check)' : '$(repo)'} ${path.basename(f)}`, description: vscode.workspace.asRelativePath(f), folder: f,
          detail: f === current ? 'Open now' : fs.existsSync(path.join(f, 'Bender.yml')) ? 'Bender package' : undefined,
        })),
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: '$(folder-opened) Browse for a folder…', browse: true },
        { label: `${whole ? '$(check)' : '$(root-folder)'} Whole workspace`, description: 'every workspace folder together', whole: true },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        title: 'RTL Diagram: open a project',
        placeHolder: store.candidates.length ? 'RTL, verification runs and notes are read from the chosen folder only' : 'No git repositories with RTL found: browse for a folder, or use the whole workspace',
        matchOnDescription: true,
      });
      if (!pick) return;
      let folder = pick.folder;
      if (pick.browse) {
        const roots = store.workspaceRoots();
        const sel = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Open as project',
          defaultUri: roots[0] ? vscode.Uri.file(roots[0]) : undefined });
        if (!sel?.[0]) return;
        folder = sel[0].fsPath;
      }
      clearCache();
      await store.setProject(pick.whole ? undefined : folder);
      openPanel();
    }),
    vscode.commands.registerCommand('rtlDiagram.configureSources', async () => {
      if (store.needsProject()) { await vscode.commands.executeCommand('rtlDiagram.chooseProject'); return; }
      const ov = store.sourcesOverride();
      const cur = ov?.mode ?? 'default';
      type Item = vscode.QuickPickItem & { mode: 'default' | 'auto' | 'bender' | 'filelist' | 'glob' };
      const mark = (m: string) => (cur === m ? '$(check) ' : '');
      const items: Item[] = [
        { mode: 'default', label: `${mark('default')}Use the settings`, description: 'rtlDiagram.sourceMode and related settings', detail: 'Default. Nothing is stored for this project.' },
        { mode: 'auto', label: `${mark('auto')}Automatic`, description: 'Bender.yml, then a filelist, then all .sv/.v files' },
        { mode: 'bender', label: `${mark('bender')}Bender only`, description: 'every Bender.yml in the project' },
        { mode: 'filelist', label: `${mark('filelist')}Filelists…`, description: 'pick one or more .f files', detail: ov?.filelists?.length ? `Now: ${ov.filelists.map(f => vscode.workspace.asRelativePath(f)).join(', ')}` : undefined },
        { mode: 'glob', label: `${mark('glob')}Files matching a pattern…`, description: ov?.include ?? '**/*.{sv,v}' },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        title: `RTL Diagram: sources for ${store.projectLabel()}`,
        placeHolder: 'Where should the RTL come from? Saved for this project on this machine; nothing is written to the repository.',
      });
      if (!pick) return;
      if (pick.mode === 'default') return store.setSourcesOverride(undefined);
      if (pick.mode === 'auto' || pick.mode === 'bender') return store.setSourcesOverride({ mode: pick.mode });
      if (pick.mode === 'glob') {
        const g = await vscode.window.showInputBox({ title: 'Files to read as RTL', value: ov?.include ?? '**/*.{sv,v}',
          prompt: 'A glob relative to the project folder. Testbench folders are still excluded by rtlDiagram.exclude.' });
        if (g) await store.setSourcesOverride({ mode: 'glob', include: g });
        return;
      }
      type F = vscode.QuickPickItem & { file?: string; browse?: boolean };
      const found = store.findFilelists();
      const chosen = new Set(ov?.filelists ?? []);
      const fItems: F[] = [
        ...found.map(f => ({ label: path.basename(f), description: vscode.workspace.asRelativePath(f), file: f, picked: chosen.has(f) })),
        { label: '$(folder-opened) Browse for a filelist…', browse: true },
      ];
      const fp = await vscode.window.showQuickPick(fItems, { canPickMany: true, title: 'Filelists to read',
        placeHolder: found.length ? 'Tick the .f files to use, in order of selection' : 'No .f files found in this project: browse for one' });
      if (!fp) return;
      let files = fp.filter(x => x.file).map(x => x.file!);
      if (fp.some(x => x.browse)) {
        const sel = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Use filelist', filters: { Filelists: ['f', 'flist'], All: ['*'] } });
        files = [...files, ...(sel ?? []).map(u => u.fsPath)];
      }
      if (files.length) await store.setSourcesOverride({ mode: 'filelist', filelists: files });
    }),
    vscode.commands.registerCommand('rtlDiagram.showSources', async () => {
      const s = store.sources;
      if (!s) return;
      const items = s.files.map(f => ({ label: path.basename(f.file), description: f.pkg, detail: vscode.workspace.asRelativePath(f.file), file: f.file }));
      const pick = await vscode.window.showQuickPick(items, { title: s.label, matchOnDescription: true, matchOnDetail: true });
      if (pick) await openLoc({ file: pick.file, line: 0 }, true);
    }),
  );

  // Rescan on RTL / manifest changes (debounced) and on new runs.
  let t: NodeJS.Timeout | undefined;
  const schedule = (uri?: vscode.Uri) => {
    if (uri && !store.inScope(uri.fsPath)) return;
    // Paused: remember the change and leave the diagram as drawn (a banner offers Refresh).
    if (uri && !store.live()) { store.markPending(uri.fsPath); return; }
    if (uri) clearCache(uri.fsPath);
    if (t) clearTimeout(t);
    t = setTimeout(() => void store.rescanDesign(), 600);
  };
  const w1 = vscode.workspace.createFileSystemWatcher('**/*.{sv,svh,v,vh}');
  const w2 = vscode.workspace.createFileSystemWatcher('**/{Bender.yml,*.f}');
  // Runs: a flow may write run.json before findings.sarif, or rewrite them in place, so follow both
  // files and every kind of change, debounced so a run being written is read once it is complete.
  const w3 = vscode.workspace.createFileSystemWatcher('**/{run.json,findings.sarif}');
  let tr: NodeJS.Timeout | undefined;
  const rescanRuns = (uri?: vscode.Uri) => { if (uri && !store.inScope(uri.fsPath)) return; if (tr) clearTimeout(tr); tr = setTimeout(() => void store.rescanRuns(), 400); };
  let tn: NodeJS.Timeout | undefined;
  const reloadNotes = (uri?: vscode.Uri) => { if (uri && !store.inScope(uri.fsPath)) return; if (tn) clearTimeout(tn); tn = setTimeout(() => store.reloadNotes(), 200); };
  // The notes watcher follows rtlDiagram.notesFolder, so it is recreated when that setting changes.
  let w4: vscode.FileSystemWatcher | undefined;
  const watchNotes = () => {
    w4?.dispose();
    w4 = vscode.workspace.createFileSystemWatcher(`**/${store.notesFolderName()}/*.json`);
    w4.onDidChange(reloadNotes); w4.onDidCreate(reloadNotes); w4.onDidDelete(reloadNotes);
  };
  watchNotes();
  ctx.subscriptions.push({ dispose: () => w4?.dispose() });
  for (const w of [w1, w2]) { w.onDidChange(schedule); w.onDidCreate(schedule); w.onDidDelete(schedule); }
  w3.onDidCreate(rescanRuns); w3.onDidChange(rescanRuns); w3.onDidDelete(rescanRuns);
  ctx.subscriptions.push(w1, w2, w3, vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('rtlDiagram.notesFolder')) { watchNotes(); reloadNotes(); }
    if (e.affectsConfiguration('rtlDiagram')) { schedule(); void store.rescanRuns(); }
  }));

  updateStatus();
  // Find RTL projects first: with several and no choice, nothing is mixed; the views ask instead.
  await store.detectProjects();
  ctx.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(async () => {
    await store.detectProjects();
    await Promise.all([store.rescanDesign(), store.rescanRuns()]);
    store.reloadNotes();
  }));
  updateHierTitle();
  await Promise.all([store.rescanDesign(), store.rescanRuns()]);
  store.reloadNotes();
  return { store };   // exposed for integration tests
}

export function deactivate() { /* nothing */ }
