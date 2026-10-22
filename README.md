# RTL Diagram

**See your SystemVerilog as a block diagram, catch wiring mistakes before you simulate, and put verification failures on the ports they name.**

> **Beta.** The diagram, navigation and static checks are ready to use. Showing test failures on the diagram works from reports in one documented format. The script that creates those reports automatically from cocotb, AVL, Verilator or SystemVerilog/UVM test results is not built yet: it is on the [roadmap](docs/ROADMAP.md#reporting). Features that depend on it are marked **(planned)** below. Tested on macOS; feedback from Linux and Windows is welcome. [Report a problem](https://github.com/Hamza-eee/rtl-diagram/issues).

![soc_top: instances, buses, an expression feeding a FIFO, a pin tied to ground, and a verification finding on irq_o](docs/images/overview.png)

## What it is for

RTL Diagram is a VS Code extension. It reads your SystemVerilog and draws each module as a block diagram: its ports, the instances inside it, and the wires between them. It is built for three kinds of use.

| You are | You use it to | Status |
|---|---|---|
| **An RTL designer** | check your design statically before compiling or simulating (similar to linting, but on the diagram), and see which test failures point at which ports | static checks: available. Test failures on the diagram: needs a verification report; the script that creates one automatically is **(planned)** |
| **A verification engineer working with designers** | report a bug on the diagram instead of in a text log, with the command that reproduces the exact failure | reading reports: available. Creating them automatically: **(planned)** |
| **A designer exploring AI-driven verification** | find out how far an AI agent, for example Claude Code, can take verification before you hand the design to a verification specialist | **(planned)** |

### How test failures get onto the diagram

Static checks need nothing but your RTL. Showing test failures needs a **verification report**:

1. You run tests on your design: a regression with a testbench, written for example in cocotb, AVL, Verilator or SystemVerilog/UVM.
2. The test results are turned into a verification report, which is a folder with two JSON files. `run.json` says when the tests ran, on which git commit and for which design module. `findings.sarif` lists every failed check, in [SARIF](https://sarifweb.azurewebsites.net/), a standard format for tool results. Each failed check is called a **finding**. It names the signal where the problem was seen, and carries what was expected and observed, the test name, the random seed, the signal values and the command that reproduces the failure.
3. RTL Diagram reads the folder and marks every finding on the port it names.

**What exists today:** the extension reads this format, and the format is [documented](docs/run-format.md), with complete examples in [`test-fixtures/sample-soc`](https://github.com/Hamza-eee/rtl-diagram/tree/main/test-fixtures/sample-soc). Reports can be written by hand, by your own script, or by an AI agent following the format.
**What is planned:** a report script that creates the reports from cocotb, AVL, Verilator and SystemVerilog/UVM test results, and ready-made instructions for AI agents. See the [roadmap](docs/ROADMAP.md#reporting).

## For RTL designers

**Static checks, before you compile or simulate.**

- **Catch connection mistakes.** A `.*` that misses a port, a connection to a port that was renamed or doesn't exist, or an input left unconnected is marked on the pin, with a suggested fix such as *did you mean `.clk_x(clk_i)`?* → [Checks](docs/guide/checks.md#not-connected)
- **Find syntax errors in context.** A file that doesn't parse marks the blocks it affects, and the Issues tab lists each error with a link to its line. → [Checks](docs/guide/checks.md)
- **Explore unfamiliar designs**, such as third-party IP or a colleague's block. Open any block to see what is inside, trace a signal through the hierarchy, and jump to the source line that declares it. → [Reading and navigating the diagram](docs/guide/diagram.md)
- **The diagram updates live with the RTL.** It is redrawn each time you save an RTL file. You can turn live updates off with the toolbar's Live button to save computing power on large designs. → [Toolbar](docs/guide/diagram.md#toolbar)
- **Open your project files as they are.** Supported inputs are Bender packages, simulator file lists (`.f`) and plain folders of `.sv` / `.v` files. You choose per project, and nothing is written to your repository. → [Projects and sources](docs/guide/projects-and-sources.md)
- **See test failures on the diagram**, from a verification report as described above. Each failed check is marked on the port where it was observed, with links to the port's declaration and to the code that drives the signal. **(Report creation is planned.)** → [Verification findings](docs/guide/findings.md)

![u_timer connected with .*: the clk and rst_n pins marked as unconnected, with the suggested fix in the Issues tab](docs/images/checks.png)

## For verification engineers working with designers

**A visual way to report a bug or a design error.** You run a regression and find a bug. Instead of describing it in a text log, the failed check is shown on the design's diagram, on the port where the problem was observed, so the designer sees it in context.

- **Report a bug on the design itself.** Each finding is marked on its port, with the message, the signal values, the test and the requirement it violates. Blocks above it show a count, so the designer can find it from the top. → [Verification findings](docs/guide/findings.md)
- **Reproduce the exact failure.** Each finding carries the command that regenerates it (test name and random seed included). The extension types it into a terminal for you, without running it until you press Enter. → [Verification findings](docs/guide/findings.md)
- **Know whether a report is still valid.** A report records the git commit it was made from. If the RTL has changed since, the report and the affected findings are marked as possibly out of date. → [Does the report still match the RTL?](docs/guide/findings.md#does-the-report-still-match-the-rtl)
- **Discuss on the diagram.** Leave a note, a question or an issue on any port, wire or block. Notes are small files saved in the repository, so the whole team gets them through git, without merge conflicts. → [Notes](docs/guide/notes.md)
- **Use any testbench.** A report is plain JSON in a documented format, so cocotb, AVL, Verilator, SystemVerilog/UVM or your own scripts can all produce one. **(The script that creates reports from their results is planned.)** → [Report format](docs/run-format.md)

## For designers exploring AI-driven verification **(planned)**

You are an RTL designer and want to see how far an AI agent can drive verification before you involve a specialist. For example, Claude Code can run your tests and write the verification report, and RTL Diagram shows the result on the diagram.

What is planned: ready-made instructions for AI agents (agent definitions and prompts you copy into your project), so that an agent writes reports in the right format. Today, the report format is documented, so an agent can already be told to follow it. See the [roadmap](docs/ROADMAP.md#reporting).

## Limitations

- **Similar to linting, but not a linter.** The checks cover what stops the RTL from being parsed or connected, not coding-style or other lint rules. For those, use `verible-verilog-lint`, which comes with the Verible install this extension already needs.
- **No elaboration.** Parameters use their default values, and generate loops are drawn once instead of expanded.
- **Interfaces and modports** are drawn as plain ports, and state machines inside a module are not drawn.
- **Not a synthesis schematic.** It shows modules, instances and the wires between them, not gates.

The full list is in [Troubleshooting and limitations](docs/guide/troubleshooting.md#limitations).

Connectivity comes from [Verible](https://github.com/chipsalliance/verible)'s syntax tree, never from guessing by name, so the same RTL always gives the same diagram.

## Get started

1. **Install Verible**, the open-source SystemVerilog parser this extension uses, so that `verible-verilog-syntax` is on your `PATH`:
   - macOS: `brew install verible`;
   - Linux and Windows: download a [release](https://github.com/chipsalliance/verible/releases) and add its `bin` folder to your `PATH`, or set `rtlDiagram.veriblePath` to the full path.

   Check with `verible-verilog-syntax --version`. Tested with Verible v0.0-3946.
2. **Install the extension.** Download the `.vsix` file from the [releases page](https://github.com/Hamza-eee/rtl-diagram/releases), then in VS Code run **Extensions: Install from VSIX…** (VS Code 1.90 or later).
3. **Open a folder with your RTL**, click the **RTL Diagram** icon in the activity bar, and click a module in the **Hierarchy** list in the side bar (it shows each module and the blocks inside it).

Nothing else is needed: no simulator, no licence server, no Python. git is optional; it names note authors and tells whether a verification report still matches the RTL. Press `?` in the diagram for every shortcut.

## Offline by design

The extension never connects to the network and collects no telemetry. It reads your files, writes only note files, and runs only Verible and local git commands. [What it does, and how to check it yourself](docs/guide/privacy.md).

## Documentation

| Guide | |
|---|---|
| [Reading and navigating the diagram](docs/guide/diagram.md) | controls, toolbar, what each symbol means |
| [Checks](docs/guide/checks.md) | syntax errors, missing modules, unconnected pins, what isn't checked |
| [Projects and sources](docs/guide/projects-and-sources.md) | folders with several projects, Bender, file lists, choosing sources |
| [Verification findings](docs/guide/findings.md) | verification reports, findings on the diagram, reproducing a failure |
| [Notes](docs/guide/notes.md) | notes, questions and issues shared through git |
| [Settings and commands](docs/guide/settings.md) | every setting and command |
| [Offline, no telemetry](docs/guide/privacy.md) | what it reads, writes and runs |
| [Troubleshooting and limitations](docs/guide/troubleshooting.md) | common problems, known limits |
| [Report format](docs/run-format.md) | the verification report format, for writing your own |

For building from source and how it works inside, see [Development](docs/DEVELOPMENT.md), [Architecture](docs/ARCHITECTURE.md) and the [Roadmap](docs/ROADMAP.md). Changes are listed in the [changelog](CHANGELOG.md).

## Feedback

Bug reports and ideas are welcome as [GitHub issues](https://github.com/Hamza-eee/rtl-diagram/issues). Pull requests are not accepted.

## Licence and credits

Created by [Hamza-eee](https://github.com/Hamza-eee). Licensed under the [Apache License 2.0](LICENSE): you may use, change and share it, keeping the [NOTICE](NOTICE). If you build on it, please credit this project.

Built on [Verible](https://github.com/chipsalliance/verible) (CHIPS Alliance) for parsing, and the [Eclipse Layout Kernel](https://github.com/eclipse/elk) via [elkjs](https://github.com/kieler/elkjs) for layout. It reads the [Bender](https://github.com/pulp-platform/bender) package format, used by the PULP Platform. Third-party licences are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
