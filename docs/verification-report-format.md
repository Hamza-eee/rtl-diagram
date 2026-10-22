# Verification report format (1.x)

After you test a design, a **verification report** records the outcome: which tests ran, and which checks failed. The report is meant to be **generated automatically by a script** from the test results. Its format is **standardized**, so that the RTL Diagram extension can present any report that follows it, whichever testbench or tool produced the results.

This page describes that standard, for anyone writing a report generator: a script, an AI agent, or a person writing a report by hand. The extension reads one report folder at a time and shows each failed check, called a **finding**, on the port it names.

> **Status.** The extension reads this format today. The report script that creates it automatically from cocotb, AVL, Verilator and SystemVerilog/UVM results is **planned** ([roadmap](ROADMAP.md#reporting)). Until then, reports come from your own script, an AI agent, or by hand. (`run_id` below identifies one run of the tests.)

A report is one folder:

```
<anything>/reports/<run_id>/
├── run.json          required
└── findings.sarif    required: a report without it is shown as broken
```

Other files (summaries, JUnit XML, waveforms) may sit alongside and are linked when a finding references them. Paths inside both files are relative to the repository root. The root is the report folder minus the directory part of `run.json`'s `files.findings`.

## run.json

The fields the extension reads:

| Field | Used for |
|---|---|
| `schema_version` | must be `1.x`; anything else gets a warning |
| `run_id` | label, sort order (newest first) |
| `status` | `pass` / `fail` icon |
| `package`, `testbench` | labels |
| `dut_top` | the module name the findings refer to |
| `dut_instance` | hierarchical prefix stripped from signal names, e.g. `tb.dut` |
| `design_doc` | linked from the finding card |
| `tests`, `totals`, `simulator`, `git_commit`, `dirty` | shown in the run tooltip |
| `files.findings` | locating the repository root |

## findings.sarif

A SARIF 2.1.0 log with one run.

- `runs[0].tool.driver.rules[]`: one rule per requirement. `id`, `shortDescription.text` and `fullDescription.text` are read, plus `properties.spec_ref` (`{doc, section, page}` or `null`), `properties.design_ref` and `properties.channel`. Rules without results are listed as "checked, clean".
- `runs[0].results[]`: one per finding.
  - `ruleId`, `level` (`error` / `warning` / `note`), `message.text`.
  - `locations[0].logicalLocations[]`: the signals involved. Exactly one entry with `kind: "variable"` must have `properties.role: "primary"`; the others are `"context"`. `fullyQualifiedName` is `<dut_instance>.<port>`, or `<dut_instance>.<instance path>.<signal>` for signals below the top.
  - `relatedLocations[]`: where the testbench detected it (shown as links).
  - `partialFingerprints["verifFinding/v1"]`: stable ID, shown in the card.
  - `properties`: `test`, `seed`, `sim_time_ns`, `cycle`, `channel`, `signals` (values at the first occurrence), `occurrences`, `waveform` (`{file, start_ns, end_ns}`), `reproduce` (shell command run from the testbench directory, `reports/<run_id>/../..`), `classification`, `triage_status`, `bug_id`.

## How a finding is matched to the RTL

1. `dut_top` must be a module in the parsed sources. If it isn't, the finding is listed as "DUT not in the RTL".
2. The `dut_instance` prefix is removed from the primary signal's `fullyQualifiedName`. Any remaining dotted parts are an instance path walked from `dut_top`.
3. The last part, with any bit-select removed, must be a port or a declared net of the module reached. If it isn't, the finding is listed as unresolved with the reason.
4. The port's declaration and every statement driving it inside that module (continuous assigns, `always` blocks, outputs of child instances) become links.

See `test-fixtures/sample-soc/top/dv/soc_tb/reports/` for complete examples.
