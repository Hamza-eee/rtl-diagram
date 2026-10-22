# Changelog

All notable changes to this extension are listed here.

## Unreleased

- Warn when the RTL has changed since a verification run's commit, in the run header, on affected finding cards and in the Problems panel.
- Live toggle: pause redrawing on save; a banner lists changed files with Refresh.
- Findings are worded as observations ("Observed at", "Direct drivers … not a diagnosis").
- Note files are validated, and note writes are confined to the notes folder.
- Folders with several projects ask which one to open instead of mixing them; the project name at the start of the breadcrumb switches project and configures sources per project.
- Source issues (syntax errors, duplicate or missing modules, source problems) are marked on the affected blocks (magenta hatching and a `</>` badge) and listed as a session checklist. A file Verible can't read lists only its first error.
- The project menu lists the projects in the open folder and any folder opened with **Browse for a folder…** (which may be outside the workspace; it is watched for changes too). The "whole workspace" option is gone.
- The diagram says when the window still runs a previous version after an install, and needs a reload.
- The Spacing and Live buttons show their new state as soon as they are clicked.
- Layout: fewer wire crossings, a spacing setting (Compact / Normal / Roomy), and hovering a block fades unrelated wires.
- Clear setup requirements and an actionable message when Verible is missing.

## 0.1.0

First version.

- Block diagrams from SystemVerilog RTL using Verible: ports with direction arrows, instances, the module's own logic, nets with bus widths, open and tied pins, generate constructs.
- Navigation: double-click to open a block or go up, breadcrumbs, zoom and pan, find, minimap, Auto / Light / Dark themes, colour settings.
- RTL from Bender (ordered sources, path dependencies, target expressions), filelists or a glob; a project folder for workspaces holding several projects.
- Clocks, resets and high fan-out nets drawn as labels.
- Verification runs (`run.json` + SARIF): findings placed on the exact instance and port, resolved through generate scopes and instance arrays, with links to declarations and drivers, a finding card and Problems-panel diagnostics.
- Notes, questions and issues on ports, wires and blocks, shared as files in `.rtl-notes/`.
