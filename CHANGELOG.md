# Changelog

All notable changes to this extension are listed here.

## Unreleased

## 0.1.0

First version.

- Block diagrams from SystemVerilog RTL using Verible: ports with direction arrows, instances, the module's own logic, nets with bus widths, open and tied pins, generate constructs.
- Navigation: double-click to open a block or go up, breadcrumbs, zoom and pan, find, minimap, Auto / Light / Dark themes, colour settings.
- RTL from Bender (ordered sources, path dependencies, target expressions), filelists or a glob; a project folder for workspaces holding several projects.
- Clocks, resets and high fan-out nets drawn as labels.
- Verification runs (`run.json` + SARIF): findings placed on the exact instance and port, resolved through generate scopes and instance arrays, with links to declarations and drivers, a finding card and Problems-panel diagnostics.
- Notes, questions and issues on ports, wires and blocks, shared as files in `.rtl-notes/`.
