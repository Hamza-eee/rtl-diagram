# Architecture

RTL Diagram has two halves: the **extension host** (Node.js, VS Code API) reads files and builds data, and the **webview** (a browser page inside VS Code) draws it. They talk only through JSON messages.

```
 project folder
   │  Bender.yml / *.f / glob            run.json + findings.sarif        .rtl-notes/*.json
   ▼                                     ▼                                ▼
 sources/discover ──► sv/verible ──► sv/extract ──► elab        findings/run        notes/notes
   (file list)        (syntax tree)   (modules)     (design)        │                    │
                                                      │      findings/resolve            │
                                                      │      (port, drivers)             │
                                                      ▼             ▼                    ▼
                                     store  ── design, runs, active run, resolutions, notes
                                       │
                 ┌─────────────────────┼──────────────────────────┐
                 ▼                     ▼                          ▼
         views/hierTree, runsTree   extension (diagnostics,    panel ──► graph (layout with ELK)
         (sidebar trees)            status bar, watchers)        │       findings/markers, notes marks
                                                                 ▼
                                                           webview/main  (SVG, drawer, input)
```

## Extension host

| File | Role |
|---|---|
| `extension.ts` | Activation: registers trees, commands, diagnostics, status bar and file watchers. |
| `store.ts` | State: project folder, parsed design, runs, active run and its resolved findings, notes. Rescans go through `util/serial.ts` so they never overlap. |
| `sources/discover.ts` | Picks the RTL file list: Bender, then filelists, then the include glob, minus exclusions. |
| `sources/bender.ts` | Reads `Bender.yml` without running bender: ordered sources, globs, path dependencies, target expressions. |
| `sources/filelist.ts` | Reads `.f` filelists. |
| `sv/verible.ts` | Runs `verible-verilog-syntax --export_json --printtree`, cached by file modification time. |
| `sv/extract.ts` | Walks the syntax tree: modules, ports, parameters, instances (with generate scopes and unique keys), drivers and reads. |
| `elab.ts` | Links modules into a design: resolves positional and `.*` connections, adds instance-output drivers, evaluates port widths, finds tops, resolves hierarchical paths. |
| `findings/run.ts` | Loads and checks a run directory (`run.json`, `findings.sarif`). |
| `findings/resolve.ts` | Maps a finding's signal names to the DUT module, instance path, port declaration and drivers. |
| `findings/markers.ts` | Decides where findings appear in a given view, by instance path. |
| `notes/notes.ts` | Note files, anchors, detached detection and where notes appear in a view. |
| `graph.ts` | Builds one module's view (ports, instances, logic block, nets, net labels) and lays it out with ELK. |
| `panel.ts` | The diagram panel: navigation state, messages to and from the webview, finding details, note actions. |
| `views/*.ts` | The Hierarchy and Verification runs trees. |

Everything except `extension.ts`, `store.ts`, `panel.ts` and `views/` is free of the VS Code API, which is what makes it unit-testable.

## Key decisions

- **Verible's syntax tree, not a regex or a home-grown parser.** It handles ANSI and non-ANSI headers, all connection forms and generate constructs, and gives exact source positions. The cost is an external binary.
- **No elaboration.** Parameters are evaluated from defaults for widths only; generate loops are drawn once. Full elaboration would need a real SystemVerilog front end (e.g. slang) and is on the roadmap.
- **Nets only if declared.** Avoids guessing whether an identifier is a signal, parameter or enum constant.
- **Instance keys.** Instance names can repeat across if/else generate branches, so each instance gets a key unique in its module (`u_x`, `u_x#2`). Keys are used for node ids, navigation paths and drivers. They depend on source order, so reordering same-named instances changes which one is `#2`; notes pinned to such an instance can then detach (they are listed as detached, never silently moved to another place).
- **Findings placed by instance path.** A finding on `tb.dut.u_tx.q` marks `u_tx` only. If the DUT appears more than once under the viewed top, placement falls back to module matching and the UI says so.
- **Layout in the host.** ELK runs in the extension host, so layout is testable and the webview only draws. Fixed port positions keep pins aligned with the drawn pitch; a fixed random seed keeps layout deterministic.
- **Notes as one file per note.** Shared through git without merge conflicts; anchored to a module, optionally to one instance path.

## Webview

`webview/main.ts` renders the view as SVG (edges, nodes, finding probes, note bubbles in separate layers) and the side drawer (Findings, Notes, Details) as HTML. It keeps only display state (transform, selection, open tab, note drafts) and asks the host for everything else. Styles are in `media/diagram.css`: *Auto* uses VS Code theme variables, *Light* and *Dark* are fixed palettes, and user colours from settings override both. The Content Security Policy allows only the bundled script (with a nonce) and the extension's stylesheet.

## Messages

| Webview → host | Purpose |
|---|---|
| `ready` | Webview loaded; host sends theme and view |
| `drill`, `goto`, `setTop` | Navigate |
| `open`, `openFile`, `reveal` | Open a source location or file |
| `showFinding`, `selectFinding` | Navigate to / show a finding |
| `addNote`, `updateNote`, `deleteNote`, `gotoNote` | Notes |
| `copy`, `runInTerminal`, `setTheme` | Utilities |

| Host → webview | Purpose |
|---|---|
| `view` | Laid-out graph, breadcrumbs, findings, markers, notes, optional selection |
| `detail` | Full finding card data |
| `theme` | Theme mode and colours |
| `empty` | Nothing to show (scanning, error, no modules) |
