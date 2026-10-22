# Verification findings

[← Back to the README](../../README.md)

This guide shows how failed tests appear on the diagram. Everything here works from a **verification report**, so that is explained first.

> **Beta.** The extension reads verification reports in one documented format. The script that creates reports automatically from cocotb, AVL, Verilator or SystemVerilog/UVM test results is **planned, not built yet** ([roadmap](../ROADMAP.md#reporting)). Until then, reports are written by hand, by your own script or by an AI agent following the [format](../run-format.md).

## What a verification report is

When you test a design (a *regression*: a set of tests, each run with one or more random *seeds*), some checks may fail. A verification report is a folder that records the outcome:

| File | Contains |
|---|---|
| `run.json` | when the tests ran, the git commit of the code that was tested, the design module under test, and the list of tests with pass or fail |
| `findings.sarif` | every failed check, in [SARIF](https://sarifweb.azurewebsites.net/), a standard JSON format for tool results |

Each failed check is called a **finding**. A finding says:
- which requirement was violated (a *rule*, for example `SOC-IRQ-001`) and how serious it is (error, warning or note);
- the signal where the problem was **observed**, for example the output port `irq_o`, plus related signals;
- what was expected and what was observed, with the signal values at that moment;
- the test, the random seed and the command that reproduces the failure.

A finding says where the problem was *seen*, not why it happened. The cause may be anywhere in the code that drives that signal.

## Opening a report

The **Verification reports** view lists every report folder in the project (by default any folder holding `reports/<name>/run.json`). **Open Report Folder…** opens one from anywhere on disk. Click a report to show its findings:

- **On the diagram.** Each port where a problem was observed gets a coloured tag with the rule ID, and every block above it shows a count. The statements that directly drive that signal (`assign` statements, `always` blocks and outputs of child instances) are marked with a dotted ring, as places to look first. They are candidates, not a diagnosis.
- **In the Findings tab.** Findings are grouped into *in this block*, *elsewhere in the design* and *not found in the RTL*, the last with the reason.
- **In the Problems panel**, on the port declaration.
- **Rules that passed** are listed as *checked, clean*.

Click a finding to open its card: the message, the signal values, the test and seed, the requirement text, links to the port declaration and to the code that drives the signal, and the reproduce command.

## Reproducing a failure

**Type in terminal** on a finding types its reproduce command into a new terminal, without running it, so you can read it and press Enter. Commands containing line breaks or control characters are refused; copy those instead.

## Does the report still match the RTL?

A report records the git commit it was made from. The extension compares that commit with your working files and says so in the report header:
- *RTL matches*;
- *changed since this report*, listing the RTL files that differ;
- or why it can't tell: the commit isn't in this repository, or the tests ran with uncommitted changes.

Findings in a changed file carry a warning on their card and in the Problems panel. Without git, file times are compared with the report's finish time.

## Writing reports

The format is in [run-format.md](../run-format.md). `test-fixtures/sample-soc/top/dv/soc_tb/reports/` has complete examples.
