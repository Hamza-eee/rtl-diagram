// Does the RTL on disk still match what a verification run was taken from?
// A run records its git commit (and whether the tree was dirty). Findings placed on newer code
// can point at lines the test never ran, so this is reported, never guessed.
// No VS Code API here: git is injected so this can be unit-tested.

import * as fs from 'fs';
import * as path from 'path';

export type GitRunner = (args: string[], cwd: string) => Promise<{ ok: boolean; out: string }>;

export interface Freshness {
  /** same: RTL matches the run's commit. changed: listed files differ. unknown: can't tell (see reason). */
  state: 'same' | 'changed' | 'unknown';
  changed: string[];            // absolute paths of design files that differ from the run's source
  reason: string;               // one sentence for the UI
  method: 'git' | 'mtime' | 'none';
}

export interface RunSource { gitCommit?: string; dirty?: boolean; finishedAt?: string }

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Compare `files` (the parsed RTL, absolute paths) with the run's source.
 * `anchorDir` is any folder inside the repository (e.g. the DUT module's folder).
 */
export async function runFreshness(run: RunSource, files: string[], anchorDir: string, git: GitRunner): Promise<Freshness> {
  const mtimeCheck = (why: string): Freshness => {
    const t = run.finishedAt ? Date.parse(run.finishedAt) : NaN;
    if (Number.isNaN(t)) return { state: 'unknown', changed: [], reason: `${why}, and the run has no finish time to compare file times with.`, method: 'none' };
    const changed = files.filter(f => { try { return fs.statSync(f).mtimeMs > t; } catch { return false; } }).sort();
    return changed.length
      ? { state: 'changed', changed, reason: `${why}; ${changed.length} RTL file${changed.length === 1 ? ' was' : 's were'} modified after the run finished.`, method: 'mtime' }
      : { state: 'same', changed, reason: `${why}; no RTL file was modified after the run finished.`, method: 'mtime' };
  };

  const top = await git(['rev-parse', '--show-toplevel'], anchorDir);
  if (!top.ok) return mtimeCheck('Not a git repository');
  const root = top.out.trim();

  if (!run.gitCommit || !SHA_RE.test(run.gitCommit)) return mtimeCheck('The run records no git commit');
  const commit = run.gitCommit;
  const has = await git(['cat-file', '-e', `${commit}^{commit}`], root);
  if (!has.ok) {
    return { state: 'unknown', changed: [], method: 'git',
      reason: `The run's commit ${commit.slice(0, 10)} is not in this repository (it may come from another clone or branch).` };
  }

  // Working tree (including uncommitted edits) vs the run's commit, plus new untracked files.
  const diff = await git(['diff', '--name-only', '--no-renames', commit, '--'], root);
  const untracked = await git(['ls-files', '--others', '--exclude-standard'], root);
  if (!diff.ok) return { state: 'unknown', changed: [], method: 'git', reason: 'git diff failed, so the comparison could not be made.' };
  const touched = new Set([...diff.out.split('\n'), ...(untracked.ok ? untracked.out.split('\n') : [])]
    .map(l => l.trim()).filter(Boolean).map(rel => path.resolve(root, rel)));
  const changed = files.map(f => path.resolve(f)).filter(f => touched.has(f)).sort();
  const short = commit.slice(0, 10);

  if (run.dirty) {
    return { state: changed.length ? 'unknown' : 'same', changed, method: 'git',
      reason: changed.length
        ? `The run was taken from commit ${short} with uncommitted changes, so it can't be told whether the ${changed.length} RTL file${changed.length === 1 ? '' : 's'} differing from that commit match what was simulated.`
        : `RTL matches commit ${short} (the run also had uncommitted changes, which can't be checked).` };
  }
  return changed.length
    ? { state: 'changed', changed, method: 'git', reason: `${changed.length} RTL file${changed.length === 1 ? ' has' : 's have'} changed since commit ${short}, which the run was taken from.` }
    : { state: 'same', changed, method: 'git', reason: `RTL matches commit ${short}, which the run was taken from.` };
}
