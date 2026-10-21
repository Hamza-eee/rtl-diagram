import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadBender } from '../../src/sources/bender';
import { loadFilelists } from '../../src/sources/filelist';
import { discoverSources } from '../../src/sources/discover';
import { globToRegExp } from '../../src/util/glob';
import { DEFAULT_EXCLUDE, PLAIN, SOC } from './helpers';

describe('glob', () => {
  it('matches ** and braces', () => {
    const r = globToRegExp('**/*.{sv,v}');
    assert.ok(r.test('a.sv') && r.test('x/y/a.v') && !r.test('a.svh'));
    assert.ok(globToRegExp('**/dv/**').test('src/pkg/dv/tb/x.sv'));
  });
});

describe('Bender reader', () => {
  it('follows path dependencies, dependencies first', () => {
    const b = loadBender([path.join(SOC, 'top')]);
    assert.deepStrictEqual(b.packages.map(p => p.name), ['common', 'timer', 'top']);
    assert.deepStrictEqual(b.issues, []);
  });

  it('keeps manifest order and expands globs', () => {
    const b = loadBender([path.join(SOC, 'top')]);
    assert.deepStrictEqual(b.files.map(f => `${f.pkg}:${path.basename(f.file)}`), [
      'common:soc_pkg.sv', 'common:sync_2ff.sv', 'common:fifo.sv',
      'timer:prescaler.sv', 'timer:timer_core.sv', 'timer:timer.sv',
      'top:regs.sv', 'top:soc_top.sv',
    ]);
  });

  it('loads each package once when several roots share dependencies', () => {
    const b = loadBender([path.join(SOC, 'top'), path.join(SOC, 'timer'), path.join(SOC, 'common')]);
    assert.strictEqual(b.packages.length, 3);
    assert.strictEqual(new Set(b.files.map(f => f.file)).size, b.files.length);
  });

  it('reports a missing dependency instead of failing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-bender-'));
    fs.writeFileSync(path.join(dir, 'Bender.yml'), 'package:\n  name: lonely\ndependencies:\n  ghost: { git: "https://example.invalid/ghost.git", version: 1.0.0 }\nsources: []\n');
    const b = loadBender([dir]);
    assert.strictEqual(b.packages[0].name, 'lonely');
    assert.match(b.issues[0], /dependency "ghost" is not a path dependency/);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('discoverSources', () => {
  const base = { mode: 'auto' as const, benderRoots: [], filelists: [], include: '**/*.{sv,v}', exclude: DEFAULT_EXCLUDE };

  it('prefers Bender when manifests exist and excludes testbenches', () => {
    const s = discoverSources({ ...base, roots: [SOC] });
    assert.strictEqual(s.mode, 'bender');
    assert.match(s.label, /^Bender · 3 packages · 8 files$/);
    assert.ok(s.files.every(f => !f.file.includes(`${path.sep}dv${path.sep}`)));
  });

  it('falls back to the include glob without Bender.yml', () => {
    const s = discoverSources({ ...base, roots: [PLAIN] });
    assert.strictEqual(s.mode, 'glob');
    assert.deepStrictEqual(s.files.map(f => path.basename(f.file)).sort(), ['blinky.sv', 'counter.v', 'edge_detect.sv']);
  });

  it('uses filelists when configured', () => {
    const s = discoverSources({ ...base, roots: [PLAIN], mode: 'filelist', filelists: [path.join(PLAIN, 'files.f')] });
    assert.strictEqual(s.mode, 'filelist');
    assert.deepStrictEqual(s.files.map(f => path.basename(f.file)), ['edge_detect.sv', 'counter.v', 'blinky.sv']);
  });

  it('reads filelists with -f nesting and +incdir+', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-fl-'));
    fs.writeFileSync(path.join(dir, 'a.sv'), 'module a; endmodule\n');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'b.sv'), 'module b; endmodule\n');
    fs.writeFileSync(path.join(dir, 'sub', 'inner.f'), 'b.sv\n');
    fs.writeFileSync(path.join(dir, 'top.f'), '// comment\n+incdir+inc\n-f sub/inner.f\na.sv\n+define+X=1\n');
    const r = loadFilelists([path.join(dir, 'top.f')]);
    assert.deepStrictEqual(r.files.map(f => path.relative(dir, f)), ['sub/b.sv', 'a.sv']);
    assert.deepStrictEqual(r.includeDirs, [path.join(dir, 'inc')]);
    fs.rmSync(dir, { recursive: true });
  });
});
