import * as assert from 'assert';
import * as path from 'path';
import { resolveHierPath } from '../../src/elab';
import { buildView } from '../../src/graph';
import { Finding, Run } from '../../src/findings/run';
import { Resolution, resolveFinding } from '../../src/findings/resolve';
import { countAt, dutPrefix, markersFor } from '../../src/findings/markers';
import { designOf, FIX } from './helpers';

const HIER = path.join(FIX, 'sv/hier.sv');

function runWith(fqns: string[], level: Finding['level'] = 'error'): Run {
  const findings: Finding[] = fqns.map((fqn, index) => ({
    index, ruleId: `R-${index}`, level, message: 'm', related: [], fingerprint: '', props: {},
    logical: [{ fqn: 'tb.dut', name: 'dut', kind: 'module' }, { fqn, name: fqn.split('.').pop()!, kind: 'variable', role: 'primary' }],
  }));
  return {
    dir: '/x', repoRoot: '/x', runId: 'r', schemaVersion: '1.0.0', status: 'fail', pkg: '', testbench: '',
    dutTop: 'hier_top', dutInstance: 'tb.dut', seeds: [], tests: [], rules: [], findings, issues: [], broken: false,
  };
}

describe('instance keys and generate scopes', () => {
  let d: Awaited<ReturnType<typeof designOf>>;
  before(async () => { d = await designOf([HIER]); });

  it('gives repeated instance names in if/else branches unique keys', () => {
    const xs = d.modules.hier_top.instances.filter(i => i.name === 'u_x');
    assert.deepStrictEqual(xs.map(i => [i.key, i.genScopes]), [['u_x', ['g_a']], ['u_x#2', ['g_b']]]);
  });

  it('records generate scopes, including unlabelled blocks', () => {
    const by = (k: string) => d.modules.hier_top.instances.find(i => i.key === k)!;
    assert.deepStrictEqual(by('u_f').genScopes, ['g_ch']);
    assert.deepStrictEqual(by('u_y').genScopes, ['']);
    assert.deepStrictEqual(by('u_tx').genScopes, []);
    assert.strictEqual(by('u_arr[1:0]').name, 'u_arr[1:0]');
  });

  it('draws every instance as its own node', async () => {
    const g = await buildView(d, d.modules.hier_top);
    const ids = g.nodes.map(n => n.id);
    assert.strictEqual(new Set(ids).size, ids.length);
    assert.ok(ids.includes('inst:u_x') && ids.includes('inst:u_x#2'));
    const a = g.nodes.find(n => n.id === 'inst:u_x')!, b = g.nodes.find(n => n.id === 'inst:u_x#2')!;
    assert.ok(a.x !== b.x || a.y !== b.y, 'not stacked on the same spot');
  });
});

describe('resolveHierPath', () => {
  let d: Awaited<ReturnType<typeof designOf>>;
  before(async () => { d = await designOf([HIER]); });
  const ok = (elems: string[]) => { const r = resolveHierPath(d, 'hier_top', elems); assert.ok(r.ok, JSON.stringify(r)); return r.path; };

  it('resolves generate-for scopes with an index', () => assert.deepStrictEqual(ok(['g_ch[0]', 'u_f']), ['u_f']));
  it('resolves instance-array elements', () => assert.deepStrictEqual(ok(['u_arr[1]']), ['u_arr[1:0]']));
  it('picks the right if/else branch by its label', () => {
    assert.deepStrictEqual(ok(['g_a', 'u_x']), ['u_x']);
    assert.deepStrictEqual(ok(['g_b', 'u_x']), ['u_x#2']);
  });
  it('accepts implicit genblkN scopes', () => assert.deepStrictEqual(ok(['genblk1', 'u_y']), ['u_y']));
  it('accepts a unique instance name without its scope', () => assert.deepStrictEqual(ok(['u_f']), ['u_f']));
  it('refuses an ambiguous name without its scope, and unknown names, with a reason', () => {
    const amb = resolveHierPath(d, 'hier_top', ['u_x']);
    assert.ok(!amb.ok && /not inside generate scope/.test(amb.reason));
    const bad = resolveHierPath(d, 'hier_top', ['g_zz', 'u_f']);
    assert.ok(!bad.ok && /no instance or generate block named "g_zz"/.test(bad.reason));
  });

  it('resolves findings through generate scopes', () => {
    const run = runWith(['tb.dut.g_ch[1].u_f.q', 'tb.dut.g_b.u_x.q', 'tb.dut.u_arr[0].a']);
    const st = run.findings.map(f => resolveFinding(d, run, f).primary!);
    assert.deepStrictEqual(st.map(p => [p.status, p.instPath, p.module]), [
      ['ok', ['u_f'], 'leafh'], ['ok', ['u_x#2'], 'leafh'], ['ok', ['u_arr[1:0]'], 'leafh'],
    ]);
  });
});

describe('markers by instance path', () => {
  let d: Awaited<ReturnType<typeof designOf>>;
  let run: Run;
  let res: Map<number, Resolution>;
  before(async () => {
    d = await designOf([HIER]);
    run = runWith(['tb.dut.u_tx.q']);
    res = new Map(run.findings.map(f => [f.index, resolveFinding(d, run, f)]));
  });

  it('marks only the instance the finding names, not its siblings', () => {
    const m = markersFor(d, run, res, 'hier_top', []);
    assert.deepStrictEqual(Object.keys(m.pins), ['inst:u_tx/q']);
    assert.deepStrictEqual(Object.keys(m.nodes), ['inst:u_tx']);
    assert.strictEqual(m.byModule, false);
  });

  it('marks the port and its driver inside that instance only', () => {
    const inTx = markersFor(d, run, res, 'hier_top', ['u_tx']);
    assert.deepStrictEqual(Object.keys(inTx.pins).sort(), ['logic/q', 'port:q/p']);
    const inRx = markersFor(d, run, res, 'hier_top', ['u_rx']);
    assert.deepStrictEqual(inRx.pins, {});
  });

  it('places findings under a wrapper that holds the DUT once', () => {
    assert.deepStrictEqual(dutPrefix(d, 'wrap_once', 'hier_top'), ['u_dut']);
    const m = markersFor(d, run, res, 'wrap_once', []);
    assert.deepStrictEqual(m.nodes['inst:u_dut'], { error: 1, warning: 0, note: 0, inside: true });
    assert.deepStrictEqual(Object.keys(markersFor(d, run, res, 'wrap_once', ['u_dut']).pins), ['inst:u_tx/q']);
    assert.strictEqual(countAt(d, run, res, 'wrap_once', ['u_dut', 'u_tx']), 1);
    assert.strictEqual(countAt(d, run, res, 'wrap_once', ['u_dut', 'u_rx']), 0);
  });

  it('falls back to matching by module when the DUT is instantiated twice', () => {
    assert.strictEqual(dutPrefix(d, 'wrap_twice', 'hier_top'), null);
    const m = markersFor(d, run, res, 'wrap_twice', []);
    assert.strictEqual(m.byModule, true);
    assert.deepStrictEqual(Object.keys(m.nodes).sort(), ['inst:u_d0', 'inst:u_d1']);
  });
});
