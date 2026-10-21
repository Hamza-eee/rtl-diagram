import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findProjects } from '../../src/util/projects';

describe('findProjects', () => {
  it('lists git repositories that contain RTL, not other repos or plain folders', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-proj-'));
    const mk = (rel: string, file?: string) => { fs.mkdirSync(path.join(root, rel), { recursive: true }); if (file) fs.writeFileSync(path.join(root, rel, file), ''); };
    mk('a/.git'); mk('a/rtl', 'top.sv');                 // repo with RTL
    mk('group/b/.git'); mk('group/b/src/pkg', 'Bender.yml'); // nested one level, Bender only
    mk('c/.git'); mk('c/src', 'main.py');                 // repo without RTL
    mk('d/rtl', 'x.sv');                                  // RTL but not a repo
    mk('a/sub/.git'); mk('a/sub', 'y.sv');                // repo inside a repo: belongs to a
    assert.deepStrictEqual(findProjects([root]).map(p => path.relative(root, p)), ['a', path.join('group', 'b')]);
    fs.rmSync(root, { recursive: true });
  });
});
