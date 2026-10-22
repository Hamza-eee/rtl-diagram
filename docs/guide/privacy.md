# Offline, no telemetry

[← Back to the README](../../README.md)

RTL Diagram never connects to the network, and it collects nothing. Your RTL, runs and notes stay on your machine and in your repository.

## What it does on your machine

- **Reads** the project's RTL, `Bender.yml`, file lists, verification reports and notes.
- **Writes** only note files, inside the project's notes folder (`.rtl-notes/` by default), and only when you add, edit or delete a note.
- **Runs** these programs, all local:
  - `verible-verilog-syntax`, on your RTL files;
  - `git config user.name`, for the author of a note;
  - `git rev-parse`, `git cat-file`, `git diff --name-only` and `git ls-files`, to tell whether a verification report still matches the RTL.
- **Stores** its UI choices (project, sources, spacing, theme) in VS Code's per-workspace storage.

The diagram panel runs under a Content Security Policy of `default-src 'none'`. It can load only the extension's own script and stylesheet, and it can't fetch or send anything.

## Check it yourself

These checks run on the built extension. From a clone, run `npm install && npm run build` first. Alternatively, unzip the `.vsix` (it is a zip) and look in `extension/dist/`.

1. **The modules the code loads:**
   ```sh
   grep -oE "require\([\"'][a-z_:/.-]+[\"']\)" dist/extension.js | sort | uniq -c
   ```
   Expect only `buffer`, `child_process`, `fs`, `os`, `path`, `process` and `vscode`. There is no `http`, `https`, `net`, `tls` or `dns`.
2. **Network calls:**
   ```sh
   grep -cE "XMLHttpRequest|new WebSocket|fetch\(" dist/extension.js dist/webview.js
   ```
   Both counts are `0`.
3. **Opening links:** `grep -rn openExternal src` finds nothing. The extension never opens a browser.
4. **Watch it:** turn the network off and use the extension fully, or watch the extension host with a per-app firewall. VS Code itself connects for updates, the Marketplace and its own telemetry, controlled by its `telemetry.telemetryLevel` setting; that isn't this extension.

The only URLs in the bundle are XML namespace names (`http://www.w3.org/2000/svg` and the layout engine's schema names), which are labels and are never fetched.
