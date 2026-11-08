import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve('.');
await build({ entryPoints: ['test/host.ts'], bundle: true, outfile: 'dist/test-host.js', external: ['vscode'], platform: 'node', format: 'cjs', target: 'node20' });
// macOS uses the installed apps; elsewhere (CI) a stable VS Code is downloaded.
const targets = process.platform === 'darwin' ? [
  ['vscode', '/Applications/Visual Studio Code.app/Contents/MacOS/Code'],
  ['cursor', '/Applications/Cursor.app/Contents/MacOS/Cursor'],
] : [['vscode', undefined]];
for (const [name, executable] of targets) {
  if (executable && !await access(executable).then(() => true, () => false)) { console.log(`Skipping ${name}: ${executable} is not installed`); continue; }
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
    'files.hotExit': 'off', 'window.newWindowDimensions': 'maximized',
    // Fixtures are written right before they are opened; the 0.14 checks enable this explicitly.
    'markdownLens.newFiles': 'reviewed',
  }));
  console.log(`Testing ${name} in an isolated profile: ${base}`);
  await runTests({
    ...(executable ? { vscodeExecutablePath: executable } : { version: process.env.VSCODE_TEST_VERSION ?? 'stable' }), extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'dist', 'test-host.js'),
    launchArgs: [workspace, '--user-data-dir=' + userData, '--extensions-dir=' + join(base, 'extensions'), '--disable-extensions', '--disable-telemetry'],
    extensionTestsEnv: { MARKDOWN_REVIEW_HOST: name, MARKDOWN_REVIEW_SKIP_FOCUS_TESTS: process.env.MARKDOWN_REVIEW_SKIP_FOCUS_TESTS ?? '', MARKDOWN_LENS_LOCALE: process.env.MARKDOWN_LENS_LOCALE ?? 'ja' },
  });
}
