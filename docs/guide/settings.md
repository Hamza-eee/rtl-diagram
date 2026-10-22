# Settings and commands

[← Back to the README](../../README.md)

## Settings

| Setting | Default | Description |
|---|---|---|
| `rtlDiagram.projectFolder` | *(empty)* | Folder to read RTL, verification reports and notes from. Empty: the project chosen in the diagram's project menu, or the only project found. |
| `rtlDiagram.liveUpdate` | `true` | Redraw when RTL files are saved. Off: keep the diagram and list the changed files. The toolbar's Live button changes it per workspace. |
| `rtlDiagram.veriblePath` | `verible-verilog-syntax` | The Verible syntax tool: a command on your `PATH` or a full path. |
| `rtlDiagram.sourceMode` | `auto` | `auto`, `bender`, `filelist` or `glob`. See [Projects and sources](projects-and-sources.md). |
| `rtlDiagram.benderRoots` | `[]` | Only use these folders' `Bender.yml` as roots. |
| `rtlDiagram.benderTargets` | `[]` | Active Bender targets, e.g. `["synthesis", "xilinx"]`. |
| `rtlDiagram.filelists` | `[]` | `.f` filelists to read. |
| `rtlDiagram.include` | `**/*.{sv,v}` | Files read when there is no `Bender.yml` or filelist. |
| `rtlDiagram.exclude` | testbench folders and `*_tb` files | Globs never read as RTL. |
| `rtlDiagram.runsGlob` | `**/reports/*/run.json` | Where verification reports (folders holding `run.json`) are found. |
| `rtlDiagram.netLabels.pattern` | clocks and resets | Nets whose name matches are drawn as labels instead of wires. Empty disables. |
| `rtlDiagram.netLabels.minLoads` | `6` | Nets with at least this many loads are drawn as labels. `0` disables. |
| `rtlDiagram.layout.spacing` | `normal` | `compact`, `normal` or `roomy`. The toolbar button changes it per workspace. |
| `rtlDiagram.notesFolder` | `.rtl-notes` | Where notes are stored, inside the project folder. |
| `rtlDiagram.theme` | `auto` | `auto` follows VS Code; `light` or `dark` fixes the diagram theme. |
| `rtlDiagram.colors.block`, `.wire`, `.error`, `.warning`, `.note`, `.issue` | theme | CSS colours for blocks, wires, finding levels and source-issue marks. |
| `rtlDiagram.colors.portGroups` | `{}` | Pin colour per name prefix, e.g. `{ "s_axi_aw": "#1565C0" }`. The longest prefix wins. |

Choices made from the diagram (project, sources, spacing, live, theme) are stored by the extension for the workspace on your machine. They override these settings and are never written to the repository.

## Commands

All commands are in the Command Palette under **RTL Diagram**.

| Command | What it does |
|---|---|
| Open Diagram | Open the diagram panel. |
| Open Project… | Pick the project folder to read from. |
| Configure Sources… | Choose where this project's RTL comes from. |
| Choose Top Module… | Pick which top module the diagram starts from. |
| Open Report Folder… | Open a verification report folder from anywhere on disk. |
| Clear Active Report | Hide the findings. |
| Toggle Live Updates | Pause or resume redrawing on save. |
| Rescan Sources and Reports | Re-read everything. |
| Show Source Files | List the RTL files in use. |
