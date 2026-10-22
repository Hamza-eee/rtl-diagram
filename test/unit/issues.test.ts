import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseFiles } from '../../src/sv/verible';
import { extractModules } from '../../src/sv/extract';
import { buildDesign } from '../../src/elab';
import { FileErrors, closestNames, collectIssues, connectionIssues, declaredModules, issueMarksFor, unusedOutputIssues } from '../../src/issues';
import { Module } from '../../src/model';
import { VERIBLE, designOf } from './helpers';

// A small design with one recoverable syntax error, one unreadable file, a duplicate and a missing module.
async function brokenDesign() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-issues-'));
  const w = (n: string, t: string) => { fs.writeFileSync(path.join(dir, n), t); return path.join(dir, n); };
  const files = [
    w('top.sv', 'module top(input logic a, output logic y);\n  mid u_mid (.a(a), .y(y));\n  vendor_cell u_cell ();\nendmodule\n'),
    w('mid.sv', 'module mid(input logic a, output logic y);\n  leaf u_leaf (.a(a), .y(y));\nendmodule\n'),
    w('leaf.sv', 'module leaf(input logic a, output logic y);\n  always_comb begin\n    y = a\n  end\nendmodule\n'),   // recoverable? see test
    w('core.sv', '// broken beyond recovery\nmodule core (input logic a;\n  assign = ;\nendmodule\n'),
    w('dup1.sv', 'module dup(); endmodule\n'),
    w('dup2.sv', 'module dup(); endmodule\n'),
    w('user.sv', 'module user(); core u_core (); dup u_dup (); endmodule\n'),
  ];
  const parsed = await parseFiles(VERIBLE, files);
  const mods: Module[] = [];
  const fe: FileErrors[] = [];
  for (const p of parsed) {
    const fm = extractModules(p);
    mods.push(...fm);
    if (p.errors.length) fe.push({ file: p.file, errors: p.errors, parsed: !!p.tree, modules: fm.map(m => m.name) });
  }
  const d = buildDesign(mods, files, [], 'test');
  return { dir, d, issues: collectIssues(d, fe, ['Bender: something odd'], [dir]) };
}

describe('source issues', () => {
  it('reads declared module names from text, ignoring comments and strings', () => {
    assert.deepStrictEqual(declaredModules('// module fake\n/* module nope */ module a #(); endmodule\nmodule automatic b (x); "module s"'), ['a', 'b']);
  });

  it('reports syntax errors with 1-based lines and the modules they affect', async () => {
    const { dir, issues } = await brokenDesign();
    const syn = issues.filter(i => i.kind === 'syntax');
    const leaf = syn.find(i => i.file?.endsWith('leaf.sv'))!;
    assert.ok(leaf, 'leaf.sv error reported');
    assert.strictEqual(leaf.line, 4);                     // the token after the missing semicolon
    const core = syn.find(i => i.file?.endsWith('core.sv'))!;
    assert.deepStrictEqual(core.modules, ['core']);       // from the text, since the file couldn't be parsed
    fs.rmSync(dir, { recursive: true });
  });

  it('lists only the first error of a file Verible could not recover from', () => {
    const d = buildDesign([], [], [], 'test');
    const errors = [0, 3, 5].map(line => ({ line, column: 2, text: 'x' }));
    const [one, ...rest] = collectIssues(d, [{ file: '/nowhere/bad.sv', errors, parsed: false, modules: [] }], []);
    assert.strictEqual(rest.length, 0);
    assert.strictEqual(one.line, 1);
    assert.match(one.detail!, /2 more errors after this one/);
    const recovered = collectIssues(d, [{ file: '/nowhere/ok.sv', errors, parsed: true, modules: ['m'] }], []);
    assert.strictEqual(recovered.length, 3);              // a recovered file keeps every error
  });

  it('explains a missing module by the broken file that declares it', async () => {
    const { dir, issues } = await brokenDesign();
    const core = issues.find(i => i.key === 'missing:core')!;
    assert.match(core.detail!, /declared in core\.sv, which has syntax errors\. Instantiated in user/);
    const vendor = issues.find(i => i.key === 'missing:vendor_cell')!;
    assert.match(vendor.detail!, /not in the files read/);
    assert.ok(issues.some(i => i.kind === 'duplicate' && i.modules[0] === 'dup' && i.title === 'module dup, 2 times'));
    assert.strictEqual(core.title, 'module core');
    assert.ok(issues.some(i => i.kind === 'sources' && i.title === 'Bender: something odd'));
    fs.rmSync(dir, { recursive: true });
  });

  it('marks affected blocks directly or as "inside", and hides checked issues', async () => {
    const { dir, d, issues } = await brokenDesign();
    const top = issueMarksFor(d, issues, new Set(), 'top');
    assert.deepStrictEqual(top.nodes['inst:u_cell'], { count: 1, inside: false, hatch: true });   // vendor_cell not found
    if (issues.some(i => i.modules.includes('leaf'))) assert.strictEqual(top.nodes['inst:u_mid']?.inside, true);
    const user = issueMarksFor(d, issues, new Set(), 'user');
    assert.strictEqual(user.nodes['inst:u_core'].inside, false);
    const checked = new Set(issues.filter(i => i.modules.includes('core')).map(i => i.key));
    assert.strictEqual(issueMarksFor(d, issues, checked, 'user').nodes['inst:u_core'], undefined);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('connection issues', () => {
  async function wired() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-conn-'));
    const w = (n: string, t: string) => { fs.writeFileSync(path.join(dir, n), t); return path.join(dir, n); };
    const files = [
      w('core.sv', 'module core(input logic clk, input logic rst_n, input logic en, output logic q);\nendmodule\n'),
      w('top.sv', [
        'module top(input logic clk_i, input logic rst_ni, input logic en, output logic q1, q2, q3, q4, q5);',
        '  core u_star (.*, .q(q1));',                                  // clk, rst_n: no such signals in top
        '  core u_named (.clk(clk_i), .rst_n(rst_ni), .en(en), .q(q2), .bogus(en));',
        '  core u_pos (clk_i, rst_ni, en, q3, en);',                     // one positional too many
        '  core u_short (.clk(clk_i), .q(q4));',                         // rst_n and en left out
        '  core u_open (.clk(clk_i), .rst_n(rst_ni), .en(), .q(q5));',   // explicit open: deliberate
        'endmodule', ''].join('\n')),
    ];
    const d = await designOf(files);
    return { dir, d, issues: connectionIssues(d) };
  }

  it('reports pins left unconnected without saying so, and nothing else', async () => {
    const { dir, issues } = await wired();
    const got = issues.map(i => `${i.inst!.key}.${i.inst!.port}`).sort();
    assert.deepStrictEqual(got, ['u_named.bogus', 'u_pos.#4', 'u_short.en', 'u_short.rst_n', 'u_star.clk', 'u_star.rst_n']);
    const star = issues.find(i => i.inst!.key === 'u_star' && i.inst!.port === 'clk')!;
    assert.match(star.detail!, /top has no signal named clk/);
    assert.strictEqual(star.line, 2);
    assert.match(issues.find(i => i.inst!.port === '#4')!.detail!, /has only 4 ports/);
    assert.match(issues.find(i => i.inst!.port === 'bogus')!.detail!, /no port named bogus/);
    fs.rmSync(dir, { recursive: true });
  });

  it('marks the instance and pin in the parent view without hatching it', async () => {
    const { dir, d, issues } = await wired();
    const m = issueMarksFor(d, issues, new Set(), 'top');
    assert.deepStrictEqual(m.nodes['inst:u_star'], { count: 2, inside: false, hatch: false });
    assert.ok(m.pins['inst:u_star/clk'].startsWith('Not connected: u_star.clk'));
    assert.strictEqual(m.module, 0);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('connection fixes', () => {
  it('finds near names: extended, trimmed or one edit away', () => {
    assert.deepStrictEqual(closestNames('clk', ['clk_x', 'rst_n', 'div']), ['clk_x']);
    assert.deepStrictEqual(closestNames('rst_n', ['clk_i', 'rst_ni', 'div']), ['rst_ni']);
    assert.deepStrictEqual(closestNames('paddr', ['paddr_i', 'pwdata_i']), ['paddr_i']);
    assert.deepStrictEqual(closestNames('load', ['clk', 'mode']), []);
  });

  it('pairs a connection to a missing port with the renamed port, both ways', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-fix-'));
    const w = (n: string, t: string) => { fs.writeFileSync(path.join(dir, n), t); return path.join(dir, n); };
    const d = await designOf([
      w('core.sv', 'module core(input logic clk_x, input logic rst_n, output logic q);\nendmodule\n'),
      w('top.sv', 'module top(input logic clk_i, input logic rst_ni, output logic q, q2);\n  core u_a (.clk(clk_i), .rst_n(rst_ni), .q(q));\n  core u_b (.*, .clk_x(clk_i));\nendmodule\n'),
    ]);
    const iss = connectionIssues(d);
    const phantom = iss.find(i => i.inst!.key === 'u_a' && i.inst!.port === 'clk')!;
    assert.match(phantom.detail!, /no port named clk.*input clk_x isn't connected: did you mean \.clk_x\(clk_i\)\?/);
    assert.match(iss.find(i => i.inst!.key === 'u_a' && i.inst!.port === 'clk_x')!.detail!, /did you mean \.clk_x\(clk_i\)\?/);
    assert.deepStrictEqual(phantom.related, { file: path.join(dir, 'core.sv'), line: 1, label: "core's ports" });
    // .* with near-named signals in the parent
    assert.match(iss.find(i => i.inst!.key === 'u_b' && i.inst!.port === 'rst_n')!.detail!, /Did you mean \.rst_n\(rst_ni\)\?/);
    assert.ok(!iss.some(i => i.inst!.key === 'u_b' && i.inst!.port === 'q'));     // top has a q: .* connects it
    fs.rmSync(dir, { recursive: true });
  });
});

describe('unused outputs', () => {
  async function unused() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-unused-'));
    const w = (n: string, t: string) => { fs.writeFileSync(path.join(dir, n), t); return path.join(dir, n); };
    const files = [
      w('leaf.sv', 'module leaf(input logic clk, input logic d, output logic q, output logic r);\n  assign q = d;\n  assign r = ~d;\nendmodule\n'),
      w('sink.sv', 'module sink(input logic a);\nendmodule\n'),
      w('top.sv', [
        'module top(input logic clk, input logic d, output logic out);',
        '  logic w_dead, w_assign, w_inst, w_index, w_assert, w_vendor, w_two, y;',
        '  logic [3:0] mem;',
        '  leaf u_dead   (.clk(clk), .d(d), .q(w_dead),   .r());',      // reported: nothing uses w_dead
        '  leaf u_assign (.clk(clk), .d(d), .q(w_assign), .r());',      // read by an assign
        '  leaf u_inst   (.clk(clk), .d(d), .q(w_inst),   .r());',      // feeds another instance
        '  sink u_sink   (.a(w_inst));',
        '  leaf u_index  (.clk(clk), .d(d), .q(w_index),  .r());',      // only used as an index
        '  leaf u_port   (.clk(clk), .d(d), .q(out),      .r());',      // straight to a module port
        '  leaf u_assert (.clk(clk), .d(d), .q(w_assert), .r());',      // only used in an assertion
        '  leaf u_vendor (.clk(clk), .d(d), .q(w_vendor), .r());',      // read by a module that is not in the sources
        '  vendor_cell u_v (.a(w_vendor));',
        '  leaf u_two    (.clk(clk), .d(d), .q(w_two),    .r(w_two));',   // both outputs on one dead wire',
        '  assign mem = {3\'b0, w_assign};',
        '  assign y = mem[w_index];',
        '  assert property (@(posedge clk) w_assert |-> d);',
        'endmodule', ''].join('\n')),
    ];
    const d = await designOf(files);
    return { dir, d, issues: unusedOutputIssues(d) };
  }

  it('reports an instance output wired to a wire nothing uses, and nothing that is used', async () => {
    const { dir, issues } = await unused();
    assert.deepStrictEqual(issues.map(i => `${i.inst!.key}.${i.inst!.port}`).sort(), ['u_dead.q', 'u_two.q', 'u_two.r']);
    const dead = issues.find(i => i.inst!.key === 'u_dead')!;
    assert.strictEqual(dead.kind, 'unused');
    assert.strictEqual(dead.line, 4);
    assert.match(dead.detail!, /w_dead is driven by u_dead\.q, but nothing in top uses it\. Use it, remove the wire, or write \.q\(\)/);
    fs.rmSync(dir, { recursive: true });
  });

  it('marks the pin on the instance and counts the block in the parent view', async () => {
    const { dir, d, issues } = await unused();
    const m = issueMarksFor(d, issues, new Set(), 'top');
    assert.ok(m.pins['inst:u_dead/q'].startsWith('Output not used: u_dead.q'));
    assert.deepStrictEqual(m.nodes['inst:u_dead'], { count: 1, inside: false, hatch: false });
    assert.strictEqual(m.nodes['inst:u_assign'], undefined);
    fs.rmSync(dir, { recursive: true });
  });
});
