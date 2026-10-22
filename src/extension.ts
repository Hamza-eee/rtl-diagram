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
  const runs = new RunsTree(store);
  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider('rtlDiagram.hierarchy', hier),
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
      const p = store.project();
      status.text = `$(circuit-board) RTL: ${p ? path.basename(p) : 'whole workspace'} · ${d?.sourceMode ?? 'no sources'}`;
    }
    status.tooltip = store.lastError ?? `Project: ${store.project() ?? 'all workspace folders'}\nClick to choose the project folder.`;
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
      const d = new vscode.Diagnostic(range, `${f.message} [${f.props.test ?? ''}${f.props.seed !== undefined ? `, seed ${f.props.seed}` : ''}]`, sev);
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
    vscode.commands.registerCommand('rtlDiagram.chooseProject', async () => {
      const roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
      const current = store.project();
      type Item = vscode.QuickPickItem & { folder?: string; browse?: boolean };
      const projects = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Looking for RTL projects…' },
        async () => findProjects(roots));
      const items: Item[] = [
        ...projects.map(f => ({ label: `$(repo) ${path.basename(f)}`, description: vscode.workspace.asRelativePath(f), folder: f,
          detail: f === current ? 'Current project' : fs.existsSync(path.join(f, 'Bender.yml')) ? 'Bender package' : undefined })),
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: '$(folder-opened) Browse for a folder…', browse: true },
        { label: '$(root-folder) Whole workspace', description: 'every workspace folder', detail: current ? undefined : 'Current' },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        title: 'RTL Diagram: project folder', placeHolder: 'Sources, verification runs and notes are read from this folder only',
        matchOnDescription: true,
      });
      if (!pick) return;
      let folder = pick.folder;
      if (pick.browse) {
        const sel = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use as project',
          defaultUri: roots[0] ? vscode.Uri.file(roots[0]) : undefined });
        if (!sel?.[0]) return;
        folder = sel[0].fsPath;
      }
      clearCache();
      await store.setProject(folder);
      openPanel();
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
  const w4 = vscode.workspace.createFileSystemWatcher(`**/${store.notesFolderName()}/*.json`);
  let tn: NodeJS.Timeout | undefined;
  const reloadNotes = (uri?: vscode.Uri) => { if (uri && !store.inScope(uri.fsPath)) return; if (tn) clearTimeout(tn); tn = setTimeout(() => store.reloadNotes(), 200); };
  w4.onDidChange(reloadNotes); w4.onDidCreate(reloadNotes); w4.onDidDelete(reloadNotes);
  for (const w of [w1, w2]) { w.onDidChange(schedule); w.onDidCreate(schedule); w.onDidDelete(schedule); }
  w3.onDidCreate(rescanRuns); w3.onDidChange(rescanRuns); w3.onDidDelete(rescanRuns);
  ctx.subscriptions.push(w1, w2, w3, w4, vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('rtlDiagram')) { schedule(); void store.rescanRuns(); }
  }));

  updateStatus();
  // Several projects in one workspace (e.g. a parent folder of many repos) would be mixed together:
  // offer to pick one instead.
  if (!store.project()) {
    const roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const projects = findProjects(roots);
    if (projects.length > 1) {
      void vscode.window.showInformationMessage(
        `RTL Diagram found ${projects.length} RTL projects in this workspace and is showing them all together. Choose one?`,
        'Choose project', 'Keep whole workspace',
      ).then(a => { if (a === 'Choose project') void vscode.commands.executeCommand('rtlDiagram.chooseProject'); });
    }
  }
  await Promise.all([store.rescanDesign(), store.rescanRuns()]);
  store.reloadNotes();
  return { store };   // exposed for integration tests
}

export function deactivate() { /* nothing */ }
