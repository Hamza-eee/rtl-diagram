import { ISSUE_KIND_LABEL } from '../issues';
import * as vscode from 'vscode';
import * as path from 'path';
import { Store } from '../store';

export interface HierNode {
  kind: 'top' | 'inst' | 'info' | 'issues' | 'issue' | 'others';
  top?: string;
  path?: string[];           // instance path from top
  module?: string;
  instName?: string;
  text?: string;
  file?: string;
  line?: number;
  detail?: string;
}

export class HierarchyTree implements vscode.TreeDataProvider<HierNode> {
  private readonly _onDidChange = new vscode.EventEmitter<HierNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private store: Store) {
    store.onDidChange(() => this._onDidChange.fire(undefined));
  }

  getTreeItem(n: HierNode): vscode.TreeItem {
    const d = this.store.design;
    switch (n.kind) {
      case 'info': {
        const it = new vscode.TreeItem(n.text ?? '', vscode.TreeItemCollapsibleState.None);
        it.iconPath = new vscode.ThemeIcon('files');
        it.command = { command: 'rtlDiagram.showSources', title: 'Show source files' };
        it.tooltip = 'Where RTL files come from. Click to list them.';
        return it;
      }
      case 'issues': {
        const it = new vscode.TreeItem(n.text ?? '', vscode.TreeItemCollapsibleState.Collapsed);
        it.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
        return it;
      }
      case 'issue': {
        const it = new vscode.TreeItem(n.text ?? '', vscode.TreeItemCollapsibleState.None);
        it.tooltip = n.detail ? `${n.text}\n${n.detail}` : n.text;
        if (n.file) {
          it.description = path.basename(n.file) + (n.line ? `:${n.line}` : '');
          it.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(n.file), n.line ? { selection: new vscode.Range(n.line - 1, 0, n.line - 1, 0) } : undefined] };
        }
        return it;
      }
      case 'others': {
        const it = new vscode.TreeItem(n.text ?? '', vscode.TreeItemCollapsibleState.Collapsed);
        it.iconPath = new vscode.ThemeIcon('symbol-namespace');
        return it;
      }
      default: {
        const m = d?.modules[n.module!];
        const hasKids = !!m?.instances.length;
        const label = n.kind === 'top' ? n.module! : n.instName!;
        const it = new vscode.TreeItem(label, hasKids ? (n.kind === 'top' && n === this.firstTop ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None);
        it.description = n.kind === 'inst' ? n.module : (m?.pkg ?? '');
        it.iconPath = new vscode.ThemeIcon(m ? (n.kind === 'top' ? 'circuit-board' : 'symbol-module') : 'question');
        it.tooltip = m ? `${n.module}\n${m.file}${m.pkg ? `\npackage: ${m.pkg}` : ''}\n${m.ports.length} ports · ${m.instances.length} instances\n\nClick to open in the diagram.` : `${n.module}: not found in the RTL sources`;
        it.contextValue = m ? 'module' : 'missing';
        if (m) it.command = { command: 'rtlDiagram.showModule', title: 'Show in diagram', arguments: [{ top: n.top, path: n.path }] };
        const counts = this.store.findingCountAt(n.top!, n.path ?? []);
        if (counts) it.description = `${it.description ?? ''}  ● ${counts}`.trim();
        return it;
      }
    }
  }

  private firstTop?: HierNode;

  getChildren(n?: HierNode): HierNode[] {
    const d = this.store.design;
    if (!d) return [];
    if (!n) {
      const out: HierNode[] = [];
      if (!Object.keys(d.modules).length) return [];
      out.push({ kind: 'info', text: d.sourceMode });
      const open = this.store.issues.filter(i => !this.store.checkedIssues.has(i.key)).length;
      if (this.store.issues.length) out.push({ kind: 'issues', text: `${open} source issue${open === 1 ? '' : 's'}${open < this.store.issues.length ? ` (${this.store.issues.length - open} checked)` : ''}` });
      const tops = this.store.tops();
      // Roots: tops with children first; single-module tops collapse into "Other modules".
      const big = tops.filter(t => d.modules[t].instances.length);
      const small = tops.filter(t => !d.modules[t].instances.length);
      const tnodes = big.map(t => ({ kind: 'top' as const, top: t, path: [], module: t }));
      this.firstTop = tnodes[0];
      out.push(...tnodes);
      if (small.length) out.push({ kind: 'others', text: `Standalone modules (${small.length})`, module: small.join(',') });
      return out;
    }
    if (n.kind === 'issues') {
      return this.store.issues.map(i => ({ kind: 'issue', text: `${this.store.checkedIssues.has(i.key) ? '✓ ' : ''}${ISSUE_KIND_LABEL[i.kind]} ${i.title}`, file: i.file, line: i.line, detail: i.detail }));
    }
    if (n.kind === 'others') {
      return (n.module ?? '').split(',').filter(Boolean).map(t => ({ kind: 'top', top: t, path: [], module: t }));
    }
    if (n.kind === 'top' || n.kind === 'inst') {
      const m = d.modules[n.module!];
      if (!m) return [];
      // Guard against recursive instantiation.
      const chain = new Set<string>([n.top!]);
      let cur = d.modules[n.top!];
      for (const p of n.path ?? []) { const i = cur?.instances.find(x => x.key === p); if (!i) break; chain.add(i.moduleName); cur = d.modules[i.moduleName]; }
      return m.instances
        .filter(i => !chain.has(i.moduleName) || i.moduleName !== m.name)
        .map(i => ({ kind: 'inst' as const, top: n.top, path: [...(n.path ?? []), i.key], module: i.moduleName, instName: i.name }));
    }
    return [];
  }

  getParent(): undefined { return undefined; }
}
