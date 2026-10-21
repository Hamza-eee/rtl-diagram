// Design model extracted from the Verible CST. Everything here is plain data
// (JSON-serialisable) so it can be posted to the webview unchanged.

export interface SrcLoc {
  file: string;       // absolute path
  line: number;       // 0-based
  col: number;        // 0-based
  endLine: number;
  endCol: number;
}

export type Direction = 'input' | 'output' | 'inout' | 'ref' | 'unknown';

export interface Param {
  name: string;
  value?: string;     // default value text
  local: boolean;     // localparam or body `parameter` (not overridable from the header)
  loc: SrcLoc;
}

export interface Port {
  name: string;
  dir: Direction;
  type: string;       // e.g. "logic", "wire", "" for implicit
  packed: string;     // e.g. "[DWIDTH-1:0]", "" for scalar
  unpacked: string;   // e.g. "[N_CH]", "" if none
  width?: number;     // evaluated packed width (bits) when the range is constant after param substitution
  loc: SrcLoc;
}

export interface Connection {
  port: string;          // formal port name on the child ("" if positional and unresolved)
  position?: number;     // positional index
  expr: string;          // actual expression text, "" if unconnected `.p()`
  signals: string[];     // identifiers referenced in expr, in order
  implicit?: boolean;    // `.name` or from `.*`
  loc: SrcLoc;
}

export interface Instance {
  name: string;          // as written, plus any instance-array range, e.g. "u_arr[1:0]"
  key: string;           // unique within the module: name, or name#2, name#3… for repeats (if/else generate branches)
  moduleName: string;
  params: { name: string; expr: string }[];
  connections: Connection[];
  wildcard: boolean;     // `.*` present
  generate?: string;     // e.g. "gen_channel: for (…)" when inside a generate construct
  genScopes: string[];   // enclosing generate block labels, outermost first ('' for an unlabelled block)
  loc: SrcLoc;
}

export type DriverKind = 'assign' | 'always_ff' | 'always_comb' | 'always_latch' | 'always' | 'initial' | 'instance';

export interface Driver {
  signal: string;        // base identifier on the LHS
  kind: DriverKind;
  text: string;          // one-line summary of the statement
  instance?: string;     // for kind === 'instance': key of the driving instance
  instPort?: string;     // ...and its port
  loc: SrcLoc;
}

export interface Module {
  name: string;
  file: string;
  pkg?: string;          // Bender package name (if known)
  params: Param[];
  ports: Port[];
  instances: Instance[];
  drivers: Driver[];     // assignments to any identifier inside this module (continuous + procedural)
  reads: string[];       // identifiers referenced by this module's own assign/always/initial code
  nets: string[];        // declared internal net/variable names
  loc: SrcLoc;           // whole declaration
  headerLoc: SrcLoc;     // `module name` keyword..name
}

export interface ParseIssue {
  file: string;
  message: string;
  line?: number;
}

export interface Design {
  modules: Record<string, Module>;
  duplicates: Record<string, string[]>;   // module name -> files declaring it (only when >1)
  issues: ParseIssue[];
  files: string[];
  sourceMode: string;    // human description, e.g. "Bender (3 pkgs)"
}
