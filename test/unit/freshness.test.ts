import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitRunner, runFreshness } from '../../src/findings/freshness';

const git: GitRunner = (args, cwd) => new Promise(resolve =>
  execFile('git', args, { cwd, timeout: 10000 }, (err, out) => resolve({ ok: !err, out: String(out) })));

// A throwaway repository in the temp folder (never one of the user's).
async function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-fresh-')));
  const g = (...a: string[]) => git(['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], dir);
  await g('init', '-q');
  fs.mkdirSync(path.join(dir, 'rtl'));
  for (const f of ['a.sv', 'b.sv']) fs.writeFileSync(path.join(dir, 'rtl', f), `module ${f[0]}; endmodule\n`);
  fs.writeFileSync(path.join(dir, 'README'), 'x\n');
  await g('add', '.');
  await g('commit', '-q', '-m', 'init');
  const sha = (await git(['rev-parse', 'HEAD'], dir)).out.trim();
  return { dir, sha, files: ['a.sv', 'b.sv'].map(f => path.join(dir, 'rtl', f)), g };
}

describe('runFreshness', () => {
  it('reports "same" when the working tree matches the run commit', async () => {
    const r = await repo();
    const f = await runFreshness({ gitCommit: r.sha, dirty: false }, r.files, path.join(r.dir, 'rtl'), git);
    assert.strictEqual(f.state, 'same');
    assert.match(f.reason, /matches commit/);
    fs.rmSync(r.dir, { recursive: true });
  });

  it('lists RTL files edited since the run, ignoring non-RTL files', async () => {
    const r = await repo();
    fs.appendFileSync(r.files[1], '// edit\n');
    fs.appendFileSync(path.join(r.dir, 'README'), 'y\n');
    const f = await runFreshness({ gitCommit: r.sha, dirty: false }, r.files, r.dir, git);
    assert.strictEqual(f.state, 'changed');
    assert.deepStrictEqual(f.changed, [r.files[1]]);
    fs.rmSync(r.dir, { recursive: true });
  });

  it('counts later commits and new untracked RTL files', async () => {
    const r = await repo();
    fs.appendFileSync(r.files[0], '// later\n');
    await r.g('commit', '-q', '-am', 'later');
    const c = path.join(r.dir, 'rtl', 'c.sv');
    fs.writeFileSync(c, 'module c; endmodule\n');
    const f = await runFreshness({ gitCommit: r.sha }, [...r.files, c], r.dir, git);
    assert.strictEqual(f.state, 'changed');
    assert.deepStrictEqual(f.changed, [r.files[0], c].sort());
    fs.rmSync(r.dir, { recursive: true });
  });

  it('says it cannot tell when the run commit is unknown or the run was dirty', async () => {
    const r = await repo();
    const missing = await runFreshness({ gitCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }, r.files, r.dir, git);
    assert.strictEqual(missing.state, 'unknown');
    assert.match(missing.reason, /not in this repository/);
    fs.appendFileSync(r.files[0], '// edit\n');
    const dirty = await runFreshness({ gitCommit: r.sha, dirty: true }, r.files, r.dir, git);
    assert.strictEqual(dirty.state, 'unknown');
    assert.match(dirty.reason, /uncommitted changes/);
    fs.rmSync(r.dir, { recursive: true });
  });

  it('falls back to file times outside git', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-fresh-nogit-'));
    const f1 = path.join(dir, 'x.sv');
    fs.writeFileSync(f1, 'module x; endmodule\n');
    const before = await runFreshness({ finishedAt: new Date(Date.now() + 60000).toISOString() }, [f1], dir, git);
    assert.deepStrictEqual([before.state, before.method], ['same', 'mtime']);
    const after = await runFreshness({ finishedAt: new Date(Date.now() - 60000).toISOString() }, [f1], dir, git);
    assert.deepStrictEqual([after.state, after.changed], ['changed', [f1]]);
    const none = await runFreshness({}, [f1], dir, git);
    assert.strictEqual(none.state, 'unknown');
    fs.rmSync(dir, { recursive: true });
  });
});
