# Projects and sources

[← Back to the README](../../README.md)

## Projects

A project is the folder that the RTL, verification reports and notes are read from.

- If the folder you opened is one project, it opens directly.
- If it holds several (for example a parent folder of many repositories), nothing is mixed: the diagram and the Hierarchy view ask which one to open.
- Switch at any time from the **project name**, the first segment of the diagram's breadcrumb. Its menu lists the projects in the open folder and **Browse for a folder…**, which opens any other folder on your machine as the project. Folders opened that way stay in the menu under *Other folders*. The status bar and the Hierarchy view title offer the same list.

## Where the RTL comes from

In the default `auto` mode, the first of these that exists is used:

1. **Bender** (a hardware package manager from the PULP Platform). Every `Bender.yml` is read directly: sources in order, globs expanded, `path` dependencies followed. Source groups with a `target:` are included only when the expression holds for `rtlDiagram.benderTargets`. The default is no active targets, which gives plain RTL: `test`, `simulation` and technology-specific groups are left out. `bender` itself is never run, so nothing is written to your repository. Git dependencies resolve if they are already checked out under `.bender/`.
2. **File lists** (`.f` files, as used by simulators), with `-f` nesting, `+incdir+`, `-v` and `-y`.
3. **All `.sv` and `.v` files** (`rtlDiagram.include`).

Testbench folders are left out by default (`rtlDiagram.exclude`). **RTL Diagram: Show Source Files** lists the files in use.

## Choosing sources for one project

Click **Sources: …** at the bottom left of the diagram. It shows what is used now, e.g. *Sources: Bender · 3 packages · 8 files*. You can then choose:

- **Automatic**, as above;
- **Bender only**;
- **Filelists…**: the file lists (`.f` files) found in the project are listed, so tick the ones to use, or browse for others;
- **Files matching a pattern…**;
- **Use the settings**: go back to the defaults in [Settings](settings.md).

The choice is saved by the extension, for that project, on your machine. Nothing is written to the repository. The same menu is in the project menu (*Configure sources…*) and in the status-bar list.
