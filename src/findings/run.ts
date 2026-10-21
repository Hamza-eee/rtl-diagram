// Loads a verification run directory (run.json + findings.sarif, report format 1.x).
// The format is described in docs/run-format.md.

import * as fs from 'fs';
import * as path from 'path';

export const SUPPORTED_MAJOR = 1;

export type Level = 'error' | 'warning' | 'note' | 'none';

export interface SpecRef { doc: string; section: string; page?: string }

export interface Rule {
  id: string;
  short: string;
  full: string;
  specRef: SpecRef | null;
  designRef?: string;
  channel?: string;
}

export interface LogicalLoc {
  fqn: string;
  name: string;
  kind: string;            // "module" | "variable" | …
  role?: 'primary' | 'context' | string;
}

export interface RelatedLoc {
  uri: string;             // repo-relative
  line?: number;           // 1-based (SARIF)
  message?: string;
}

export interface Finding {
  index: number;           // position in results[]
  ruleId: string;
  level: Level;
  message: string;
  logical: LogicalLoc[];
  physical?: RelatedLoc;   // never RTL by contract; e.g. a design-doc section
  related: RelatedLoc[];
  fingerprint: string;
  props: {
    test?: string; seed?: number; sim_time_ns?: number; cycle?: number; channel?: string;
    signals?: Record<string, string>; occurrences?: number;
    waveform?: { file: string; start_ns?: number; end_ns?: number };
    reproduce?: string; classification?: string; triage_status?: string; bug_id?: string;
    [k: string]: unknown;
  };
}

export interface TestEntry { name: string; seed: number; status: string; duration_s?: number; sim_time_ns?: number; transactions?: number }

export interface Run {
  dir: string;             // absolute run directory
  repoRoot: string;        // absolute; contract paths are relative to it
  runId: string;
  schemaVersion: string;
  status: 'pass' | 'fail' | string;
  pkg: string;
  testbench: string;
  dutTop: string;
  dutInstance: string;
  designDoc?: string;
  verificationPlan?: string;
  startedAt?: string;
  finishedAt?: string;
  gitCommit?: string;
  dirty?: boolean;
  simulator?: { name: string; version: string };
  seeds: number[];
  tests: TestEntry[];
  totals?: { tests: number; passed: number; failed: number; findings: { error: number; warning: number; note: number } };
  tool?: { name: string; version?: string };
  rules: Rule[];
  findings: Finding[];
  issues: string[];        // contract violations / load problems, shown to the user
  broken: boolean;         // findings.sarif missing → the run itself broke (contract §3.5)
}

function readJson(f: string): any {
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

/** The repository root is the run dir minus the repo-relative directory of files.findings. */
function inferRepoRoot(runDir: string, findingsRel?: string): string {
  if (findingsRel) {
    const relDir = path.posix.dirname(findingsRel.replace(/\\/g, '/'));
    const norm = runDir.replace(/\\/g, '/');
    if (norm.endsWith('/' + relDir)) return path.resolve(norm.slice(0, norm.length - relDir.length - 1));
  }
  // Fallback: nearest ancestor with .git
  let d = runDir;
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return path.resolve(runDir, '../../../../../..');
    d = up;
  }
}

export function loadRun(runDir: string): Run {
  const issues: string[] = [];
  let rj: any = {};
  try { rj = readJson(path.join(runDir, 'run.json')); }
  catch (e: any) { issues.push(`run.json could not be read: ${e.message}`); }

  const schemaVersion = String(rj.schema_version ?? '');
  const major = parseInt(schemaVersion.split('.')[0], 10);
  if (!schemaVersion) issues.push('run.json has no schema_version');
  else if (major !== SUPPORTED_MAJOR) issues.push(`schema_version ${schemaVersion} is not supported (this extension reads ${SUPPORTED_MAJOR}.x); results may be wrong`);

  for (const k of ['run_id', 'package', 'testbench', 'dut_top', 'dut_instance', 'status']) {
    if (rj[k] === undefined) issues.push(`run.json is missing required field "${k}"`);
  }
  const runId = rj.run_id ?? path.basename(runDir);
  if (rj.run_id && rj.run_id !== path.basename(runDir)) issues.push(`run_id "${rj.run_id}" differs from the directory name "${path.basename(runDir)}"`);

  const repoRoot = inferRepoRoot(runDir, rj.files?.findings);
  const run: Run = {
    dir: runDir, repoRoot, runId, schemaVersion,
    status: rj.status ?? 'unknown', pkg: rj.package ?? '', testbench: rj.testbench ?? '',
    dutTop: rj.dut_top ?? '', dutInstance: rj.dut_instance ?? '',
    designDoc: rj.design_doc, verificationPlan: rj.verification_plan,
    startedAt: rj.started_at, finishedAt: rj.finished_at, gitCommit: rj.git_commit, dirty: rj.dirty,
    simulator: rj.simulator, seeds: rj.seeds ?? [], tests: rj.tests ?? [], totals: rj.totals,
    rules: [], findings: [], issues, broken: false,
  };

  const sarifPath = path.join(runDir, 'findings.sarif');
  if (!fs.existsSync(sarifPath)) {
    run.broken = true;
    issues.push('findings.sarif is missing: per the contract, the run itself broke');
    return run;
  }
  let sarif: any;
  try { sarif = readJson(sarifPath); }
  catch (e: any) { run.broken = true; issues.push(`findings.sarif is not valid JSON: ${e.message}`); return run; }
  if (sarif.version !== '2.1.0') issues.push(`findings.sarif version is "${sarif.version}", expected "2.1.0"`);
  const r0 = sarif.runs?.[0];
  if (!r0) { issues.push('findings.sarif has no runs[0]'); return run; }
  if ((sarif.runs?.length ?? 0) > 1) issues.push('findings.sarif has more than one run; only runs[0] is read');

  const drv = r0.tool?.driver ?? {};
  run.tool = { name: drv.name, version: drv.version };
  run.rules = (drv.rules ?? []).map((r: any): Rule => ({
    id: r.id, short: r.shortDescription?.text ?? '', full: r.fullDescription?.text ?? '',
    specRef: r.properties?.spec_ref ?? null, designRef: r.properties?.design_ref, channel: r.properties?.channel,
  }));

  run.findings = (r0.results ?? []).map((r: any, index: number): Finding => {
    const loc0 = r.locations?.[0] ?? {};
    const logical: LogicalLoc[] = (loc0.logicalLocations ?? []).map((l: any) => ({
      fqn: l.fullyQualifiedName ?? l.name ?? '', name: l.name ?? '', kind: l.kind ?? '', role: l.properties?.role,
    }));
    const prim = logical.filter(l => l.kind === 'variable' && l.role === 'primary');
    if (prim.length !== 1) issues.push(`result ${index} (${r.ruleId}): expected exactly one primary variable, found ${prim.length}`);
    const pl = loc0.physicalLocation;
    return {
      index, ruleId: r.ruleId, level: (r.level ?? 'warning') as Level, message: r.message?.text ?? '', logical,
      physical: pl ? { uri: pl.artifactLocation?.uri, line: pl.region?.startLine } : undefined,
      related: (r.relatedLocations ?? []).map((x: any) => ({
        uri: x.physicalLocation?.artifactLocation?.uri, line: x.physicalLocation?.region?.startLine, message: x.message?.text,
      })).filter((x: RelatedLoc) => !!x.uri),
      fingerprint: r.partialFingerprints?.['verifFinding/v1'] ?? '',
      props: r.properties ?? {},
    };
  });
  for (const f of run.findings) {
    if (!run.rules.some(r => r.id === f.ruleId)) issues.push(`result ${f.index} uses rule "${f.ruleId}" which is not in tool.driver.rules`);
  }
  return run;
}

export function primaryOf(f: Finding): LogicalLoc | undefined {
  return f.logical.find(l => l.kind === 'variable' && l.role === 'primary') ?? f.logical.find(l => l.kind === 'variable');
}

export function repoPath(run: Run, rel: string): string {
  return path.resolve(run.repoRoot, rel);
}
