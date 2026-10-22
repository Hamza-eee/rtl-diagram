# Verification findings

[← Back to the README](../../README.md)

> **Beta.** Findings are read from one run format today: a `run.json` manifest plus a SARIF 2.1.0 `findings.sarif`. Helpers that write it from common testbenches are [on the roadmap](../ROADMAP.md#reporting).

## Loading a run

The **Verification runs** view lists every run folder in the project (by default `**/reports/*/run.json`), and **Open Run Folder…** loads one from anywhere on disk. Click a run to show its findings:

- **On the diagram.** Each port where the testbench observed a problem gets a probe tagged with the rule ID, and every block above it gets a count badge. The probe marks the symptom, not the cause. The statements that directly drive that signal are marked as candidates to inspect, with a dotted ring.
- **In the Findings tab.** Findings are grouped into *in this block*, *elsewhere* and *not found in the RTL*, the last with the reason.
- **In the Problems panel**, on the port declaration.
- **Clean rules.** Rules with no findings are listed as *checked, clean*.

Click a finding for its card: the message, signal values, test and seed, the requirement text, links to the port declaration and its drivers, and the reproduce command. **Type in terminal** types that command into a new terminal without running it. Commands containing line breaks or control characters are refused; copy those instead.

## Does the run still match the RTL?

A run records the git commit it was taken from. The extension compares that commit with your working tree and says so in the run header:
- *RTL matches*;
- *changed since this run*, listing the RTL files that differ;
- or why it can't tell: the commit isn't in this repository, or the run had uncommitted changes.

Findings in a changed file carry a warning on their card and in the Problems panel. Without git, file times are compared with the run's finish time.

## Writing runs

Runs are plain files, so any testbench, script or agent can write them. The format is in [run-format.md](../run-format.md). `test-fixtures/sample-soc/top/dv/soc_tb/reports/` has complete examples.
