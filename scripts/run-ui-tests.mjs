import { runTests } from '@vscode/test-electron';
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve('.');
const output = process.env.MARKDOWN_REVIEW_OUTPUT ? resolve(process.env.MARKDOWN_REVIEW_OUTPUT) : join(root, 'test-results');
await build({ entryPoints: ['test/ui-host.ts'], bundle: true, outfile: 'dist/test-ui.js', external: ['vscode'], platform: 'node', format: 'cjs', target: 'node20' });
const targets = [
  ['vscode', '/Applications/Visual Studio Code.app/Contents/MacOS/Code', 9361],
  ['cursor', '/Applications/Cursor.app/Contents/MacOS/Cursor', 9362],
];
for (const [name, executable, port] of targets) {
  // Cursor's fresh profiles can require interactive login. Default to VS Code;
  // the host suite covers both, and Cursor UI is also checked in a signed-in window.
  if ((process.env.MARKDOWN_REVIEW_TARGET ?? 'vscode') !== name) continue;
  const base = join(root, 'test-results', 'ui-' + name + '-' + Date.now());
  const workspace = join(base, 'workspace');
  const userData = resolve(root, '..', 'ui-' + name + '-' + Date.now().toString(36));
  await mkdir(workspace, { recursive: true });
  await mkdir(join(userData, 'User'), { recursive: true });
  await writeFile(join(userData, 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'window.restoreWindows': 'none',
    'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off',
    'update.mode': 'none', 'extensions.autoUpdate': false, 'files.hotExit': 'off',
    'workbench.colorTheme': 'Default Dark Modern', 'window.newWindowDimensions': 'maximized',
    'chat.disableAIFeatures': true, 'workbench.secondarySideBar.defaultVisibility': 'hidden',
  }));
  const running = runTests({ vscodeExecutablePath: executable, extensionDevelopmentPath: root, extensionTestsPath: join(root, 'dist', 'test-ui.js'),
    launchArgs: [workspace, '--user-data-dir=' + userData, '--extensions-dir=' + join(base, 'extensions'), '--disable-extensions', '--remote-debugging-port=' + port] });
  // Attach a rejection handler immediately while waiting for the renderer.
  running.catch(() => {});
  let browser;
  try {
    await expect(async () => { await access(join(workspace, 'ready')); }).toPass({ timeout: 30000 });
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
    let frame, page;
    await expect(async () => {
      for (const p of browser.contexts().flatMap(c => c.pages())) {
        for (const f of p.frames()) {
          if (await f.locator('#reviewed').count()) { page = p; frame = f; }
        }
      }
      expect(frame).toBeTruthy();
    }).toPass({ timeout: 15000 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width: 1280, height: 960 });
    await expect(frame.locator('#counter')).toHaveText('1 / 3 件');
    await expect(frame.locator('#document')).toContainText('認証設計書');
    await expect(frame.locator('ins').first()).toHaveText('24時間');
    await expect(frame.locator('#reviewed')).toBeEnabled();
    await frame.locator('body').screenshot({ path: join(output, `markdown-review-${name}.png`) });

    // Both colour schemes and a narrow editor must keep the actions visible.
    await writeFile(join(workspace, 'theme'), 'Default Light Modern');
    await expect(frame.locator('body')).toHaveClass(/vscode-light/);
    await frame.locator('body').screenshot({ path: join(base, 'light.png') });
    await page.setViewportSize({ width: 600, height: 850 });
    await expect(frame.locator('#reviewed')).toBeVisible();
    await frame.locator('body').screenshot({ path: join(base, 'narrow.png') });
    await expect.poll(() => frame.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);

    await frame.locator('#next').click();
    await expect(frame.locator('#counter')).toHaveText('2 / 3 件');
    await frame.locator('.change.active .revert').click();
    await expect(frame.locator('#counter')).toContainText('/ 2 件');
    await expect(frame.locator('#save-state')).toContainText('未保存');
    await frame.locator('#save').click();
    await expect(frame.locator('#save-state')).toHaveText('保存済み');
    expect(await readFile(join(workspace, 'design.md'), 'utf8')).toContain('ユーザー');
    await frame.locator('#reviewed').click();
    await expect(frame.locator('#counter')).toHaveText('変更なし');
    await expect(frame.locator('#empty')).toBeVisible();
    await expect(frame.locator('#reviewed')).toBeDisabled();
    await expect(frame.locator('#feedback')).toContainText('確認済みにしました');
    await frame.locator('#mode-edit').click();
    await expect(frame.locator('.ProseMirror')).toBeVisible();
    const firstParagraph = frame.locator('.ProseMirror > p').first();
    await firstParagraph.fill('認証情報を安全に管理します。');
    await expect(frame.locator('#save-state')).toHaveText('● 編集中');
    // Select the paragraph exactly; macOS/Electron intercepts some Home/End shortcuts.
    await firstParagraph.evaluate(el => {
      el.closest('[contenteditable]').focus();
      const range = document.createRange(); range.selectNodeContents(el);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await expect.poll(() => frame.evaluate(() => window.getSelection()?.toString())).toBe('認証情報を安全に管理します。');
    await frame.locator('[data-format="bold"]').click();
    await expect(firstParagraph.locator('strong')).toHaveText('認証情報を安全に管理します。');
    await frame.locator('#mode-diff').click();
    await expect(frame.locator('#document')).toBeVisible();
    await expect(frame.locator('#document')).toContainText('認証情報を安全に管理します。');
    await expect(frame.locator('#save-state')).toContainText('未保存');
    await frame.locator('#save').click();
    await expect(frame.locator('#save-state')).toHaveText('保存済み');
    expect(await readFile(join(workspace, 'design.md'), 'utf8')).toContain('**認証情報を安全に管理します。**');
    await frame.locator('#mode-edit').click();
    await frame.locator('.ProseMirror td p').last().fill('少し待って再試行してください');
    await frame.locator('#table-action').selectOption('addRow');
    await expect(frame.locator('.ProseMirror tr')).toHaveCount(4);
    await frame.locator('#save').click();
    await expect(frame.locator('#save-state')).toHaveText('保存済み');
    const edited = await readFile(join(workspace, 'design.md'), 'utf8');
    expect(edited).toContain('少し待って再試行してください');
    await firstParagraph.fill('自分の編集中の下書きです。');
    await expect(frame.locator('#save-state')).toContainText('編集中');
    await writeFile(join(workspace, 'design.md'), edited.replace('24時間', '72時間'));
    await expect(frame.locator('#conflict')).toBeVisible();
    await expect(firstParagraph).toHaveText('自分の編集中の下書きです。');
    await expect(frame.locator('#save')).toBeDisabled();
    await frame.locator('#mode-diff').click();
    await expect(frame.locator('.ProseMirror')).toBeVisible();
    expect(await readFile(join(workspace, 'design.md'), 'utf8')).toContain('72時間');
    await frame.locator('#discard-draft').click();
    await expect(frame.locator('#conflict')).toBeHidden();
    await expect(frame.locator('.ProseMirror')).toContainText('72時間');
    await writeFile(join(workspace, 'theme'), 'Default Dark Modern');
    await expect(frame.locator('body')).toHaveClass(/vscode-dark/);
    await page.setViewportSize({ width: 1280, height: 960 });
    await frame.locator('body').screenshot({ path: join(output, `markdown-review-${name}-edit.png`) });
    await frame.locator('#mode-diff').click();
    await expect(frame.locator('#document')).toBeVisible();
    await frame.locator('body').screenshot({ path: join(output, `markdown-review-${name}-diff.png`) });
    expect(errors).toEqual([]);
    await writeFile(join(base, 'ui-result.json'), JSON.stringify({ host: name, passed: true, checks: ['real webview rendering', 'dark and light themes', '600px layout without horizontal overflow', 'next change', 'revert button', 'save button', 'reviewed button', 'WYSIWYG typing and bold', 'edit/diff switching', 'Markdown file save', 'table editing and row insertion', 'concurrent edits preserve drafts', 'explicit draft discard loads latest', 'no renderer errors'] }, null, 2));
    console.log('MARKDOWN_REVIEW_UI_RESULT ' + name + ' passed');
  } finally {
    if (browser) await browser.close();
    await writeFile(join(workspace, 'done'), 'done');
    await running;
  }
}
