# Checks: source issues and unconnected pins

[← Back to the README](../../README.md)

While it reads the RTL, the extension finds problems that would otherwise surface only at elaboration or in simulation. They are marked on the diagram, on the block or pin they affect, and listed in the **Issues** tab.

## What is reported

| Issue | What it means | On the diagram |
|---|---|---|
| **Syntax error** | Verible could not parse part of a file. The error is reported where Verible noticed it; the mistake is often just before, such as a missing `;` on the line above. If a file couldn't be read at all, only its first error is listed, because the ones after it are usually knock-on effects. | The block is hatched in magenta: it may be drawn incomplete |
| **Not found** | An instance of a module that isn't in the files read: a vendor primitive, a missing dependency, a file outside the sources, or a file whose syntax errors stopped Verible from reading it (the entry says which) | The block is dashed, marked *not in sources* |
| **Declared more than once** | Two files declare the same module. The first in source order is used, as a compiler would | Hatched block |
| **Not connected** | A pin that ends up connected to nothing although the code doesn't say so (below) | Magenta pin, `</>` badge on the block |
| **Sources** | An unreadable `Bender.yml`, a glob that matched nothing, a missing filelist entry | — |

### Not connected

Four cases are reported:

- **`.*` with no matching signal.** `.*` connects each port to the parent's signal of the same name. If the parent has no such signal, the port is left unconnected, and SystemVerilog rejects the design at elaboration. The message suggests a near-named signal if there is one: *did you mean `.rst_n(rst_ni)`?*
- **A connection to a port the module doesn't have**, such as `.clk(clk_i)` after the module's port was renamed to `clk_x`. The pin is drawn with its name struck through. If the module has an unconnected port with a close name, both issues suggest the fix: *did you mean `.clk_x(clk_i)`?*
- **Extra positional connections**, beyond the module's port count.
- **An input left out of the connection list.** It floats.

An explicit `.p()` is taken as deliberate and isn't reported. Each entry links to the instance line and to the module's port list.

## The Issues tab

Issues are a checklist: tick them off as you go. Ticks last until VS Code closes, and an issue that gets fixed disappears by itself after the next save.

## What isn't checked

This is a picture of the RTL as written, not a linter. A misspelt or undeclared signal name, a width mismatch or a missing reset are valid syntax and aren't reported. They do show on the diagram, as wires that aren't connected where you expect.

For lint checks, use **`verible-verilog-lint`**. It comes with the same Verible install the extension already needs.
