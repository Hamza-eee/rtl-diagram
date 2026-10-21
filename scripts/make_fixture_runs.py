#!/usr/bin/env python3
"""Regenerate the example verification runs under test-fixtures/sample-soc.

These are invented results used by the tests and for trying the extension out.
Usage: python3 scripts/make_fixture_runs.py
"""
import hashlib
import json
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test-fixtures", "sample-soc")
REPORTS = "top/dv/soc_tb/reports"


def fingerprint(rule, signal, test):
    return hashlib.sha256(f"{rule}|{signal}|{test}".encode()).hexdigest()[:16]


def rule(rid, short, full, channel="global", spec=None, design_ref=None):
    props = {"spec_ref": spec, "channel": channel}
    if design_ref:
        props["design_ref"] = design_ref
    return {"id": rid, "shortDescription": {"text": short}, "fullDescription": {"text": full}, "properties": props}


def result(rid, level, msg, prim, ctx, test, seed, t_ns, cycle, signals, detector, classification="dut_bug", wave=None, occ=1):
    dut = "tb.dut"
    locs = [{"fullyQualifiedName": dut, "name": "dut", "kind": "module"},
            {"fullyQualifiedName": f"{dut}.{prim}", "name": prim.split(".")[-1], "kind": "variable", "properties": {"role": "primary"}}]
    locs += [{"fullyQualifiedName": f"{dut}.{c}", "name": c.split(".")[-1], "kind": "variable", "properties": {"role": "context"}} for c in ctx]
    props = {"test": test, "seed": seed, "sim_time_ns": t_ns, "cycle": cycle, "channel": "global", "signals": signals,
             "occurrences": occ, "reproduce": f"make sim SEED={seed} TEST={test}",
             "classification": classification, "triage_status": "open"}
    if wave:
        props["waveform"] = wave
    return {"ruleId": rid, "level": level, "message": {"text": msg},
            "locations": [{"logicalLocations": locs}],
            "relatedLocations": [{"id": 1, "physicalLocation": {"artifactLocation": {"uri": detector[0]}, "region": {"startLine": detector[1]}},
                                  "message": {"text": detector[2]}}],
            "partialFingerprints": {"verifFinding/v1": fingerprint(rid, prim.split(".")[-1], test)},
            "properties": props}


def write_run(run_id, meta, rules, results, tests):
    d = os.path.join(ROOT, REPORTS, run_id)
    rel = f"{REPORTS}/{run_id}"
    os.makedirs(os.path.join(d, "results"), exist_ok=True)
    n = lambda lvl: sum(r["level"] == lvl for r in results)
    seeds = sorted({t["seed"] for t in tests})
    passed = sum(t["status"] == "pass" for t in tests)
    run = {"schema_version": "1.0.0", "run_id": run_id, **meta, "seeds": seeds, "tests": tests,
           "totals": {"tests": len(tests), "passed": passed, "failed": len(tests) - passed,
                      "findings": {"error": n("error"), "warning": n("warning"), "note": n("note")}},
           "status": "pass" if passed == len(tests) and n("error") == 0 else "fail",
           "files": {"findings": f"{rel}/findings.sarif", "summary": f"{rel}/summary.md",
                     "junit": [f"{rel}/results/results_seed{s}.xml" for s in seeds],
                     "waves": sorted({r["properties"]["waveform"]["file"] for r in results if "waveform" in r["properties"]})}}
    sarif = {"$schema": "https://json.schemastore.org/sarif-2.1.0.json", "version": "2.1.0",
             "runs": [{"tool": {"driver": {"name": "example-verif", "version": "0.1.0", "rules": rules}}, "results": results}]}
    with open(os.path.join(d, "run.json"), "w") as f:
        json.dump(run, f, indent=2)
    with open(os.path.join(d, "findings.sarif"), "w") as f:
        json.dump(sarif, f, indent=2)
    lines = [f"# Run {run_id}", "", f"{run['status']}: {passed}/{len(tests)} tests passed.", "",
             "Example data for the RTL Diagram extension. Not a real simulation.", ""]
    lines += [f"- {r['ruleId']} ({r['level']}): {r['message']['text']}" for r in results]
    with open(os.path.join(d, "summary.md"), "w") as f:
        f.write("\n".join(lines) + "\n")
    for s in seeds:
        ts = [t for t in tests if t["seed"] == s]
        cases = "\n".join(f'  <testcase name="{t["name"]}" time="{t["duration_s"]}">'
                          + ('<failure message="see findings.sarif"/>' if t["status"] == "fail" else "") + "</testcase>" for t in ts)
        with open(os.path.join(d, "results", f"results_seed{s}.xml"), "w") as f:
            f.write(f'<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="soc_tb" tests="{len(ts)}">\n{cases}\n</testsuite></testsuites>\n')


META = {"started_at": "2026-01-15T10:00:00+00:00", "finished_at": "2026-01-15T10:03:10+00:00",
        "git_commit": "0" * 40, "dirty": False, "package": "top", "testbench": "soc_tb",
        "dut_top": "soc_top", "dut_instance": "tb.dut", "design_doc": "docs/soc_top.md",
        "verification_plan": "top/dv/verification-plan.md", "simulator": {"name": "verilator", "version": "5.036"}}

RULES = [
    rule("SOC-IRQ-001", "irq_o follows any enabled, expired timer",
         "irq_o must be high in the cycle after a timer expires while its IRQ_EN bit is set.", design_ref="docs/soc_top.md#interrupt"),
    rule("SOC-TMR-002", "A one-shot timer expires exactly once",
         "In MODE_ONESHOT, expired pulses once when the count reaches zero and never again until reloaded.", design_ref="docs/soc_top.md#timers"),
    rule("SOC-EVT-003", "Event counter output present",
         "The design document lists evt_count_o as the number of synchronised rising edges on ext_evt_i.", design_ref="docs/soc_top.md#events"),
    rule("SOC-APB-004", "PREADY is always high", "The register block has no wait states: PREADY is 1 in every access phase.",
         channel="global", spec={"doc": "AMBA APB", "section": "3.1", "page": "3-2"}),
]

FAIL_TESTS = [
    {"name": "test_irq_timer0", "seed": 7, "status": "fail", "duration_s": 1.8, "sim_time_ns": 8000, "transactions": 24},
    {"name": "test_oneshot", "seed": 7, "status": "pass", "duration_s": 1.2, "sim_time_ns": 6000, "transactions": 18},
    {"name": "test_event_counter", "seed": 3, "status": "pass", "duration_s": 0.6, "sim_time_ns": 2000, "transactions": 6},
    {"name": "test_apb_ready", "seed": 3, "status": "pass", "duration_s": 0.4, "sim_time_ns": 1000, "transactions": 12},
]
RESULTS = [
    result("SOC-IRQ-001", "error", "Expected irq_o=1 the cycle after timer 0 expired with IRQ_EN[0]=1; irq_o stayed 0 for 8 cycles.",
           "irq_o", ["paddr_i", "pwdata_i"], "test_irq_timer0", 7, 3410, 341,
           {"irq_o": "0", "paddr_i": "0x04", "pwdata_i": "0x00000001"}, ["top/dv/soc_tb/checkers/irq_checker.py", 64, "Detected by interrupt checker"],
           wave={"file": f"{REPORTS}/20260115-100000-0000001/waves/test_irq_timer0_seed7.fst", "start_ns": 3200, "end_ns": 3600}),
    result("SOC-TMR-002", "warning", "Timer 1 in MODE_ONESHOT pulsed expired twice, 3 cycles apart; may be intended if LOAD was rewritten.",
           "u_timer.expired", ["u_timer.div"], "test_oneshot", 7, 2950, 295,
           {"expired": "0x2", "div": "0x03"}, ["top/dv/soc_tb/checkers/timer_checker.py", 31, "Detected by timer scoreboard"],
           classification="spec_question", occ=2),
    result("SOC-EVT-003", "note", "evt_count_o could not be bound: the design document names it but the DUT has no such port.",
           "evt_count_o", [], "test_event_counter", 3, 0, 0, {"evt_count_o": "z"},
           ["top/dv/soc_tb/env.py", 12, "Detected while binding DUT signals"], classification="unknown"),
]

write_run("20260115-100000-0000001", META, RULES, RESULTS, FAIL_TESTS)
write_run("20260115-120000-0000002", {**META, "started_at": "2026-01-15T12:00:00+00:00", "finished_at": "2026-01-15T12:02:58+00:00",
                                      "git_commit": "0" * 39 + "2"}, RULES, [],
          [{**t, "status": "pass"} for t in FAIL_TESTS])
print("wrote runs under", os.path.relpath(os.path.join(ROOT, REPORTS)))
