import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseFiles } from '../../src/sv/verible';
import { extractModules } from '../../src/sv/extract';
import { buildDesign } from '../../src/elab';
import { FileErrors, collectIssues, connectionIssues, declaredModules, issueMarksFor } from '../../src/issues';
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
