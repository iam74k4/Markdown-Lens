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
    await expect(frame.locator('#counter')).toHaveText('未確認 3件');
    await expect(frame.locator('#document')).toContainText('認証設計書');
    await expect(frame.locator('ins').first()).toHaveText('24時間');
    await expect(frame.locator('#reviewed')).toBeEnabled();
    await expect(frame.locator('[data-review]')).toHaveCount(3);
    for (const control of await frame.locator('.change-actions button').all()) await expect(control).toBeVisible();
    await expect(frame.locator('[data-review]').first()).toHaveAccessibleName('変更 1 を確認済みにする');
    await expect(frame.locator('[data-review]').first()).toHaveText('');
    await expect(frame.locator('[data-review]').first().locator('svg')).toHaveAttribute('aria-hidden', 'true');
    await expect(frame.locator('#reviewed')).toHaveAccessibleName('すべて確認済みにする');
    await frame.locator('[data-review]').first().focus();
    await expect.poll(() => frame.locator('[data-review]').first().evaluate(el => getComputedStyle(el, '::after').visibility)).toBe('visible');
    await frame.locator('#mode-diff').focus();
    await page.getByText('All installed extensions are temporarily disabled.', { exact: true }).waitFor({ state: 'hidden' });
    await frame.locator('#filename').hover();
    await frame.locator('body').screenshot({ path: join(output, `markdown-review-${name}.png`) });

    // Both colour schemes and a narrow editor must keep the actions visible.
    await writeFile(join(workspace, 'theme'), 'Default Light Modern');
    await expect(frame.locator('body')).toHaveClass(/vscode-light/);
    await frame.locator('body').screenshot({ path: join(base, 'light.png') });
    await page.setViewportSize({ width: 600, height: 850 });
    await expect(frame.locator('#reviewed')).toBeVisible();
    await frame.locator('body').screenshot({ path: join(base, 'narrow.png') });
    await expect.poll(() => frame.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);

    // Individual approval removes only one highlight and preserves the file.
    const fileBeforeReview = await readFile(join(workspace, 'design.md'), 'utf8');
    await frame.locator('[data-review]').first().click();
    await expect(frame.locator('#counter')).toHaveText('未確認 2件');
    await expect(frame.locator('[data-review]')).toHaveCount(2);
    await expect(frame.locator('.change.active [data-review]')).toBeFocused();
    expect(await readFile(join(workspace, 'design.md'), 'utf8')).toBe(fileBeforeReview);
    await expect(frame.locator('#save-state')).toHaveText('保存済み');
    await writeFile(join(workspace, 'design.md'), fileBeforeReview.replace('24時間', '48時間'));
    await expect(frame.locator('#counter')).toHaveText('未確認 3件');
    await expect(frame.locator('.change').first().locator('del')).toHaveText('24');
    await writeFile(join(workspace, 'design.md'), fileBeforeReview);
    await expect(frame.locator('#counter')).toHaveText('未確認 2件');
    await page.setViewportSize({ width: 360, height: 800 });
    await expect.poll(() => frame.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
    await frame.locator('body').screenshot({ path: join(base, 'narrow-360.png') });
    await page.setViewportSize({ width: 600, height: 850 });

    await frame.locator('#next').click();
    await expect(frame.locator('#position')).toHaveText('2 / 2');
    await frame.locator('#previous').click();
    await expect(frame.locator('#position')).toHaveText('1 / 2');
    await frame.locator('.change.active .revert').click();
    await expect(frame.locator('#counter')).toHaveText('未確認 1件');
    await expect(frame.locator('#save-state')).toContainText('未保存');
    await frame.locator('#save').click();
    await expect(frame.locator('#save-state')).toHaveText('保存済み');
    expect(await readFile(join(workspace, 'design.md'), 'utf8')).toContain('ユーザー');
    await frame.locator('[data-review]').click();
    await expect(frame.locator('#counter')).toHaveText('✓ 確認完了');
    await expect(frame.locator('#empty')).toBeVisible();
    await expect(frame.locator('#empty')).toBeFocused();
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
    await frame.locator('#reviewed').click();
    await expect(frame.locator('#counter')).toHaveText('✓ 確認完了');
    expect(errors).toEqual([]);
    await writeFile(join(base, 'ui-result.json'), JSON.stringify({ host: name, passed: true, checks: ['real webview rendering', 'dark and light themes', '600px and 360px layout without horizontal overflow', 'always visible per-change actions', 'icon buttons retain accessible names and keyboard tooltips', 'individual approval without saving or changing the file', 're-edits become unreviewed', 'keyboard focus after individual approval and completion', 'next and previous change', 'revert button', 'save button', 'review all button', 'WYSIWYG typing and bold', 'edit/diff switching', 'Markdown file save', 'table editing and row insertion', 'concurrent edits preserve drafts', 'explicit draft discard loads latest', 'no renderer errors'] }, null, 2));
    console.log('MARKDOWN_REVIEW_UI_RESULT ' + name + ' passed');
  } finally {
    if (browser) await browser.close();
    await writeFile(join(workspace, 'done'), 'done');
    await running;
  }
}
