import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseFiles } from '../../src/sv/verible';
import { extractModules } from '../../src/sv/extract';
import { buildDesign } from '../../src/elab';
import { FileErrors, collectIssues, declaredModules, issueMarksFor } from '../../src/issues';
import { Module } from '../../src/model';
import { VERIBLE } from './helpers';

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
    assert.deepStrictEqual(top.nodes['inst:u_cell'], { count: 1, inside: false });   // vendor_cell not found
    if (issues.some(i => i.modules.includes('leaf'))) assert.strictEqual(top.nodes['inst:u_mid']?.inside, true);
    const user = issueMarksFor(d, issues, new Set(), 'user');
    assert.strictEqual(user.nodes['inst:u_core'].inside, false);
    const checked = new Set(issues.filter(i => i.modules.includes('core')).map(i => i.key));
    assert.strictEqual(issueMarksFor(d, issues, checked, 'user').nodes['inst:u_core'], undefined);
    fs.rmSync(dir, { recursive: true });
  });
});
