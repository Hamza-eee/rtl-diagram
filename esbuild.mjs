import * as esbuild from 'esbuild';
import { readdirSync } from 'fs';

const watch = process.argv.includes('--watch');
// One stamp per build, compiled into both bundles: the webview compares it with the host's to
// notice a window still running a previous version after an install (it needs a reload).
const BUILD = new Date().toISOString();
const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022', define: { __BUILD__: JSON.stringify(BUILD) } };
const tests = readdirSync('test/unit').filter(f => f.endsWith('.test.ts')).map(f => `test/unit/${f}`);
const integration = readdirSync('test/integration').filter(f => f.endsWith('.ts')).map(f => `test/integration/${f}`);

const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', external: ['vscode'] },
  { ...common, entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife' },
  { ...common, entryPoints: tests, outdir: 'dist/test/unit', platform: 'node', format: 'cjs', external: ['vscode', 'mocha'] },
  { ...common, entryPoints: [...integration, 'test/runIntegration.ts'], outdir: 'dist/test', outbase: 'test', platform: 'node', format: 'cjs', external: ['vscode', 'mocha', '@vscode/test-electron'] },
];

if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map(b => esbuild.build(b)));
}
