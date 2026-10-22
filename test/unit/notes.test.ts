import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Note, anchorLabel, detachedReason, isAnchor, loadNotes, newNoteId, noteMarksFor, safeNotesFolder, writeNote } from '../../src/notes/notes';
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

describe('notes: untrusted files', () => {
  const valid = () => ({ schema: 1, id: '20260115T100000-abc123', kind: 'note', text: 't', author: 'a',
    created: '2026-01-15T10:00:00Z', resolved: false, anchor: { module: 'leafh', target: { type: 'port', name: 'q' } } });
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-notes-sec-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (name: string, x: unknown) => fs.writeFileSync(path.join(dir, name), typeof x === 'string' ? x : JSON.stringify(x));

  it('skips a note whose id is a path, and never writes outside the folder', () => {
    put('evil.json', { ...valid(), id: '../../.vscode/tasks' });
    const r = loadNotes([dir]);
    assert.deepStrictEqual(r.notes, []);
    assert.match(r.issues[0], /not a valid note/);
    assert.throws(() => writeNote(dir, { ...valid(), id: '../../.vscode/tasks' } as Note), /invalid id/);
    assert.throws(() => writeNote(dir, { ...valid(), id: '/etc/x' } as Note), /invalid id/);
    assert.ok(!fs.existsSync(path.join(dir, '..', '..', '.vscode', 'tasks.json')));
  });

  it('skips a note whose id does not match its file name', () => {
    put('20260115T100000-zzz.json', valid());
    const r = loadNotes([dir]);
    assert.deepStrictEqual(r.notes, []);
    assert.match(r.issues[0], /does not match its file name/);
  });

  it('skips malformed notes without hiding the valid ones', () => {
    put('20260115T100000-abc123.json', valid());
    put('20260115T100001-bad1.json', { ...valid(), id: '20260115T100001-bad1', created: 42 });
    put('20260115T100002-bad2.json', { ...valid(), id: '20260115T100002-bad2', anchor: { module: 'leafh', target: { type: 'module' }, scope: { top: 'x', instPath: 'u_a' } } });
    put('20260115T100003-bad3.json', { ...valid(), id: '20260115T100003-bad3', anchor: { module: 'a b', target: { type: 'module' } } });
    put('20260115T100004-bad4.json', '{ not json');
    const r = loadNotes([dir]);
    assert.deepStrictEqual(r.notes.map(n => n.id), ['20260115T100000-abc123']);
    assert.strictEqual(r.issues.length, 4);
  });

  it('validates anchors sent by the webview', () => {
    assert.ok(isAnchor({ module: 'fifo', target: { type: 'port', name: 'wdata' }, scope: { top: 'soc_top', instPath: ['u_evt_fifo'] } }));
    assert.ok(isAnchor({ module: 'leafh', target: { type: 'module' }, scope: { top: 'hier_top', instPath: ['u_arr[1:0]', 'u_x#2'] } }));
    assert.ok(!isAnchor({ module: '../x', target: { type: 'module' } }));
    assert.ok(!isAnchor({ module: 'fifo', target: { type: 'file', name: 'x' } }));
    assert.ok(!isAnchor({ module: 'fifo', target: { type: 'port', name: 'a/b' } }));
    assert.ok(!isAnchor({ module: 'fifo', target: { type: 'module' }, scope: { top: 'soc_top', instPath: ['../..'] } }));
  });

  it('keeps the notes folder setting inside the project', () => {
    assert.deepStrictEqual(safeNotesFolder('.rtl-notes'), { name: '.rtl-notes' });
    assert.deepStrictEqual(safeNotesFolder('docs/notes'), { name: path.normalize('docs/notes') });
    assert.strictEqual(safeNotesFolder('../../x').name, '.rtl-notes');
    assert.match(safeNotesFolder('/etc').issue!, /outside the project/);
    assert.strictEqual(safeNotesFolder('a/../../b').name, '.rtl-notes');
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
