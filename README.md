# RTL Diagram

**See your SystemVerilog as a block diagram, catch wiring mistakes before you simulate, and put verification failures on the ports they name.**

A VS Code extension for RTL designers and the verification engineers they work with. It draws the design hierarchy straight from the RTL and keeps it in step with your code as you save.

> **Beta.** The diagram, navigation and checks are ready to use. Verification findings are read from one run format today ([run.json + SARIF](docs/run-format.md)), and helpers for common testbenches are coming. Tested on macOS; feedback from Linux and Windows is welcome. [Report a problem](https://github.com/Hamza-eee/rtl-diagram/issues).

![soc_top: instances, buses, an expression feeding a FIFO, a pin tied to ground, and a verification finding on irq_o](docs/images/overview.png)

## For designers writing RTL

**See what you actually wrote, not what you meant to write.**

- **Catch wiring mistakes before you simulate.** A `.*` that misses a port, a connection to a port that was renamed, or an input left floating is marked on the pin, with the fix suggested: *did you mean `.clk_x(clk_i)`?* → [Checks](docs/guide/checks.md#not-connected)
- **Spot syntax errors where they hurt.** A file that doesn't parse marks the blocks it breaks, and the Issues tab tracks what's left to fix. → [Checks](docs/guide/checks.md)
- **Understand a design you didn't write.** Double-click into any block, follow a net end to end, and jump to the line that declares it. → [Reading and navigating](docs/guide/diagram.md)
- **Watch it change as you type.** It redraws on every save, in about a tenth of a second for a 30-module design. → [Toolbar](docs/guide/diagram.md#toolbar)
- **Read the connections at a glance.** Bus widths, open pins, pins tied to ground or supply, and logic written inside port connections are all drawn. → [What the symbols mean](docs/guide/diagram.md#what-the-symbols-mean)
- **Use your project as it is.** It reads Bender packages, `.f` filelists or plain folders of `.sv` / `.v` files, and lets you choose per project, without touching the repository. → [Projects and sources](docs/guide/projects-and-sources.md)

![u_timer with a .* connection: clk and rst_n marked as unconnected, with the suggested fix in the Issues tab](docs/images/checks.png)

## For design and verification teams

**One picture of the design, and of what failed in it.**

- **A failing test lands on the port it names.** Load a verification run, and each finding appears as a probe on the port where it was observed, with the statements that drive that signal one click away. → [Findings](docs/guide/findings.md)
- **Know whether a failure still applies.** If the RTL changed since the run's commit, the run header and the affected findings say so. → [Does the run still match?](docs/guide/findings.md#does-the-run-still-match-the-rtl)
- **Reproduce in one step.** Each finding carries its test, seed, signal values and reproduce command. → [Findings](docs/guide/findings.md)
- **Discuss on the diagram, not in a chat thread.** Leave a note, question or issue on any port, wire or block. Notes are small files in git, so the team sees them after a pull, without merge conflicts. → [Notes](docs/guide/notes.md)
- **Bring any testbench.** Runs are plain JSON and SARIF files that any testbench, script or agent can write. → [Run format](docs/run-format.md)

## What it is not

- **Not a linter.** It reports what stops the RTL from being read or connected, nothing more. For lint, use `verible-verilog-lint`, which comes with the Verible install this extension already needs.
- **Not an elaborator.** Parameters use their default values, and generate loops are drawn once rather than expanded.
- **Not a synthesis schematic.** It shows modules, instances and the nets between them, not gates.

It is **deterministic**: connectivity comes from [Verible](https://github.com/chipsalliance/verible)'s syntax tree, never from guessing by name, so the same RTL always gives the same diagram.

## Get started

1. **Install Verible**, so that `verible-verilog-syntax` is on your `PATH`:
   - macOS: `brew install verible`;
   - Linux and Windows: download a [release](https://github.com/chipsalliance/verible/releases) and add its `bin` folder to your `PATH`, or set `rtlDiagram.veriblePath` to the full path.

   Check with `verible-verilog-syntax --version`.
2. **Install the extension.** Download the `.vsix` from the [latest release](https://github.com/Hamza-eee/rtl-diagram/releases), then in VS Code run **Extensions: Install from VSIX…** (VS Code 1.90 or later).
3. **Open a folder with your RTL**, click the **RTL Diagram** icon in the activity bar, and click a module in **Hierarchy**.

Nothing else is needed: no simulator, no licence server, no Python. git is optional; it names note authors and tells whether a verification run still matches the RTL. Press `?` in the diagram for every shortcut.

## Offline by design

The extension never connects to the network and collects no telemetry. It reads your files, writes only note files, and runs only Verible and local git commands. [What it does, and how to check it yourself](docs/guide/privacy.md).

## Documentation

| Guide | |
|---|---|
| [Reading and navigating the diagram](docs/guide/diagram.md) | controls, toolbar, what each symbol means |
| [Checks](docs/guide/checks.md) | syntax errors, missing modules, unconnected pins, what isn't checked |
| [Projects and sources](docs/guide/projects-and-sources.md) | multi-repo folders, Bender, filelists, choosing sources |
| [Verification findings](docs/guide/findings.md) | runs, probes, the stale-run check, reproducing |
| [Notes](docs/guide/notes.md) | notes, questions and issues shared through git |
| [Settings and commands](docs/guide/settings.md) | every setting and command |
| [Offline, no telemetry](docs/guide/privacy.md) | what it reads, writes and runs |
| [Troubleshooting and limitations](docs/guide/troubleshooting.md) | common problems, known limits |
| [Run format](docs/run-format.md) | writing verification runs from your testbench |

For building from source and how it works inside, see [Development](docs/DEVELOPMENT.md), [Architecture](docs/ARCHITECTURE.md) and the [Roadmap](docs/ROADMAP.md). Changes are listed in the [changelog](CHANGELOG.md).

## Feedback

Bug reports and ideas are welcome as [GitHub issues](https://github.com/Hamza-eee/rtl-diagram/issues). Pull requests are not accepted.

## Licence and credits

Created by [Hamza-eee](https://github.com/Hamza-eee). Licensed under the [Apache License 2.0](LICENSE): you may use, change and share it, keeping the [NOTICE](NOTICE). If you build on it, please credit this project.

Built on [Verible](https://github.com/chipsalliance/verible) (CHIPS Alliance) for parsing, and the [Eclipse Layout Kernel](https://github.com/eclipse/elk) via [elkjs](https://github.com/kieler/elkjs) for layout. It reads the [Bender](https://github.com/pulp-platform/bender) package format. Third-party licences are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
