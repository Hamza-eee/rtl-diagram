import * as assert from 'assert';
import { Serial } from '../../src/util/serial';

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('Serial', () => {
  it('never overlaps passes and coalesces calls made during a pass into one more', async () => {
    const s = new Serial();
    let active = 0, maxActive = 0, passes = 0;
    const job = async () => { active++; maxActive = Math.max(maxActive, active); passes++; await tick(20); active--; };
    const p1 = s.run(job);
    await tick(5);
    const p2 = s.run(job), p3 = s.run(job), p4 = s.run(job);   // three calls while pass 1 runs
    await Promise.all([p1, p2, p3, p4]);
    assert.strictEqual(maxActive, 1);
    assert.strictEqual(passes, 2);   // the first pass, then one more for all three calls
  });

  it('settles every caller only after the latest pass', async () => {
    const s = new Serial();
    const seen: number[] = [];
    let n = 0;
    const job = async () => { const me = ++n; await tick(10); seen.push(me); };
    const p1 = s.run(job);
    await tick(2);
    await s.run(job);                 // resolves after pass 2, not pass 1
    assert.deepStrictEqual(seen, [1, 2]);
    await p1;
  });

  it('recovers after a failing pass', async () => {
    const s = new Serial();
    await assert.rejects(s.run(async () => { throw new Error('boom'); }), /boom/);
    let ran = false;
    await s.run(async () => { ran = true; });
    assert.ok(ran);
  });
});
