import * as assert from 'assert';
import * as vscode from 'vscode';

// End-to-end check inside a real VS Code on test-fixtures/sample-soc:
// activation, design scan, run discovery, finding resolution, diagnostics, diagram panel.
export async function run(): Promise<void> {
  const ext = vscode.extensions.all.find(e => e.packageJSON.name === 'rtl-diagram');
  assert.ok(ext, 'extension present');
  const api = (await ext!.activate()) as { store: any };
  const store = api.store;
  assert.ok(store.design?.modules.soc_top, 'soc_top parsed');
  assert.strictEqual(store.runs.length, 2, `runs discovered: ${store.runs.length}`);
  const run = store.runs.find((r: any) => r.runId === '20260115-100000-0000001');
  store.setActive(run);
  assert.strictEqual(store.resolutions.get(0).primary.module, 'soc_top');
  const diags = vscode.languages.getDiagnostics().flatMap(([, d]) => d).filter(d => String(d.source).startsWith('verif'));
  assert.strictEqual(diags.length, 2, `diagnostics: ${diags.length}`);
  await vscode.commands.executeCommand('rtlDiagram.showFinding', run.dir, 0);
  await new Promise(r => setTimeout(r, 1500));
  const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs).map(t => t.label);
  assert.ok(tabs.some(l => l.startsWith('RTL')), `diagram tab open: ${tabs.join(', ')}`);
}
