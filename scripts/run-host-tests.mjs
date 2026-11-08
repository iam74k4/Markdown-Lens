import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
const root = resolve('.');
await build({ entryPoints: ['test/host.ts'], bundle: true, outfile: 'dist/test-host.js', external: ['vscode'], platform: 'node', format: 'cjs', target: 'node20' });
// macOS uses the installed apps; elsewhere (CI) a stable VS Code is downloaded.
const targets = process.platform === 'darwin' ? [
  ['vscode', '/Applications/Visual Studio Code.app/Contents/MacOS/Code'],
  ['cursor', '/Applications/Cursor.app/Contents/MacOS/Cursor'],
] : [['vscode', undefined], ...(process.env.CURSOR_EXECUTABLE ? [['cursor', process.env.CURSOR_EXECUTABLE]] : [])];
const only = process.env.MARKDOWN_REVIEW_HOST_TARGETS?.split(',').map(t => t.trim()).filter(Boolean);
for (const [name, executable] of targets) {
  if (only && !only.includes(name)) continue;
  if (executable && !await access(executable).then(() => true, () => false)) { console.log(`Skipping ${name}: ${executable} is not installed`); continue; }
  const base = join(root, 'test-results', name + '-' + Date.now());
  const workspace = join(base, 'workspace');
  await mkdir(workspace, { recursive: true });
  // A real Git repository with one committed Markdown file, for the Git comparison checks.
  let git = '';
  try {
    await writeFile(join(workspace, 'Git比較.md'), '# Git\n\ncommitted text\n');
    await writeFile(join(workspace, 'Git初回.md'), '# First\n\ncommitted first\n');
    const run = (...args) => execFileSync('git', ['-C', workspace, '-c', 'user.name=Markdown Lens Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' });
    run('init', '-q'); run('add', 'Git比較.md', 'Git初回.md'); run('commit', '-q', '-m', 'fixture');
    git = '1';
  } catch (error) { console.log('Git is unavailable; Git checks will be reported as skipped: ' + String(error).split('\n')[0]); }
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
    launchArgs: [workspace, '--user-data-dir=' + userData, '--extensions-dir=' + join(base, 'extensions'), '--disable-extensions', '--disable-telemetry', ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])],
    extensionTestsEnv: { MARKDOWN_REVIEW_HOST: name, MARKDOWN_REVIEW_SKIP_FOCUS_TESTS: process.env.MARKDOWN_REVIEW_SKIP_FOCUS_TESTS ?? '', MARKDOWN_LENS_LOCALE: process.env.MARKDOWN_LENS_LOCALE ?? 'ja', MARKDOWN_REVIEW_GIT: git },
  });
  // Some editors exit with code 0 even when the test runner throws. Only a written
  // report proves that every check ran to the end.
  const report = JSON.parse(await readFile(join(workspace, 'results', 'host.json'), 'utf8').catch(() => { throw new Error(`${name}: the host checks did not finish (no results/host.json)`); }));
  console.log(`${name} ${report.version}: ${report.passed} host checks passed${report.skipped.length ? `, skipped: ${report.skipped.join('; ')}` : ''}`);
}
