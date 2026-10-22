# Troubleshooting and limitations

[← Back to the README](../../README.md)

## Troubleshooting

- **"Verible not found".** Install Verible, or set `rtlDiagram.veriblePath` to the full path of `verible-verilog-syntax`. The Hierarchy view and the diagram offer a button for it. Check with `verible-verilog-syntax --version`.
- **Buttons in the diagram don't respond after installing a new version**, or the diagram shows *RTL Diagram was updated*. VS Code keeps running the previous version until the window reloads: run **Developer: Reload Window**.
- **The wrong project is open.** Click the project name at the start of the breadcrumb and pick another.
- **A module or file is missing.** Check **Show Source Files**. Testbench folders are left out on purpose; change `rtlDiagram.exclude`, or `rtlDiagram.benderTargets` for Bender target groups. To pick sources by hand, click **Sources: …** at the bottom left.
- **A block is dashed with "not in sources".** The instantiated module isn't in the files read: often a vendor primitive, or a Bender git dependency that isn't checked out (run `bender checkout`).
- **A block is hatched, or a pin is magenta.** Open the **Issues** tab; see [Checks](checks.md).
- **A finding says "Not found in the RTL".** The card says why: the DUT module isn't parsed, an instance on its path doesn't exist, or the port name differs from the RTL.

## Limitations

- **Parameters** are evaluated from their defaults. Per-instance overrides don't change widths yet, and generate loops are drawn once with their header rather than expanded.
- **Interfaces and modports** are drawn as plain ports.
- **Bender:** only the targets in `rtlDiagram.benderTargets` are active. Targets that `bender` adds by itself for a given tool (for example `simulation` or `synthesis`) aren't added automatically, and target filters on dependencies aren't applied.
- **Repeated instance names:** when the same instance name appears in several `generate` branches, the instances are told apart by order (`u_x`, `u_x#2`). Reordering those branches can move a note pinned to one of them, or detach it.
- **State machines** inside a module are not drawn.
- **Tested** on macOS with VS Code 1.90+ and Verible v0.0-3946. Linux and Windows should work, since the extension uses only Node and VS Code APIs, but they haven't been tested yet.

See the [roadmap](../ROADMAP.md) for what's planned.
