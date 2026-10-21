import * as path from 'path';
import { parseFiles } from '../../src/sv/verible';
import { extractModules } from '../../src/sv/extract';
import { buildDesign } from '../../src/elab';
import { Design, Module } from '../../src/model';

// dist/test/unit → repository root
export const REPO = path.resolve(__dirname, '../../..');
export const FIX = path.join(REPO, 'test-fixtures');
export const SOC = path.join(FIX, 'sample-soc');
export const PLAIN = path.join(FIX, 'plain-rtl');
export const DEFAULT_EXCLUDE = ['**/{tb,dv,test,tests,sim,.bender,node_modules,venv,.venv}/**', '**/*_tb.sv', '**/tb_*.sv', '**/*_tb.v', '**/tb_*.v'];
export const VERIBLE = process.env.VERIBLE ?? 'verible-verilog-syntax';

export async function designOf(files: string[], label = 'test'): Promise<Design> {
  const parsed = await parseFiles(VERIBLE, files);
  const mods: Module[] = [];
  for (const p of parsed) mods.push(...extractModules(p));
  return buildDesign(mods, files, [], label);
}
