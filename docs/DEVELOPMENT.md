# Building from source

How to build, run and test the extension locally.

## Setup

You need Node.js 20 or later, VS Code 1.90 or later, and Verible (`verible-verilog-syntax` on `PATH`; the unit tests parse real SystemVerilog with it).

```
npm install
npm run build        # bundles dist/extension.js, dist/webview.js and the tests
npm test             # unit tests (mocha)
npm run typecheck    # tsc, no output files
```

## Running the extension

- **From source:** open this folder in VS Code and press F5. *Run extension: sample SoC* opens `test-fixtures/sample-soc` (with example runs) in an Extension Development Host; *Run extension: choose a folder…* asks for any folder. Use `npm run watch` to rebuild on save, then reload the host window.
- **As an installed extension:** build a package and install it:

  ```
  npm run package
  code --install-extension rtl-diagram-0.1.0.vsix --force
  ```

  then run **Developer: Reload Window** in every open VS Code window. Until then VS Code keeps running the previous version (the diagram shows a banner saying so).

## Tests

- `test/unit/*.test.ts`: fast, no VS Code needed. They parse the fixtures with Verible and check extraction, Bender and filelist reading, run loading, finding resolution and placement, notes, layout determinism and the rescan scheduler.
- `test/integration/`: an end-to-end check inside VS Code (`npm run test:integration`). It downloads a separate VS Code build into `.vscode-test/` on first use, because tests can't run in a VS Code that is already open.
- Webview behaviour (clicks, double-clicks, menus) has no automated test yet. When changing it, check it in the Extension Development Host.

### Fixtures

Everything in `test-fixtures/` is original and safe to publish:

| Path | Purpose |
|---|---|
| `sample-soc/` | Three Bender packages (`common`, `timer`, `top`), a generate loop, typedef'd ports, open and tied pins, a testbench that must be excluded, and two example runs under `top/dv/soc_tb/reports/` |
| `plain-rtl/` | No Bender: glob and filelist (`files.f`) modes, a Verilog-2001 non-ANSI module |
| `sv/edge_cases.sv` | Header and connection forms: ANSI continuations, non-ANSI, positional, `.name`, `.*`, generate if/for, declaration assignments |
| `sv/hier.sv` | Hierarchical-name resolution: generate scopes, instance arrays, if/else branches with the same instance name, wrappers instantiating the DUT once and twice |

The example runs are generated: edit `scripts/make_fixture_runs.py` and run `python3 scripts/make_fixture_runs.py` instead of editing the JSON by hand.

Fixtures must stay original: no third-party or proprietary RTL.

## Principles

- **Deterministic.** Connectivity comes from the syntax tree only. A signal is a net only if the module declares it. Names may influence display (net labels, colours) but never what is connected to what. When something can't be resolved, show it as unresolved with the reason rather than guess.
- **Read-only on user repositories.** The extension never runs `bender`, never edits RTL, and writes only notes, in the notes folder.
- **Untrusted input.** Run files and notes are data from other people and tools: the webview builds DOM with `textContent` only, and commands from findings are never executed for the user.

## Layout

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together.
