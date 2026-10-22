# Changelog

All notable changes to this extension are listed here.

## 0.1.0 (beta)

First public version.

**Diagram**
- Block diagrams from SystemVerilog RTL using Verible:
  - ports with direction arrows, instances, the module's own logic, and nets with bus widths;
  - generate constructs, drawn with a stacked outline and a header;
  - clocks, resets and high fan-out nets drawn as labels.
- Logic written in a port connection (`.c(a & ~b)`) is drawn as one expression box feeding the pin.
- Pins:
  - open pins show `×`;
  - pins tied to 0 show a ground symbol, and pins tied to all ones a supply bar;
  - other constants show their value.
- Layout is deterministic and reorders blocks to reduce wire crossings. Spacing can be set to Compact, Normal or Roomy.
- Navigation:
  - double-click to open a block or go up;
  - breadcrumbs, zoom and pan, a minimap;
  - search, with `/` to jump to it;
  - hovering a block fades unrelated wires;
  - a shortcuts sheet (`?`).
- Live redraw on save, with a pause button and a list of the files changed while paused.
- Auto, Light and Dark themes, and colour settings.

**Checks**
- Source issues are marked on the affected blocks and listed as a session checklist:
  - syntax errors (for a file Verible can't read, only the first error);
  - duplicate modules;
  - missing modules, linked to the broken file that declares them when there is one;
  - problems with Bender manifests and filelists.
- *Not connected*, with the pin drawn in magenta and a suggested fix:
  - `.*` ports with no signal of the same name;
  - connections to ports the module doesn't have (drawn struck through);
  - extra positional connections;
  - inputs left out of the connection list.

**Projects and sources**
- RTL from Bender (ordered sources, path dependencies, target expressions), `.f` filelists, or all `.sv` / `.v` files.
- A folder holding several projects asks which one to open instead of mixing them. Any other folder can be opened with *Browse*.
- Sources can be chosen per project from the diagram (**Sources: …**). The choice is stored by the extension, never in the repository.

**Verification findings**
- Verification reports (`run.json` + SARIF 2.1.0 `findings.sarif`) are found in the project or opened from anywhere. Creating them automatically from test results is planned.
- Findings are placed on the exact instance and port, resolved through generate scopes and instance arrays.
- Each finding links to its port declaration and direct drivers. Findings are worded as observations, not diagnoses.
- Finding card: signal values, test, seed, requirement text, and a reproduce command typed (not run) into a terminal.
- Findings also appear as diagnostics in the Problems panel.
- A warning appears when the RTL has changed since the report's git commit.

**Notes**
- Notes, questions and issues on ports, wires and blocks, shared as one JSON file per note in `.rtl-notes/`.
- Note files are validated when read, and writes are confined to the notes folder.

**Robustness**
- No network access and no telemetry.
- If Verible is missing, a clear message offers to set its path.
- After an install, the diagram asks for a window reload until the new version is running.
