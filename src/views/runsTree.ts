import * as vscode from 'vscode';
import { Store } from '../store';
import { Finding, Rule, Run } from '../findings/run';

type RunNode =
  | { kind: 'run'; run: Run }
  | { kind: 'issues'; run: Run }
  | { kind: 'issue'; text: string }
  | { kind: 'rule'; run: Run; rule: Rule; findings: Finding[] }
  | { kind: 'finding'; run: Run; finding: Finding };

const LEVEL_ICON: Record<string, [string, string]> = {
  error: ['error', 'problemsErrorIcon.foreground'],
  warning: ['warning', 'problemsWarningIcon.foreground'],
  note: ['info', 'problemsInfoIcon.foreground'],
  none: ['circle-outline', 'foreground'],
};

export class RunsTree implements vscode.TreeDataProvider<RunNode> {
  private readonly _onDidChange = new vscode.EventEmitter<RunNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private store: Store) {
    store.onDidChange(() => this._onDidChange.fire(undefined));
  }

  getTreeItem(n: RunNode): vscode.TreeItem {
    switch (n.kind) {
      case 'run': {
        const r = n.run;
        const active = this.store.activeRun?.dir === r.dir;
        const it = new vscode.TreeItem(r.runId, active ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        const t = r.totals?.findings;
        const counts = t ? [t.error && `${t.error} error${t.error > 1 ? 's' : ''}`, t.warning && `${t.warning} warning${t.warning > 1 ? 's' : ''}`].filter(Boolean).join(', ') : '';
        it.description = `${active ? '● ' : ''}${r.testbench}${counts ? ' · ' + counts : ''}`;
        it.iconPath = r.broken ? new vscode.ThemeIcon('debug-disconnect', new vscode.ThemeColor('problemsErrorIcon.foreground'))
          : r.status === 'pass' ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
          : new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
        it.tooltip = new vscode.MarkdownString([
          `**${r.runId}**: ${r.status}${r.broken ? ' (broken run)' : ''}`,
          `package \`${r.pkg}\` · testbench \`${r.testbench}\``,
          `DUT \`${r.dutTop}\` at \`${r.dutInstance}\``,
          r.simulator ? `${r.simulator.name} ${r.simulator.version}` : '',
          r.gitCommit ? `commit \`${r.gitCommit.slice(0, 10)}\`${r.dirty ? ' (dirty)' : ''}` : '',
          r.totals ? `${r.totals.passed}/${r.totals.tests} tests passed` : '',
          '', active ? 'Active: findings are shown on the diagram.' : 'Click to show this run on the diagram.',
        ].filter(x => x !== undefined).join('\n\n'));
        it.command = { command: 'rtlDiagram.activateRun', title: 'Activate run', arguments: [r.dir] };
        it.contextValue = 'run';
        return it;
      }
      case 'issues': {
        const it = new vscode.TreeItem(`${n.run.issues.length} contract issue${n.run.issues.length > 1 ? 's' : ''}`, vscode.TreeItemCollapsibleState.Collapsed);
        it.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
        return it;
      }
      case 'issue': {
        const it = new vscode.TreeItem(n.text);
        it.tooltip = n.text;
        return it;
      }
      case 'rule': {
        const worst = n.findings.find(f => f.level === 'error') ?? n.findings.find(f => f.level === 'warning') ?? n.findings[0];
        const it = new vscode.TreeItem(n.rule.id, n.findings.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        it.description = n.findings.length ? n.rule.short : `checked, clean · ${n.rule.short}`;
        const [icon, color] = worst ? LEVEL_ICON[worst.level] ?? LEVEL_ICON.none : ['pass', 'testing.iconPassed'];
        it.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
        const sr = n.rule.specRef;
        it.tooltip = new vscode.MarkdownString(`**${n.rule.id}**${n.rule.channel ? ` · ${n.rule.channel}` : ''}\n\n${n.rule.full || n.rule.short}${sr ? `\n\n${sr.doc} §${sr.section}${sr.page ? `, p. ${sr.page}` : ''}` : ''}`);
        return it;
      }
      case 'finding': {
        const f = n.finding;
        const res = this.store.resolutions.get(f.index);
        const sig = res?.primary?.signal ?? '(no primary signal)';
        const it = new vscode.TreeItem(sig);
        const ok = res?.primary?.status === 'ok';
        it.description = `${ok ? '' : 'unresolved · '}${f.props.test ?? ''}${f.props.seed !== undefined ? ` · seed ${f.props.seed}` : ''}`;
        const [icon, color] = LEVEL_ICON[f.level] ?? LEVEL_ICON.none;
        it.iconPath = new vscode.ThemeIcon(ok ? icon : 'question', new vscode.ThemeColor(color));
        it.tooltip = new vscode.MarkdownString(`**${f.level}**: ${f.message}${ok ? '' : `\n\n_Unresolved: ${res?.primary?.reason ?? 'no primary signal'}_`}`);
        it.command = { command: 'rtlDiagram.showFinding', title: 'Show finding', arguments: [n.run.dir, f.index] };
        return it;
      }
    }
  }

  getChildren(n?: RunNode): RunNode[] {
    if (!n) return this.store.runs.map(run => ({ kind: 'run' as const, run }));
    if (n.kind === 'run') {
      const out: RunNode[] = [];
      if (n.run.issues.length) out.push({ kind: 'issues', run: n.run });
      const failing = n.run.rules.map(rule => ({ kind: 'rule' as const, run: n.run, rule, findings: n.run.findings.filter(f => f.ruleId === rule.id) }));
      // Failing rules first (errors, then warnings), clean rules after, each group in declaration order.
      const rank = (x: typeof failing[number]) => x.findings.some(f => f.level === 'error') ? 0 : x.findings.some(f => f.level === 'warning') ? 1 : x.findings.length ? 2 : 3;
      out.push(...failing.map((x, i) => ({ x, i })).sort((a, b) => rank(a.x) - rank(b.x) || a.i - b.i).map(({ x }) => x));
      // Results whose rule is missing from rules[] still need to be visible.
      const orphan = n.run.findings.filter(f => !n.run.rules.some(r => r.id === f.ruleId));
      for (const f of orphan) out.push({ kind: 'finding', run: n.run, finding: f });
      return out;
    }
    if (n.kind === 'issues') return n.run.issues.map(text => ({ kind: 'issue' as const, text }));
    if (n.kind === 'rule') return n.findings.map(finding => ({ kind: 'finding' as const, run: n.run, finding }));
    return [];
  }
}
