import * as assert from 'assert';
import * as path from 'path';
import { designOf, FIX, SOC, PLAIN } from './helpers';
import { resolveConnections, evalExpr } from '../../src/elab';
import { loadBender } from '../../src/sources/bender';

describe('extract: synthetic edge cases', () => {
  let d: Awaited<ReturnType<typeof designOf>>;
  before(async () => { d = await designOf([path.join(FIX, 'sv/edge_cases.sv')]); });

  it('finds every module', () => {
    assert.deepStrictEqual(Object.keys(d.modules).sort(), ['leaf', 'old_style', 'top']);
  });

  it('reads ANSI ports, including `input a, b` continuations and implicit types', () => {
    const leaf = d.modules.leaf;
    assert.deepStrictEqual(leaf.ports.map(p => [p.name, p.dir, p.packed]), [
      ['clk', 'input', ''], ['a', 'input', '[W-1:0]'], ['b', 'input', '[W-1:0]'], ['y', 'output', '[W-1:0]'], ['pad', 'inout', ''],
    ]);
    assert.strictEqual(leaf.ports.find(p => p.name === 'a')!.width, 4);
    assert.strictEqual(leaf.ports.find(p => p.name === 'pad')!.type, 'wire');
  });

  it('reads header and body parameters, marking localparam as local', () => {
    const leaf = d.modules.leaf;
    assert.deepStrictEqual(leaf.params.map(p => [p.name, p.value, p.local]), [
      ['W', '4', false], ['D', '2', false], ['E', '3', false], ['L', 'W * 2', true],
    ]);
  });

  it('reads non-ANSI ports with directions from the body', () => {
    const m = d.modules.old_style;
    assert.deepStrictEqual(m.ports.map(p => [p.name, p.dir, p.packed]), [
      ['clk', 'input', ''], ['rst_n', 'input', ''], ['d', 'input', '[7:0]'], ['q', 'output', '[7:0]'],
    ]);
  });

  it('reads unpacked port dimensions', () => {
    const yy = d.modules.top.ports.find(p => p.name === 'yy')!;
    assert.strictEqual(yy.unpacked, '[N]');
  });

  it('reads instances with named, implicit, positional and wildcard connections', () => {
    const top = d.modules.top;
    assert.deepStrictEqual(top.instances.map(i => [i.name, i.moduleName]), [
      ['u_leaf', 'leaf'], ['u_old', 'old_style'], ['u_wild', 'leaf'], ['u_g', 'leaf'], ['u_cond', 'old_style'],
    ]);
    const u_leaf = top.instances[0];
    assert.deepStrictEqual(u_leaf.params, [{ name: 'W', expr: '4' }]);
    assert.deepStrictEqual(u_leaf.connections.map(c => [c.port, c.expr, c.signals]), [
      ['clk', 'clk', ['clk']], ['a', 'a', ['a']], ['b', 'b[3:0]', ['b']], ['y', 'y', ['y']], ['pad', 'pad', ['pad']],
    ]);
    assert.ok(top.instances[2].wildcard);
  });

  it('resolves positional and wildcard connections against the child header', () => {
    const top = d.modules.top;
    assert.deepStrictEqual(resolveConnections(d, top, 1).map(c => [c.port, c.dir, c.expr]), [
      ['clk', 'input', 'clk'], ['rst_n', 'input', 'rst_n'], ['d', 'input', 'd'], ['q', 'output', 'q'],
    ]);
    const wild = resolveConnections(d, top, 2);
    assert.deepStrictEqual(wild.map(c => [c.port, c.expr]), [['clk', 'clk'], ['a', 'a'], ['b', 'b'], ['y', 'y'], ['pad', '']]);
  });

  it('labels instances inside generate constructs', () => {
    const top = d.modules.top;
    assert.match(top.instances[3].generate!, /^g_leaf: for \(i = 0; i < N; i\+\+\)$/);
    assert.match(top.instances[4].generate!, /^g_extra: if \(N > 1\)$/);
    assert.strictEqual(top.instances[0].generate, undefined);
  });

  it('records drivers from assign, always and instance outputs', () => {
    const top = d.modules.top;
    const dOf = (s: string) => top.drivers.filter(x => x.signal === s).map(x => x.kind).sort();
    assert.deepStrictEqual(dOf('d'), ['assign']);
    assert.deepStrictEqual(dOf('y'), ['always_comb', 'instance', 'instance']);  // u_leaf.y, u_wild.y (.*), and the always_comb
    assert.deepStrictEqual(dOf('q'), ['instance']);
    assert.deepStrictEqual(d.modules.old_style.drivers.map(x => [x.signal, x.kind]), [['q', 'always'], ['q', 'always']]);
  });

  it('reports source locations as 0-based lines', () => {
    const clk = d.modules.leaf.ports[0];
    assert.strictEqual(clk.loc.line, 7);   // "    input  logic         clk," is line 8 in the file
  });
});

describe('extract: sample SoC', () => {
  let d: Awaited<ReturnType<typeof designOf>>;
  before(async () => { d = await designOf(loadBender([path.join(SOC, 'top')]).files.map(f => f.file)); });

  it('reads soc_top instances in source order', () => {
    assert.deepStrictEqual(d.modules.soc_top.instances.map(i => `${i.name}:${i.moduleName}`), [
      'u_sync:sync_2ff', 'u_regs:regs', 'u_timer:timer', 'u_evt_fifo:fifo',
    ]);
  });

  it('keeps typedef and package-scoped port types separate from port names', () => {
    const mode = d.modules.timer.ports.find(p => p.name === 'mode')!;
    assert.strictEqual(mode.type, 'soc_pkg::mode_t');
    assert.strictEqual(mode.unpacked, '[N]');
    assert.strictEqual(d.modules.timer_core.ports.find(p => p.name === 'mode')!.type, 'mode_t');
  });

  it('evaluates widths from parameter defaults, including $clog2', () => {
    assert.strictEqual(d.modules.soc_top.ports.find(p => p.name === 'pwdata_i')!.width, 32);
    assert.strictEqual(d.modules.timer.ports.find(p => p.name === 'expired')!.width, 2);
    assert.strictEqual(d.modules.timer.ports.find(p => p.name === 'load')!.width, 16);
  });

  it('labels generate-for instances without a generate keyword', () => {
    const core = d.modules.timer.instances.find(i => i.name === 'u_core')!;
    assert.match(core.generate!, /^g_ch: for \(genvar i = 0; i < N; i\+\+\)$/);
  });

  it('keeps expression, constant and open connections', () => {
    const f = d.modules.soc_top.instances.find(i => i.name === 'u_evt_fifo')!;
    const c = (p: string) => f.connections.find(x => x.port === p)!;
    assert.deepStrictEqual([c('push').expr, c('push').signals], ['evt_s & ~evt_q', ['evt_s', 'evt_q']]);
    assert.deepStrictEqual([c('pop').expr, c('pop').signals], ["1'b0", []]);
    assert.deepStrictEqual([c('wdata').expr, c('wdata').signals], ['count[0][7:0]', ['count']]);
    assert.strictEqual(c('empty').expr, '');
  });

  it('finds drivers of irq_o and of expired through a generate block', () => {
    assert.deepStrictEqual(d.modules.soc_top.drivers.filter(x => x.signal === 'irq_o').map(x => [x.kind, x.text]),
      [['assign', 'irq_o = |(expired & irq_en)']]);
    assert.deepStrictEqual(d.modules.timer.drivers.filter(x => x.signal === 'expired').map(x => [x.kind, x.instance, x.instPort]),
      [['instance', 'u_core', 'expired']]);
  });

  it('reads a Verilog-2001 non-ANSI module with a body parameter', async () => {
    const p = await designOf([path.join(PLAIN, 'counter.v')]);
    assert.deepStrictEqual(p.modules.counter.ports.map(x => `${x.dir} ${x.name} ${x.width}`), ['input clk 1', 'input rst 1', 'input en 1', 'output q 4']);
    assert.deepStrictEqual(p.modules.counter.params.map(x => [x.name, x.local]), [['WIDTH', false]]);
  });
});

describe('evalExpr', () => {
  const env = { W: 8, N: 16 };
  const cases: [string, number | undefined][] = [
    ['W-1', 7], ['$clog2(N)-1', 3], ['(W*2)/4', 4], ["8'hFF", 255], ['W > 4 ? 1 : 0', 1], ['2**3', 8], ['UNKNOWN-1', undefined], ['W-', undefined],
  ];
  for (const [e, v] of cases) it(`${e} = ${v}`, () => assert.strictEqual(evalExpr(e, env), v));
});
