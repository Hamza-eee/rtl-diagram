# Reading and navigating the diagram

[← Back to the README](../../README.md)

Each module is drawn with its own ports on the edges, its child instances as blocks, its own `assign` / `always` code as one dashed block, and the nets between them. Everything comes from the RTL's syntax tree: a wire is drawn only between signals the module declares, never because two names look alike.

## Moving around

| To | Do |
|---|---|
| Open a block | Double-click it, or select it and press Enter |
| Go up one level | Double-click empty space, press Backspace, or click a breadcrumb |
| Pan, zoom | Drag empty space; mouse wheel or pinch, `+` / `-`; `0` for 100%; `F` to fit |
| Find a block or port | Type in the search box (`/` jumps to it); Enter goes to the match |
| Trace a net | Click a pin, wire or net label: every pin on that net is highlighted |
| See one block's connections | Hover it: wires that don't touch it fade out |
| See a block's parameters and source | Click it; the **Details** tab has *Go to instance* and *Go to definition* |
| See every shortcut | The `?` button in the toolbar, the `?` key, or *Shortcuts (?)* in the bottom bar |

The view position is remembered for each module, so going back to a block puts you where you were.

## Toolbar

- **Spacing** cycles Compact, Normal and Roomy. Roomy separates parallel wires best; Compact fits more on screen.
- **Live** redraws the diagram each time you save an RTL file (about a tenth of a second on a 30-module design). Click it to pause: the diagram stays as drawn and a banner lists the files saved since, with *Refresh*.
- **Theme** cycles Auto (follows VS Code), Light and Dark.
- The first breadcrumb is the project: see [Projects and sources](projects-and-sources.md).

## What the symbols mean

| You see | It means |
|---|---|
| Arrow-shaped terminals | the module's own ports: inputs on the left pointing in, outputs on the right pointing out, inouts double-headed |
| Arrowhead on a pin stub | the direction of an instance pin |
| Block with a notch | a child instance, with its module name under the instance name |
| Dashed rounded block | the module's own `assign` / `always` code |
| Stacked outline and a header above a block | the instance is inside a `generate` construct |
| Wire thickness, slash with a number | 1 bit, 2–8 bits, more than 8 bits; the bus width |
| Dashed box with an expression, e.g. `evt_s & ~evt_q` | logic written in a port connection: the signals it uses go in, one wire goes to the pin. Plain names and part-selects (`count[0][7:0]`) stay direct wires |
| `×` at a pin | the pin is left open |
| Ground symbol (three shrinking bars) | the pin is tied to 0 (`1'b0`, `'0`, `{N{1'b0}}`, …) |
| Bar on a short lead (T) | the pin is tied to all ones (`1'b1`, `'1`, `8'hFF`, …) |
| A value at a pin | the pin is tied to another constant |
| Small rounded tag at a pin | a clock, reset or high fan-out net drawn as a label instead of a wire |
| Magenta pin | the pin ends up unconnected although the code doesn't say so; hover for why ([Checks](checks.md)) |
| Struck-through pin name | the connection names a port the module doesn't have |
| Magenta hatching and a `</>` badge | a source issue affects the block, so it may be drawn incomplete; an outlined badge means the issue is further down ([Checks](checks.md)) |
| Coloured tag with a rule ID | where a failed check (a finding) was observed ([Findings](findings.md)) |
| Count badge on a block | findings on that block or somewhere inside it |
| Speech bubble | one or more [notes](notes.md) |

Names are used only for display choices (which nets become labels, pin colours), never for connectivity.
