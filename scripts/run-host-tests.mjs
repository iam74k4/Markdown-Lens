import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve('.');
await build({ entryPoints: ['test/host.ts'], bundle: true, outfile: 'dist/test-host.js', external: ['vscode'], platform: 'node', format: 'cjs', target: 'node20' });
const targets = [
  ['vscode', '/Applications/Visual Studio Code.app/Contents/MacOS/Code'],
  ['cursor', '/Applications/Cursor.app/Contents/MacOS/Cursor'],
];
for (const [name, executable] of targets) {
  const base = join(root, 'test-results', name + '-' + Date.now());
  const workspace = join(base, 'workspace');
  await mkdir(workspace, { recursive: true });
  // macOS Unix-domain sockets require a short --user-data-dir path.
  const userData = resolve(root, '..', name + '-' + Date.now().toString(36));
  await mkdir(join(userData, 'User'), { recursive: true });
  await writeFile(join(userData, 'User', 'settings.json'), JSON.stringify({
    'chat.disableAIFeatures': true, 'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'workbench.startupEditor': 'none', 'window.restoreWindows': 'none',
    'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off',
    'update.mode': 'none', 'extensions.autoUpdate': false,
    'files.hotExit': 'off', 'window.newWindowDimensions': 'maximized'
  }));
  console.log(`Testing ${name} in an isolated profile: ${base}`);
  await runTests({
    vscodeExecutablePath: executable, extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'dist', 'test-host.js'),
    launchArgs: [workspace, '--user-data-dir=' + userData, '--extensions-dir=' + join(base, 'extensions'), '--disable-extensions', '--disable-telemetry'],
    extensionTestsEnv: { MARKDOWN_REVIEW_HOST: name, MARKDOWN_REVIEW_SKIP_FOCUS_TESTS: process.env.MARKDOWN_REVIEW_SKIP_FOCUS_TESTS ?? '' },
  });
}
