# Roadmap

Planned work, roughly in priority order within each section. **Nothing on this page is built yet**: everything that is available is in the [changelog](../CHANGELOG.md).

## Reporting

- **Report helper (`rtl_report`, shipped with the extension).** A dependency-free Python package so any testbench (cocotb, AVL, Verilator) can produce verification reports in [the report format](verification-report-format.md) without an agent:
  - a one-line call for checkers, e.g. `report.finding("RULE-ID", port="sig", msg=..., signals=...)`;
  - `finalize`: reads the cocotb JUnit results and writes the whole run directory (`run.json`, `findings.sarif` with every rule, `summary.md`, fingerprints, totals, status);
  - `check <run_dir>`: validates a run against the format, for scripts, agents and humans;
  - a machine-readable rules list (a fixed-column verification-plan table or `rules.yaml`) as its input;
  - an extension command, "Add report helper to this project", that copies the package into the workspace.
- **Instructions for AI agents** (for example Claude Code): ready-made agent definitions and prompts you copy into your project, so an agent can run your tests and write a verification report in the right format. This is the groundwork for letting a designer see how far agent-driven verification can go before handing the design to a verification specialist.
- **Adapter for pure SystemVerilog / UVM testbenches**, emitting the same format (DPI-C helper or a log-based converter).
- **JSON Schemas** for `run.json` and `findings.sarif`, registered through `jsonValidation`, so hand-edited files are checked while typing.

## Diagram and navigation

- Report diff: compare two verification reports by fingerprint and show new, fixed and still-open findings.
- Bug log view: read `bugs.md`, show bug IDs and status on badges.
- Waveform jump: open a finding's waveform in Surfer or GTKWave at its time window with the flagged signals added.
- Cross-hierarchy trace: follow a flagged port up and down through instances to every driver and load.
- Bus bundling: group ports by prefix or interface into one bus edge, expandable; full interface/modport support.
- Parameter and generate elaboration: evaluate parameters per instance and expand generate loops into real instances.
- Design-document ↔ RTL check: compare a design document's interface table with the module header.
- Export the current view as SVG, PNG or draw.io.
- Editor integration: "Show in diagram" CodeLens on `module` lines, finding and note counts in the gutter.
- Requirement coverage: colour modules and channels by how many rules cover them and their state.
- FSM view.
- Avoid overlaps between finding tags and neighbouring pin labels when blocks are close together.
- Drag blocks by hand, with wires re-routed around them, and remember the arrangement per module.

## From the code review (remaining suggestions)

- Performance: cache view graphs and send only markers when the active run changes; run ELK off the extension-host thread for large modules; re-discover sources only on create/delete or manifest changes; react to `rtlDiagram.colors.*` by re-theming only; cache extracted modules instead of whole Verible trees; add a timeout to Verible; build an edge-id map in the webview instead of repeated searches; load inactive runs lazily and lift the 500-run discovery cap.
- Security: refuse SARIF/run paths that resolve outside the repository root and decode SARIF URIs properly; escape untrusted text in tree tooltips; drop `'unsafe-inline'` styles.
- Correctness: follow symlinked directories in globs (with a loop guard); `-f` filelist semantics and flags that take an argument; replace the repository-root fallback guess with the containing workspace folder; catch errors in webview message handling; ignore a finding detail that arrives after the user picked another finding.
- Maintainability: shared message/marker types between host and webview; split `src/webview/main.ts`; tests for the panel and webview; run the integration suite in CI.
- Platforms: test on Linux and Windows.
