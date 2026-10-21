// Runs the integration suite in a VS Code instance via @vscode/test-electron.
// Note: this downloads a VS Code build into .vscode-test/ on first run.
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
  const root = path.resolve(__dirname, '../..');
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'dist/test/integration/index.js'),
    launchArgs: [path.join(root, 'test-fixtures/sample-soc'), '--disable-extensions'],
  });
}
main().catch(e => { console.error(e); process.exit(1); });
