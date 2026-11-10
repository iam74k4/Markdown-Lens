import { runTests, downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath } from '@vscode/test-electron';
import { build } from 'esbuild';
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
const root = resolve('.');
await build({ entryPoints: ['test/host.ts'], bundle: true, outfile: 'dist/test-host.js', external: ['vscode'], platform: 'node', format: 'cjs', target: 'node20' });
// The same checks also run in a remote extension host (the remote must see this checkout):
// - MARKDOWN_REVIEW_REMOTE_AUTHORITY=ssh-remote+<host>: Remote - SSH. The remote host needs this
//   checkout at the same path and MARKDOWN_LENS_LOCALE / MARKDOWN_REVIEW_GIT in its own environment.
// - MARKDOWN_REVIEW_REMOTE=dev-container: Dev Containers (Docker), with this checkout mounted at the same path.
// - MARKDOWN_REVIEW_REMOTE=wsl and MARKDOWN_REVIEW_WSL_DISTRO=<name>: WSL on Windows, through /mnt/<drive>.
const remoteKind = process.env.MARKDOWN_REVIEW_REMOTE ?? (process.env.MARKDOWN_REVIEW_REMOTE_AUTHORITY ? 'ssh' : undefined);
const remoteExtension = { ssh: 'ms-vscode-remote.remote-ssh', 'dev-container': 'ms-vscode-remote.remote-containers', wsl: 'ms-vscode-remote.remote-wsl' }[remoteKind];
if (remoteKind && !remoteExtension) throw new Error(`Unknown MARKDOWN_REVIEW_REMOTE: ${remoteKind}`);
const remote = !!remoteKind;
const locale = process.env.MARKDOWN_LENS_LOCALE ?? 'ja';
// macOS uses the installed apps; elsewhere (CI) a stable VS Code is downloaded.
const targets = remote ? [['vscode-remote', undefined]] : process.platform === 'darwin' ? [
  ['vscode', '/Applications/Visual Studio Code.app/Contents/MacOS/Code'],
  ['cursor', '/Applications/Cursor.app/Contents/MacOS/Cursor'],
] : [['vscode', undefined], ...(process.env.CURSOR_EXECUTABLE ? [['cursor', process.env.CURSOR_EXECUTABLE]] : [])];
const only = process.env.MARKDOWN_REVIEW_HOST_TARGETS?.split(',').map(t => t.trim()).filter(Boolean);
for (const [name, configured] of targets) {
  if (only && !only.includes(name)) continue;
  if (configured && !await access(configured).then(() => true, () => false)) { console.log(`Skipping ${name}: ${configured} is not installed`); continue; }
  const base = join(root, 'test-results', name + '-' + Date.now());
  const workspace = join(base, 'workspace');
  const extensions = join(base, 'extensions');
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
  let executable = configured;
  let authority, remotePath = path => path;
  if (remote) {
    // The remote extension is the only one installed; the extension under test runs remotely.
    executable = await downloadAndUnzipVSCode(process.env.VSCODE_TEST_VERSION ?? 'stable');
    const cli = resolveCliPathFromVSCodeExecutablePath(executable);
    execFileSync(cli, ['--install-extension', remoteExtension, '--extensions-dir', extensions], { stdio: 'inherit', shell: process.platform === 'win32' });
    if (remoteKind === 'ssh') authority = process.env.MARKDOWN_REVIEW_REMOTE_AUTHORITY;
    if (remoteKind === 'dev-container') {
      // The container mounts this checkout at the same path and receives the test environment.
      await mkdir(join(workspace, '.devcontainer'), { recursive: true });
      await writeFile(join(workspace, '.devcontainer', 'devcontainer.json'), JSON.stringify({
        name: 'Markdown Lens host checks', image: process.env.MARKDOWN_REVIEW_DEV_CONTAINER_IMAGE ?? 'mcr.microsoft.com/devcontainers/javascript-node:22',
        workspaceMount: `source=${root},target=${root},type=bind`, workspaceFolder: workspace,
        remoteEnv: { MARKDOWN_LENS_LOCALE: locale, MARKDOWN_REVIEW_GIT: git },
      }, null, 2));
      authority = 'dev-container+' + Buffer.from(workspace).toString('hex');
    }
    if (remoteKind === 'wsl') {
      const distro = process.env.MARKDOWN_REVIEW_WSL_DISTRO;
      if (!distro) throw new Error('Set MARKDOWN_REVIEW_WSL_DISTRO to the WSL distribution name');
      authority = 'wsl+' + distro;
      remotePath = path => '/mnt/' + path[0].toLowerCase() + path.slice(2).replace(/\\/g, '/');
    }
  }
  // macOS Unix-domain sockets require a short --user-data-dir path.
  const userData = resolve(root, '..', name + '-' + Date.now().toString(36));
  await mkdir(join(userData, 'User'), { recursive: true });
  const host = remoteKind === 'ssh' ? authority.replace(/^ssh-remote\+/, '') : undefined;
  await writeFile(join(userData, 'User', 'settings.json'), JSON.stringify({
    'chat.disableAIFeatures': true, 'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'workbench.startupEditor': 'none', 'window.restoreWindows': 'none',
    'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off',
    'update.mode': 'none', 'extensions.autoUpdate': false,
    'files.hotExit': 'off', 'window.newWindowDimensions': 'maximized',
    // Fixtures are written right before they are opened; the 0.14 checks enable this explicitly.
    'markdownLens.newFiles': 'reviewed',
    ...(host ? { 'remote.SSH.remotePlatform': { [host]: 'linux' }, 'remote.SSH.connectTimeout': 120, 'remote.SSH.showLoginTerminal': true, 'remote.SSH.useLocalServer': false } : {}),
  }));
  console.log(`Testing ${name} in an isolated profile: ${base}`);
  const at = path => remote ? `vscode-remote://${authority}${encodeURI(remotePath(path))}` : path;
  // VS Code occasionally hangs while exiting after every check has finished. Once the report is
  // written, allow a minute for the exit, then stop that instance (found by its own profile path).
  const reportPath = join(workspace, 'results', 'host.json');
  let stoppedAfterReport = false, grace;
  const watchdog = setInterval(async () => {
    if (grace || !await access(reportPath).then(() => true, () => false)) return;
    grace = setTimeout(() => {
      stoppedAfterReport = true;
      console.log(`${name}: the editor did not exit within 60 seconds after writing its report; stopping it`);
      stopInstance(userData);
    }, 60000);
  }, 2000);
  try {
    await runTests({
      ...(executable ? { vscodeExecutablePath: executable } : { version: process.env.VSCODE_TEST_VERSION ?? 'stable' }), extensionDevelopmentPath: at(root),
      extensionTestsPath: at(join(root, 'dist', 'test-host.js')),
      launchArgs: [...(remote ? ['--folder-uri', at(workspace)] : [workspace, '--disable-extensions']), '--user-data-dir=' + userData, '--extensions-dir=' + extensions, '--disable-telemetry', ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])],
      extensionTestsEnv: { MARKDOWN_REVIEW_HOST: name, MARKDOWN_REVIEW_SKIP_FOCUS_TESTS: process.env.MARKDOWN_REVIEW_SKIP_FOCUS_TESTS ?? '', MARKDOWN_LENS_LOCALE: locale, MARKDOWN_REVIEW_GIT: git,
        // wsl.exe passes only the variables listed here into the distribution.
        ...(remoteKind === 'wsl' ? { WSLENV: [process.env.WSLENV, 'MARKDOWN_LENS_LOCALE/u', 'MARKDOWN_REVIEW_GIT/u', 'MARKDOWN_REVIEW_HOST/u', 'MARKDOWN_REVIEW_SKIP_FOCUS_TESTS/u'].filter(Boolean).join(':') } : {}) },
    });
  } catch (error) {
    if (!stoppedAfterReport) throw error;
  } finally { clearInterval(watchdog); clearTimeout(grace); }
  // Some editors exit with code 0 even when the test runner throws. Only a written
  // report proves that every check ran to the end.
  const report = JSON.parse(await readFile(reportPath, 'utf8').catch(() => { throw new Error(`${name}: the host checks did not finish (no results/host.json)`); }));
  console.log(`${name} ${report.version}: ${report.passed} host checks passed${report.skipped.length ? `, skipped: ${report.skipped.join('; ')}` : ''}`);
  if (remote && !report.remote) throw new Error(`${name}: the checks did not run in a remote extension host`);
}

/** Stop the editor processes started with this profile directory. */
function stopInstance(profile) {
  try {
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'inherit' });
    } else {
      execFileSync('pkill', ['-f', '--', profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')], { stdio: 'inherit' });
    }
  } catch { /* nothing left to stop */ }
}
