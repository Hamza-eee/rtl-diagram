# RTL Diagram

A VS Code extension that draws block diagrams of SystemVerilog RTL and marks verification findings on the ports they name.

It's meant for design and verification engineers working on the same code. Designers get a navigable view of the module hierarchy. Verification engineers can point at a failing port without reading the RTL.

- **Block diagrams from module headers.** Each module is drawn with its ports, child instances and the nets between them. Double-click a block to open it, use the breadcrumbs to go back up, and zoom or pan freely.
- **Deterministic.** Parsing uses [Verible](https://github.com/chipsalliance/verible)'s syntax tree. The same RTL always gives the same diagram, and nothing is inferred from naming conventions.
- **Verification findings on the diagram.** A run folder (`run.json` + SARIF `findings.sarif`) is read, and each finding is drawn as a probe on the port it names. You can jump from a finding to the port's declaration and to each of its drivers. A finding that can't be matched to the RTL says why.
- **Works without findings.** With no run loaded, it's a plain design browser.

## Requirements

- VS Code 1.90 or later
- `verible-verilog-syntax` on your `PATH`, or set `rtlDiagram.veriblePath`. Install it with `brew install verible` on macOS, or get a binary from the [Verible releases](https://github.com/chipsalliance/verible/releases).

## Where the RTL comes from

In `auto` mode, the first of these that exists is used:

1. **Bender.** Every `Bender.yml` in the workspace is read directly: `sources` in order, globs expanded, and `path` dependencies followed. `bender` itself is never run, so nothing is written to your repository. Git dependencies resolve if they are already checked out under `.bender/`.
2. **Filelists** (`rtlDiagram.filelists`). Plain paths, `-f` nesting, `+incdir+`, `-v` and `-y` are supported.
3. **Include glob** (`rtlDiagram.include`, default `**/*.{sv,v}`).

Testbench folders (`tb/`, `dv/`, `test/`, `sim/`) are excluded by default through `rtlDiagram.exclude`. The status bar shows which mode is active.

## Using it

- Open the **RTL Diagram** view in the activity bar. **Hierarchy** lists the top modules and their instances. **Verification runs** lists the run folders it found.
- Click a module to open the diagram. In the diagram:
  - Double-click a block to open it. Double-click empty space, or press Backspace, to go up one level.
  - Click a pin or wire to trace the net. Click a block for its parameters and links to its instance and definition.
  - `F` fits the view, `+` and `-` zoom, and `/` finds a block or port.
- Click a run to show its findings. Each flagged port gets a probe tagged with the rule ID, and the blocks above it get a count badge. The side panel shows the full finding: message, signal values, test and seed, the reproduce command, the requirement text, and links to the declaration, the drivers, and the testbench line that detected it.
- Findings also appear in the Problems panel, on the port declaration.

### What is drawn

| Element | Meaning |
|---|---|
| Flag-shaped terminals | the module's own ports (inputs on the left, outputs on the right) |
| Block with a notch | a child instance; the module name is under the instance name |
| Dashed rounded block | the module's own `assign` / `always` logic |
| Stacked outline | the instance is inside a `generate` construct (the header is shown above it) |
| Wire thickness | 1 bit, 2–8 bits, more than 8 bits; buses carry a slash with their width |
| `×` at a pin | the port is left open |
| Rounded tag at a pin | a clock, reset or high fan-out net drawn as a named label instead of a wire (`rtlDiagram.netLabels.*`) |

A net is drawn only if the module declares it as a port, net or variable. Parameters, genvars and enum constants are never drawn as wires.

## Settings

| Setting | Default | |
|---|---|---|
| `rtlDiagram.veriblePath` | `verible-verilog-syntax` | parser binary |
| `rtlDiagram.sourceMode` | `auto` | `auto`, `bender`, `filelist`, `glob` |
| `rtlDiagram.benderRoots` | `[]` | restrict Bender discovery to these folders |
| `rtlDiagram.filelists` | `[]` | `.f` files to read |
| `rtlDiagram.include` / `exclude` | see above | globs |
| `rtlDiagram.runsGlob` | `**/reports/*/run.json` | where runs are found |
| `rtlDiagram.netLabels.pattern` | clocks and resets | regex for nets drawn as labels instead of wires |
| `rtlDiagram.netLabels.minLoads` | `6` | nets with at least this many loads are drawn as labels |
| `rtlDiagram.theme` | `auto` | `auto` follows VS Code; the toolbar button cycles Auto / Light / Dark |
| `rtlDiagram.colors.*` | theme | block, wire, error, warning, note colours, and `portGroups` (prefix → colour) |

## Verification run format

See [docs/run-format.md](docs/run-format.md).

## Development

```
npm install
npm test               # unit tests (needs verible-verilog-syntax)
npm run typecheck
npm run watch          # then F5: "Run extension: sample SoC"
npm run package        # builds a .vsix
```

`test-fixtures/sample-soc` is a small Bender-packaged design with two example runs. `test-fixtures/plain-rtl` has no Bender.yml and covers glob and filelist mode. `npm run test:integration` runs an end-to-end check in a separate VS Code that it downloads on first use.
