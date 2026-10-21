import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Note, anchorLabel, detachedReason, loadNotes, newNoteId, noteMarksFor, writeNote } from '../../src/notes/notes';
import { designOf, FIX } from './helpers';

const HIER = path.join(FIX, 'sv/hier.sv');
let seq = 0;
function note(anchor: Note['anchor'], extra: Partial<Note> = {}): Note {
  return { schema: 1, id: `n${++seq}`, kind: 'note', text: 't', author: 'a', created: `2026-01-01T00:00:0${seq}Z`, resolved: false, anchor, ...extra };
}

describe('notes: storage', () => {
  it('writes one file per note and reads them back, skipping invalid files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-notes-'));
    const a = note({ module: 'leafh', target: { type: 'port', name: 'q' } }, { id: newNoteId(new Date('2026-01-15T10:00:00Z')) });
    const file = writeNote(dir, a);
    assert.match(path.basename(file), /^20260115T100000-[a-z0-9]{1,6}\.json$/);
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ nope');
    const r = loadNotes([dir, path.join(dir, 'missing')]);
    assert.deepStrictEqual(r.notes.map(n => n.id), [a.id]);
    assert.ok(!('file' in JSON.parse(fs.readFileSync(file, 'utf8'))), 'file path is not stored in the note');
    assert.strictEqual(r.issues.length, 1);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('notes: placement', () => {
  let d: Awaited<ReturnType<typeof designOf>>;
  before(async () => { d = await designOf([HIER]); });

  it('shows a module-wide port note on that module and on every instance pin of it', () => {
    const n = note({ module: 'leafh', target: { type: 'port', name: 'q' } });
    const top = noteMarksFor(d, [n], 'hier_top', []);
    assert.ok(top.marks['inst:u_tx/q'] && top.marks['inst:u_rx/q'] && top.marks['inst:u_x#2/q']);
    assert.deepStrictEqual(top.here, []);
    const inside = noteMarksFor(d, [n], 'hier_top', ['u_tx']);
    assert.deepStrictEqual(Object.keys(inside.marks), ['port:q/p']);
    assert.deepStrictEqual(inside.here, [n.id]);
  });

  it('limits an instance-only note to that instance', () => {
    const n = note({ module: 'leafh', target: { type: 'port', name: 'q' }, scope: { top: 'hier_top', instPath: ['u_tx'] } });
    assert.deepStrictEqual(Object.keys(noteMarksFor(d, [n], 'hier_top', []).marks), ['inst:u_tx/q']);
    assert.deepStrictEqual(noteMarksFor(d, [n], 'hier_top', ['u_rx']).marks, {});
    assert.deepStrictEqual(Object.keys(noteMarksFor(d, [n], 'hier_top', ['u_tx']).marks), ['port:q/p']);
  });

  it('places block, module and net notes', () => {
    const block = note({ module: 'leafh', target: { type: 'module' }, scope: { top: 'hier_top', instPath: ['u_rx'] } });
    const mod = note({ module: 'hier_top', target: { type: 'module' } });
    const net = note({ module: 'hier_top', target: { type: 'net', name: 'q' } }, { kind: 'issue' });
    const m = noteMarksFor(d, [block, mod, net], 'hier_top', []).marks;
    assert.deepStrictEqual(m['inst:u_rx'].ids, [block.id]);
    assert.deepStrictEqual(m.module.ids, [mod.id]);
    assert.strictEqual(m['net:q'].kind, 'issue');
  });

  it('reports the most urgent open kind and whether all are resolved', () => {
    const a = note({ module: 'hier_top', target: { type: 'module' } }, { kind: 'issue', resolved: true });
    const b = note({ module: 'hier_top', target: { type: 'module' } }, { kind: 'question' });
    const m = noteMarksFor(d, [a, b], 'hier_top', []).marks.module;
    assert.deepStrictEqual([m.kind, m.resolved, m.ids.length], ['question', false, 2]);
  });

  it('detects notes whose anchor no longer exists', () => {
    assert.strictEqual(detachedReason(d, note({ module: 'leafh', target: { type: 'port', name: 'q' } })), undefined);
    assert.match(detachedReason(d, note({ module: 'leafh', target: { type: 'port', name: 'zz' } }))!, /has no port zz/);
    assert.match(detachedReason(d, note({ module: 'gone', target: { type: 'module' } }))!, /not in the parsed RTL/);
    assert.match(detachedReason(d, note({ module: 'leafh', target: { type: 'module' }, scope: { top: 'hier_top', instPath: ['u_old'] } }))!, /no longer exists/);
    assert.strictEqual(anchorLabel(note({ module: 'leafh', target: { type: 'port', name: 'q' }, scope: { top: 'hier_top', instPath: ['u_tx'] } })), 'leafh.q · only hier_top.u_tx');
  });
});
