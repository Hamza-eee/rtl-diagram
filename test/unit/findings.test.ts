import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadRun } from '../../src/findings/run';
import { resolveFinding } from '../../src/findings/resolve';
import { buildView, isCompound, tieLevel } from '../../src/graph';
import { loadBender } from '../../src/sources/bender';
import { designOf, SOC } from './helpers';

const REPORTS = path.join(SOC, 'top/dv/soc_tb/reports');
const FAIL = path.join(REPORTS, '20260115-100000-0000001');
const CLEAN = path.join(REPORTS, '20260115-120000-0000002');
const socDesign = () => designOf(loadBender([path.join(SOC, 'top')]).files.map(f => f.file));

function tmpRun(mutate: (run: any, sarif: any) => void, withSarif = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-run-'));
  const run = JSON.parse(fs.readFileSync(path.join(FAIL, 'run.json'), 'utf8'));
  const sarif = JSON.parse(fs.readFileSync(path.join(FAIL, 'findings.sarif'), 'utf8'));
  mutate(run, sarif);
  run.run_id = path.basename(dir);
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run));
  if (withSarif) fs.writeFileSync(path.join(dir, 'findings.sarif'), JSON.stringify(sarif));
  return dir;
}

describe('loadRun', () => {
  it('reads run.json and findings.sarif', () => {
    const r = loadRun(FAIL);
    assert.deepStrictEqual(r.issues, []);
    assert.strictEqual(r.status, 'fail');
    assert.strictEqual(r.dutTop, 'soc_top');
    assert.strictEqual(r.rules.length, 4);
    assert.deepStrictEqual(r.findings.map(f => [f.ruleId, f.level]), [['SOC-IRQ-001', 'error'], ['SOC-TMR-002', 'warning'], ['SOC-EVT-003', 'note']]);
    const f = r.findings[0];
    assert.deepStrictEqual(f.logical.map(l => [l.name, l.role]), [['dut', undefined], ['irq_o', 'primary'], ['paddr_i', 'context'], ['pwdata_i', 'context']]);
    assert.strictEqual(f.fingerprint.length, 16);
    assert.strictEqual(r.repoRoot, SOC);   // inferred from files.findings
  });

  it('reads a clean run: every rule listed, zero results', () => {
    const r = loadRun(CLEAN);
    assert.strictEqual(r.status, 'pass');
    assert.strictEqual(r.findings.length, 0);
    assert.strictEqual(r.rules.length, 4);
  });

  it('flags a run without findings.sarif as broken', () => {
    const dir = tmpRun(() => undefined, false);
    const r = loadRun(dir);
    assert.strictEqual(r.broken, true);
    assert.ok(r.issues.some(i => /findings\.sarif is missing/.test(i)));
    fs.rmSync(dir, { recursive: true });
  });

  it('warns on an unsupported schema major version and on a result without a primary', () => {
    const dir = tmpRun((run, sarif) => {
      run.schema_version = '2.0.0';
      sarif.runs[0].results[0].locations[0].logicalLocations[1].properties.role = 'context';
    });
    const r = loadRun(dir);
    assert.ok(r.issues.some(i => /schema_version 2\.0\.0 is not supported/.test(i)));
    assert.ok(r.issues.some(i => /expected exactly one primary variable, found 0/.test(i)));
    fs.rmSync(dir, { recursive: true });
  });
});

describe('resolveFinding', () => {
  let d: Awaited<ReturnType<typeof designOf>>;
  before(async () => { d = await socDesign(); });

  it('maps a DUT port to its declaration and driver', () => {
    const run = loadRun(FAIL);
    const r = resolveFinding(d, run, run.findings[0]);
    assert.strictEqual(r.primary!.status, 'ok');
    assert.strictEqual(r.primary!.module, 'soc_top');
    assert.strictEqual(r.primary!.port!.dir, 'output');
    assert.ok(r.primary!.port!.loc.file.endsWith('soc_top.sv'));
    assert.deepStrictEqual(r.primary!.drivers.map(x => x.text), ['irq_o = |(expired & irq_en)']);
    assert.deepStrictEqual(r.context.map(c => [c.signal, c.status]), [['paddr_i', 'ok'], ['pwdata_i', 'ok']]);
  });

  it('follows an instance path below the DUT', () => {
    const run = loadRun(FAIL);
    const r = resolveFinding(d, run, run.findings[1]);
    assert.strictEqual(r.primary!.module, 'timer');
    assert.deepStrictEqual(r.primary!.instPath, ['u_timer']);
    assert.deepStrictEqual(r.primary!.drivers.map(x => [x.kind, x.instance]), [['instance', 'u_core']]);
  });

  it('reports a port that does not exist, with a reason', () => {
    const run = loadRun(FAIL);
    const r = resolveFinding(d, run, run.findings[2]);
    assert.strictEqual(r.primary!.status, 'no-signal');
    assert.match(r.primary!.reason!, /soc_top has no port or net named "evt_count_o"/);
  });

  it('reports a DUT module that is not in the RTL', () => {
    const dir = tmpRun(run => { run.dut_top = 'not_in_rtl'; });
    const run = loadRun(dir);
    assert.strictEqual(resolveFinding(d, run, run.findings[0]).primary!.status, 'no-dut');
    fs.rmSync(dir, { recursive: true });
  });
});

describe('buildView', () => {
  it('lays out soc_top deterministically with finite coordinates', async () => {
    const d = await socDesign();
    const g = await buildView(d, d.modules.soc_top);
    const count = (k: string) => g.nodes.filter(n => n.kind === k).length;
    assert.strictEqual(count('inst'), 4);
    assert.strictEqual(count('in'), 8);
    assert.strictEqual(count('out'), 4);
    assert.strictEqual(count('logic'), 1);
    assert.strictEqual(count('expr'), 1);
    for (const n of g.nodes) assert.ok([n.x, n.y, n.w, n.h].every(Number.isFinite) && n.w > 0, n.id);
    for (const e of g.edges) for (const p of e.points) assert.ok(p.every(Number.isFinite), e.id);
    // div: driven by u_regs, read by u_timer
    assert.deepStrictEqual(g.edges.filter(e => e.net === 'div').map(e => `${e.from} -> ${e.to}`), ['inst:u_regs/div -> inst:u_timer/div']);
    // open and tied pins are marked
    const fifo = g.nodes.find(n => n.id === 'inst:u_evt_fifo')!;
    assert.ok(fifo.pins.find(p => p.name === 'empty')!.open);
    assert.ok(fifo.pins.find(p => p.name === 'pop')!.tie);
    assert.strictEqual(fifo.pins.find(p => p.name === 'pop')!.tieLevel, 0);       // 1'b0: ground
    // .push(evt_s & ~evt_q): one expression box, a single wire into the pin
    const into = g.edges.filter(e => e.to === 'inst:u_evt_fifo/push');
    assert.deepStrictEqual(into.map(e => e.from), ['expr:u_evt_fifo/push/=']);
    const box = g.nodes.find(n => n.id === 'expr:u_evt_fifo/push')!;
    assert.strictEqual(box.kind, 'expr');
    assert.strictEqual(box.expr, 'evt_s & ~evt_q');
    assert.deepStrictEqual(g.edges.filter(e => e.to.startsWith('expr:u_evt_fifo/push/')).map(e => `${e.net}: ${e.from}`).sort(),
      ['evt_q: logic/evt_q', 'evt_s: inst:u_sync/q']);
    // a plain part-select stays a direct wire
    assert.ok(g.edges.some(e => e.net === 'count' && e.to === 'inst:u_evt_fifo/wdata'));
    // clocks and resets are drawn as labels, not wires
    assert.strictEqual(g.edges.filter(e => e.net === 'clk_i' || e.net === 'rst_ni').length, 0);
    assert.strictEqual(g.labels.clk_i.length, 6);   // the port, u_sync, u_regs, u_timer, u_evt_fifo and the always_ff
    assert.deepStrictEqual(g.nodes.find(n => n.id === 'inst:u_regs')!.pins.find(p => p.name === 'pclk')!.netLabels, ['clk_i']);
    // with labels disabled the same nets become wires
    const wired = await buildView(d, d.modules.soc_top, { labelFanout: 0, labelPattern: '' });
    assert.strictEqual(wired.edges.filter(e => e.net === 'clk_i').length, 5);
    const g2 = await buildView(d, d.modules.soc_top);
    assert.deepStrictEqual(g2.nodes.map(n => [n.id, n.x, n.y]), g.nodes.map(n => [n.id, n.x, n.y]));
  });
});

describe('connection helpers', () => {
  it('recognises constants tied to 0 or 1', () => {
    for (const z of ["1'b0", "'0", '0', "8'h00", "32'd0", "'b0", "{8{1'b0}}", "4'b0000"]) assert.strictEqual(tieLevel(z, 8), 0, z);
    for (const o of ["'1", "1'b1", "4'b1111", "8'hFF", "16'hffff", "{8{1'b1}}", "1'd1"]) assert.strictEqual(tieLevel(o, 8), 1, o);
    assert.strictEqual(tieLevel('1', 1), 1);                     // 1 on a 1-bit pin
    for (const x of ['1', "4'b1", "8'h0F", "4'b1010", "8'd5", 'WIDTH', "1'bx"]) assert.strictEqual(tieLevel(x, 8), undefined, x);
  });

  it('boxes only connections with logic in them', () => {
    assert.strictEqual(isCompound('a', ['a']), false);
    assert.strictEqual(isCompound('count[0][7:0]', ['count']), false);
    assert.strictEqual(isCompound('~a', ['a']), true);
    assert.strictEqual(isCompound('a + 1', ['a']), true);
    assert.strictEqual(isCompound('{a, b}', ['a', 'b']), true);
    assert.strictEqual(isCompound("1'b0", []), false);
  });
});
