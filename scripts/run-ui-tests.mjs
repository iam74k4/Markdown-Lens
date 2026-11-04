import { runTests } from '@vscode/test-electron';
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { checkProductivity } from './check-productivity.mjs';
import { checkEditing } from './check-editing.mjs';
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
    if (name === 'cursor') {
      await page.screenshot({ caret: 'initial', path: join(base, 'cursor-start.png') });
    }
    // Optional README assets: capture real Webview pixels without changing document content or CSS.
    const screenshots = process.env.MARKDOWN_REVIEW_SCREENSHOTS ? resolve(process.env.MARKDOWN_REVIEW_SCREENSHOTS) : undefined;
    const captureReadme = async (file, selector) => {
      if (!screenshots) return;
      await mkdir(screenshots, { recursive: true });
      await page.getByText('All installed extensions are temporarily disabled.', { exact: true }).waitFor({ state: 'hidden' });
      const y = await frame.evaluate(() => scrollY);
      if (selector) await frame.locator(selector).scrollIntoViewIfNeeded();
      else await frame.evaluate(() => window.scrollTo(0, 0));
      await page.mouse.move(0, 0);
      if (selector) {
        // Hiding the caret mutates contenteditable styles and makes ProseMirror rebuild media node views.
        await frame.locator(selector).screenshot({ caret: 'initial', path: join(screenshots, file + '.png') });
        await frame.evaluate(y => window.scrollTo(0, y), y);
        return;
      }
      const viewport = await (await frame.frameElement()).boundingBox();
      if (!viewport) throw new Error('Missing screenshot bounds');
      await page.screenshot({ caret: 'initial', path: join(screenshots, file + '.png'), clip: viewport });
      await frame.evaluate(y => window.scrollTo(0, y), y);
    };
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') console.log('Renderer:', m.text().slice(0, 1000)); });
    page.on('requestfailed', r => console.log('Request failed:', r.url().slice(0, 300), r.failure()?.errorText));
    await page.setViewportSize({ width: 1280, height: 960 });
    await expect(frame.locator('#counter')).toHaveText('未確認 3件');
    if (process.env.MARKDOWN_REVIEW_FOCUS === 'productivity') {
      const args = {page,frame,workspace,path:join(workspace,'design.md'),output:base};
      const checks = [...await checkEditing(args), ...await checkProductivity(args)];
      expect(errors).toEqual([]);
      await writeFile(join(base,'ui-result.json'),JSON.stringify({host:name,passed:true,checks},null,2));
      console.log('MARKDOWN_REVIEW_FOCUSED_UI_RESULT ' + name + ' passed'); continue;
    }

    const openTables = async () => {
      await expect(frame.locator('.inline-before[data-kind="table"]').first()).toBeVisible();
      for (const d of await frame.locator('.inline-before[data-kind="table"]').all()) {
        if (await d.getAttribute('open') === null) await d.locator(':scope > summary').click();
      }
      await expect(frame.locator('.review-table').first()).toBeVisible();
    };
    const closeComparisons = async () => {
      for (const d of await frame.locator('.inline-before[open]').all()) await d.locator(':scope > summary').click();
      await expect(frame.locator('.inline-comparison')).toHaveCount(0);
    };
    const beforeFolding = await readFile(join(workspace, 'design.md'), 'utf8');
    await frame.getByRole('button', { name: '「1. セッション」を折りたたむ', exact: true }).click();
    await expect(frame.locator('.inline-review').first()).toBeHidden();
    await expect(frame.locator('.section-fold-count')).toContainText(['1件']);
    await expect(frame.locator('#save-state')).toHaveText('保存済み');
    await frame.locator('#next').click();
    await frame.locator('#previous').click();
    await expect(frame.locator('.inline-review').first()).toBeVisible();
    await frame.locator('#fold-all').click();
    await expect(frame.locator('.quick-table')).toBeHidden();
    await expect(frame.locator('#mode-diff')).toHaveCount(0);
    await expect(frame.locator('.inline-review').first()).toBeHidden();
    await frame.locator('#next').click();
    await expect(frame.locator('.inline-review.active')).toBeVisible();
    await frame.locator('#unfold-all').click();
    await expect(frame.locator('.quick-table')).toBeVisible();
    expect(await readFile(join(workspace, 'design.md'), 'utf8')).toBe(beforeFolding);
    await frame.getByRole('button', { name: '「1. セッション」を折りたたむ', exact: true }).click();
    await frame.locator('body').screenshot({ caret: 'initial', path: join(output, `markdown-lens-${name}-folding.png`) });
    await captureReadme('section-folding');
    await frame.locator('#unfold-all').click();
    // Unified surface: type on highlighted content, review the local draft, and keep exact source access.
    const originalUnified = await readFile(join(workspace, 'design.md'), 'utf8');
    await expect(frame.locator('.ProseMirror')).toBeVisible();
    await expect(frame.locator('.inline-insert').first()).toHaveText('24時間');
    await expect(frame.locator('.inline-review')).toHaveCount(3);
    await frame.locator('.inline-before summary').first().click();
    await expect(frame.locator('.inline-before[open]')).toContainText('30分');
    await captureReadme('inline-review');
    await captureReadme('view-controls', '.toolbar');
    await frame.locator('#changes-only').click();
    await expect(frame.locator('.inline-folded').first()).toBeHidden();
    await frame.locator('.inline-expand').first().click();
    await expect(frame.locator('.ProseMirror h1')).toBeVisible();
    await frame.locator('#changes-only').click();
    const unifiedParagraph = frame.locator('.ProseMirror > p').first();
    await unifiedParagraph.fill('統合画面で直接編集します。');
    await expect(frame.locator('.inline-review')).toHaveCount(4);
    await expect(frame.locator('.inline-insert').first()).toContainText('統合');
    await expect(frame.locator('#save-state')).toContainText('編集中');
    const selectionBefore = await frame.evaluate(() => [window.getSelection()?.anchorOffset, window.getSelection()?.focusOffset]);
    await expect(frame.locator('.inline-review [data-review]').first()).toBeEnabled();
    expect(await frame.evaluate(() => [window.getSelection()?.anchorOffset, window.getSelection()?.focusOffset])).toEqual(selectionBefore);
    expect(await readFile(join(workspace, 'design.md'), 'utf8')).toBe(originalUnified);
    await frame.locator('#toggle-source').click();
    await expect(frame.locator('#source-text')).toHaveValue(/統合画面/);
    await frame.locator('#source-version').selectOption('confirmed');
    await expect(frame.locator('#source-text')).toHaveAttribute('readonly', '');
    await expect(frame.locator('#source-text')).toHaveValue(/30分/);
    await frame.locator('#source-version').selectOption('current');
    await expect(frame.locator('#source-text')).toBeEditable();
    await frame.locator('#source-text').fill(originalUnified.replace('アカウント認証に関する仕様をまとめます。', 'ソースから本文も編集できます。'));
    await expect(unifiedParagraph).toHaveText('ソースから本文も編集できます。');
    await frame.locator('#close-source').click();
    await expect(frame.locator('.inline-review [data-review]').first()).toBeEnabled();
    await frame.locator('.inline-review [data-review]').first().click();
    await expect(frame.locator('#counter')).toHaveText('未確認 3件');
    await expect(frame.locator('#save-state')).toContainText('未保存');
    expect(await readFile(join(workspace, 'design.md'), 'utf8')).toBe(originalUnified);
    await frame.locator('#undo-review').click();
    await expect(frame.locator('#counter')).toHaveText('未確認 4件');
    await frame.locator('.inline-review [data-revert]').first().click();
    await expect(unifiedParagraph).toHaveText('アカウント認証に関する仕様をまとめます。');
    await frame.locator('#save').click();
    await expect(frame.locator('#save-state')).toHaveText('保存済み');
    expect(await readFile(join(workspace, 'design.md'), 'utf8')).toBe(originalUnified);
    await frame.locator('body').screenshot({ caret: 'initial', path: join(output, `markdown-lens-${name}-unified.png`) });
    await frame.locator('#toggle-source').click();
    await frame.locator('#source-version').selectOption('confirmed');
    await frame.locator('body').screenshot({ caret: 'initial', path: join(output, `markdown-lens-${name}-source.png`) });
    await captureReadme('markdown-source');
    await page.setViewportSize({ width: 360, height: 800 });
    await expect(frame.locator('#source-text')).toBeVisible();
    await expect.poll(() => frame.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
    await frame.locator('#close-source').click();
    await expect(frame.locator('.ProseMirror')).toBeVisible();
    await expect.poll(() => frame.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
    await frame.locator('body').screenshot({ caret: 'initial', path: join(output, `markdown-lens-${name}-unified-narrow.png`) });
    await page.setViewportSize({ width: 1280, height: 960 });

    await expect(frame.locator('.ProseMirror')).toContainText('認証設計書');
    await expect(frame.locator('.inline-insert').first()).toHaveText('24時間');
    await expect(frame.locator('#reviewed')).toBeEnabled();
    await expect(frame.locator('[data-review]')).toHaveCount(3);
    for (const control of await frame.locator('.change-actions button').all()) await expect(control).toBeVisible();
    await expect(frame.locator('[data-review]').first()).toHaveAccessibleName('変更 1 を確認済みにする');
    await expect(frame.locator('[data-review]').first()).toHaveText('');
    await expect(frame.locator('[data-review]').first().locator('svg')).toHaveAttribute('aria-hidden', 'true');
    await expect(frame.locator('#reviewed')).toHaveAccessibleName('すべて確認済みにする');
    await frame.locator('[data-review]').first().focus();
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    await expect.poll(() => frame.locator('[data-review]').first().evaluate(el => getComputedStyle(el, '::after').visibility)).toBe('visible');
    await frame.locator('#mode-edit').focus();
    await page.getByText('All installed extensions are temporarily disabled.', { exact: true }).waitFor({ state: 'hidden' });
    await frame.locator('#filename').hover();
    await frame.locator('body').screenshot({ caret: 'initial', path: join(output, `markdown-review-${name}.png`) });

    // Both colour schemes and a narrow editor must keep the actions visible.
    await writeFile(join(workspace, 'theme'), 'Default Light Modern');
    await expect(frame.locator('body')).toHaveClass(/vscode-light/);
    await frame.locator('body').screenshot({ caret: 'initial', path: join(base, 'light.png') });
    await page.setViewportSize({ width: 600, height: 850 });
    await expect(frame.locator('#reviewed')).toBeVisible();
    await frame.locator('body').screenshot({ caret: 'initial', path: join(base, 'narrow.png') });
    await expect.poll(() => frame.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);

    // Individual approval removes only one highlight and preserves the file.
    const fileBeforeReview = await readFile(join(workspace, 'design.md'), 'utf8');
    await frame.locator('[data-review]').first().click();
    await expect(frame.locator('#counter')).toHaveText('未確認 2件');
    await expect(frame.locator('[data-review]')).toHaveCount(2);
    await expect(frame.locator('.change.active [data-review]')).toBeFocused();
    expect(await readFile(join(workspace, 'design.md'), 'utf8')).toBe(fileBeforeReview);
    await expect(frame.locator('#save-state')).toHaveText('保存済み');
    await frame.locator('#undo-review').click();
    await expect(frame.locator('#counter')).toHaveText('未確認 3件');
    expect(await readFile(join(workspace, 'design.md'), 'utf8')).toBe(fileBeforeReview);
    await frame.locator('[data-review]').first().click();
    await expect(frame.locator('#counter')).toHaveText('未確認 2件');
    await frame.locator('#changes-only').click();
    await expect(frame.locator('.inline-folded').first()).toBeHidden();
    await frame.locator('.inline-expand').first().click();
    await expect(frame.locator('.ProseMirror h1')).toBeVisible();
    await frame.locator('#changes-only').click();
    await writeFile(join(workspace, 'design.md'), fileBeforeReview.replace('24時間', '48時間'));
    await expect(frame.locator('#counter')).toHaveText('未確認 3件');
    await frame.locator('.inline-review').first().locator('.inline-before > summary').click();
    await expect(frame.locator('.change').first().locator('del')).toHaveText('24');
    await writeFile(join(workspace, 'design.md'), fileBeforeReview);
    await expect(frame.locator('#counter')).toHaveText('未確認 2件');
    await page.setViewportSize({ width: 360, height: 800 });
    await expect.poll(() => frame.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
    await frame.locator('body').screenshot({ caret: 'initial', path: join(base, 'narrow-360.png') });
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
    await expect(frame.locator('#feedback')).toContainText('確認しました');
    await frame.locator('#mode-edit').click();
    await expect(frame.locator('.ProseMirror')).toBeVisible();
    await frame.locator('#editor-wide').click();
    await expect(frame.locator('#editor')).toHaveClass(/editor-wide/);
    await frame.locator('#editor-wide').click();
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
    await expect(frame.locator('.ProseMirror')).toContainText('認証情報を安全に管理します。');
    await expect(frame.locator('#save-state')).toContainText('編集中');
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
    await frame.locator('#toggle-source').click();
    await frame.locator('#source-version').selectOption('current');
    await expect(frame.locator('#source-text')).toHaveValue(/自分の編集中/);
    await frame.locator('#mode-edit').click();
    await expect(frame.locator('.ProseMirror')).toBeVisible();
    expect(await readFile(join(workspace, 'design.md'), 'utf8')).toContain('72時間');
    await frame.locator('#discard-draft').click();
    await expect(frame.locator('#conflict')).toBeHidden();
    await expect(frame.locator('.ProseMirror')).toContainText('72時間');
    await writeFile(join(workspace, 'theme'), 'Default Dark Modern');
    await expect(frame.locator('body')).toHaveClass(/vscode-dark/);
    await page.setViewportSize({ width: 1280, height: 960 });
    await frame.locator('body').screenshot({ caret: 'initial', path: join(output, `markdown-review-${name}-edit.png`) });
    await expect(frame.locator('.ProseMirror')).toBeVisible();
    await frame.locator('body').screenshot({ caret: 'initial', path: join(output, `markdown-review-${name}-diff.png`) });
    await frame.locator('#reviewed').click();
    await expect(frame.locator('#counter')).toHaveText('✓ 確認完了');
    await writeFile(join(workspace, 'visual-fixture'), 'start');
    await expect(async () => { await access(join(workspace, 'visual-ready')); }).toPass({ timeout: 15000 });
    await expect(async () => {
      for (const p of browser.contexts().flatMap(c => c.pages())) for (const f of p.frames()) {
        if (await f.locator('#filename').count() && await f.locator('#filename').textContent() === 'visual.md') { page = p; frame = f; }
      }
      await expect(frame.locator('#filename')).toHaveText('visual.md');
    }).toPass({ timeout: 15000 });
    await expect(frame.locator('#counter')).toHaveText('未確認 3件');
    await expect(frame.locator('.ProseMirror .diagram-canvas svg')).toHaveCount(1, { timeout: 20000 });
    await expect(frame.locator('.ProseMirror .markdown-image')).toHaveCount(1);
    const visualOriginal = await readFile(join(workspace, 'visual.md'), 'utf8');
    await frame.locator('.rich-code-source > summary').click();
    const codeEditor = frame.locator('.rich-code-source > pre > code');
    await codeEditor.fill('flowchart LR\nA[認証] --> C[高速キャッシュ]\nC --> D[(DB)]');
    await expect(frame.locator('.ProseMirror .diagram-canvas')).toContainText('高速キャッシュ', { timeout: 15000 });
    await expect(frame.locator('.ProseMirror .inline-insert').filter({ hasText: '高速' })).toHaveCount(1);
    expect(await readFile(join(workspace, 'visual.md'), 'utf8')).toBe(visualOriginal);
    await frame.locator('[data-format="undo"]').click();
    await expect(codeEditor).not.toContainText('高速');
    await frame.locator('#toggle-source').click();
    await frame.locator('#source-text').fill(visualOriginal + '\n- [ ] レビューする\n');
    await frame.locator('#close-source').click();
    await expect(frame.locator('input[data-task]')).not.toBeChecked();
    await frame.locator('input[data-task]').check();
    await expect(frame.locator('input[data-task]')).toBeChecked();
    await frame.locator('#toggle-source').click();
    await expect(frame.locator('#source-text')).toHaveValue(/\[x\] レビューする/);
    // Return to the fixture before exercising existing detail-review flows.
    await frame.locator('#source-text').fill(visualOriginal);
    await frame.locator('#close-source').click();
    await frame.locator('body').screenshot({ caret: 'initial', path: join(output, `markdown-lens-${name}-unified-visual.png`) });

    await openTables();
    await expect(frame.locator('#editor .rich-diagram-preview .diagram-canvas svg')).toHaveCount(1, { timeout: 20000 });
    await expect(frame.locator('#editor .rich-diagram-preview .diagram-added.node')).toHaveCount(1);
    await expect(frame.locator('#editor .rich-diagram-preview path.diagram-added')).toHaveCount(2);
    await expect(frame.locator('#editor .rich-diagram-preview path.diagram-removed')).toHaveCount(1);
    await expect(frame.locator('.changed-cell')).toHaveCount(1);
    await expect(frame.locator('.changed-cell')).toContainText('60');
    await frame.locator('#editor .rich-image .markdown-image').scrollIntoViewIfNeeded();
    await expect.poll(() => frame.locator('#editor .rich-image .markdown-image').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 1180 });
    await frame.evaluate(() => window.scrollTo(0, 0));
    await frame.locator('#filename').hover();
    await frame.locator('body').screenshot({ caret: 'initial', path: join(output, `markdown-lens-${name}-visual.png`) });
    await frame.locator('#editor .rich-diagram-preview [data-diagram-mode="before"]').click();
    await expect(frame.locator('#editor .rich-diagram-preview .diagram-canvas .node')).toHaveCount(2);
    await frame.locator('#editor .rich-diagram-preview [data-diagram-mode="after"]').click();
    await expect(frame.locator('#editor .rich-diagram-preview .diagram-canvas .node')).toHaveCount(3);
    await frame.locator('#editor .rich-diagram-preview [data-diagram-mode="diff"]').click();
    await expect(frame.locator('#editor .rich-diagram-preview .diagram-added.node')).toHaveCount(1);
    await writeFile(join(workspace, 'theme'), 'Default Light Modern');
    await expect(frame.locator('body')).toHaveClass(/vscode-light/);
    await expect(frame.locator('#editor .rich-diagram-preview .diagram-added.node')).toHaveCount(1);
    await frame.locator('body').screenshot({ caret: 'initial', path: join(output, `markdown-lens-${name}-visual-light.png`) });
    await captureReadme('mermaid-diff', '#editor .rich-diagram-preview .diagram-review');
    await writeFile(join(workspace, 'theme'), 'Default Dark Modern');
    await expect(frame.locator('body')).toHaveClass(/vscode-dark/);
    await expect(frame.locator('#editor .rich-diagram-preview .diagram-added.node')).toHaveCount(1);
    const tableFileBefore = await readFile(join(workspace, 'visual.md'), 'utf8');
    await openTables();
    await frame.getByRole('button', { name: '広く表示', exact: true }).click();
    await expect(frame.locator('.table-dialog')).toBeVisible();
    await frame.getByRole('button', { name: '変更行', exact: true }).click();
    await expect(frame.locator('.table-dialog tbody tr:visible')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(frame.locator('.table-dialog')).toBeHidden();
    expect(await readFile(join(workspace, 'visual.md'), 'utf8')).toBe(tableFileBefore);
    await frame.locator('#snapshot').click();
    await expect(frame.locator('#feedback')).toContainText('スナップショットを保存');
    const captured = await readFile(join(workspace, 'visual.md'), 'utf8');
    await writeFile(join(workspace, 'visual.md'), captured.replace('60秒', '90秒'));
    await expect(frame.locator('.quick-table')).toContainText('90秒');
    await openTables();
    await expect(frame.locator('.changed-cell')).toContainText('90');
    await frame.locator('#snapshots').click();
    await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'この時点と比較' }).click();
    await expect(frame.locator('#baseline')).toContainText('スナップショット');
    await openTables();
    await frame.locator('.changed-cell .table-cell').click();
    await expect(frame.locator('.table-details')).toContainText('60');
    await expect(frame.locator('.changed-cell')).toContainText('90');
    await expect(frame.locator('#reviewed')).toBeDisabled();
    await frame.locator('#snapshots').click();
    await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: '通常のレビューに戻る' }).click();
    await expect(frame.locator('#baseline')).toHaveText('確認済みの内容 → 現在');
    await openTables();
    await frame.locator('.changed-cell .table-cell').click();
    await expect(frame.locator('.table-details')).toContainText('30');
    await frame.getByRole('button', { name: '閉じる', exact: true }).click();
    await frame.locator('#changes-only').click();
    await page.setViewportSize({ width: 360, height: 800 });
    await expect.poll(() => frame.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
    await expect(frame.locator('#editor .rich-diagram-preview .diagram-modes')).toBeVisible();
    await frame.locator('body').screenshot({ caret: 'initial', path: join(output, `markdown-lens-${name}-visual-narrow.png`) });
    await page.setViewportSize({ width: 1280, height: 960 });
    await frame.locator('#changes-only').click();
    await frame.locator('.inline-review').filter({ has: frame.locator('[data-kind="diagram"]') }).locator('[data-revert]').click();
    await expect(frame.locator('#editor .rich-diagram-preview .diagram-canvas .node')).toHaveCount(2);
    await expect(frame.locator('#save-state')).toContainText('未保存');
    expect(await readFile(join(workspace, 'visual.md'), 'utf8')).toContain('キャッシュ');
    await writeFile(join(workspace, 'table-fixture'), 'start');
    await expect(async () => { await access(join(workspace, 'table-ready')); }).toPass({ timeout: 15000 });
    await expect(async () => {
      for (const p of browser.contexts().flatMap(c => c.pages())) for (const f of p.frames()) {
        if (await f.locator('#filename').count() && await f.locator('#filename').textContent() === '認証設定.md') { page = p; frame = f; }
      }
      await expect(frame.locator('#filename')).toHaveText('認証設定.md');
    }).toPass({ timeout: 15000 });
    await openTables();
    await expect(frame.locator('.table-count')).toHaveText('18行 · 変更 2行');
    const tablePath = join(workspace, '認証設定.md');
    const originalTable = await readFile(tablePath, 'utf8');
    await frame.getByRole('button', { name: '広く表示', exact: true }).click();
    await frame.locator('.table-dialog tbody tr').first().locator('td').nth(2).locator('button').click();
    await expect(frame.locator('.table-details')).toContainText('30分');
    await expect(frame.locator('.table-details')).toContainText('24時間');
    await frame.locator('body').screenshot({ caret: 'initial', path: join(output, `markdown-lens-${name}-tables.png`) });
    await captureReadme('table-review', '.table-dialog[open]');
    await page.keyboard.press('Escape');
    await expect(frame.locator('.table-dialog')).toBeHidden();
    await frame.getByRole('button', { name: '広く表示', exact: true }).click();
    await writeFile(tablePath, originalTable.replace('24時間', '48時間'));
    await expect(frame.locator('.table-dialog[open]')).toHaveCount(0);
    await openTables();
    await expect(frame.locator('.changed-cell').first()).toContainText('48時間');
    await closeComparisons();
    await frame.locator('#mode-edit').click();
    await frame.locator('.ProseMirror tr').nth(1).locator('td p').nth(2).fill('72時間');
    await expect(frame.locator('.inline-review [data-review]')).toBeEnabled();
    await openTables();
    await expect(frame.locator('.changed-cell').first()).toContainText('72時間');
    await expect(frame.locator('#save-state')).toContainText('編集中');
    expect(await readFile(tablePath, 'utf8')).toContain('48時間');
    await frame.locator('#save').click();
    await expect(frame.locator('#save-state')).toHaveText('保存済み');
    expect(await readFile(tablePath, 'utf8')).toContain('72時間');
    await closeComparisons();
    const beforeQuick = await readFile(tablePath, 'utf8');
    await frame.locator('#mode-edit').click();
    await frame.locator('.ProseMirror tr').nth(2).locator('td p').nth(2).click();
    await frame.getByRole('button', { name: '行を上へ移動', exact: true }).click();
    await expect(frame.locator('.ProseMirror tr').nth(1)).toContainText('ログイン試行上限');
    await frame.getByRole('button', { name: '列を右へ移動', exact: true }).click();
    await expect(frame.locator('.ProseMirror th').nth(3)).toHaveText('設定値');
    await frame.getByRole('button', { name: '下に行を追加', exact: true }).click();
    await expect(frame.locator('.ProseMirror tr')).toHaveCount(20);
    await page.keyboard.type('new setting');
    await expect(frame.locator('.ProseMirror tr').nth(2)).toContainText('new setting');
    await expect(frame.locator('.inline-review')).toHaveCount(1);
    expect(await readFile(tablePath, 'utf8')).toBe(beforeQuick);
    await frame.locator('#save').click();
    await expect(frame.locator('#save-state')).toHaveText('保存済み');
    const afterQuick = await readFile(tablePath, 'utf8');
    expect(afterQuick).toContain('new setting');
    expect(afterQuick.indexOf('ログイン試行上限')).toBeLessThan(afterQuick.indexOf('セッション期限'));
    await frame.locator('.ProseMirror tr').nth(1).locator('td p').nth(3).click();
    await frame.locator('body').screenshot({ caret: 'initial', path: join(output, `markdown-lens-${name}-quick-table.png`) });
    await frame.locator('.inline-review [data-revert]').click();
    await expect(frame.locator('.ProseMirror tr')).toHaveCount(19);
    await expect(frame.locator('.ProseMirror th').nth(2)).toHaveText('設定値');
    await expect(frame.locator('.ProseMirror tr').nth(1)).toContainText('セッション期限');
    await expect(frame.locator('#save-state')).toContainText('未保存');
    expect(await readFile(tablePath, 'utf8')).toBe(afterQuick);
    await frame.locator('#toggle-source').click();
    const numberedSource = '| No | ID | 内容 |\n| --- | --- | --- |\n| 1 | 101 | Alpha |\n| 2 | 205 | Beta |\n| 3 | 999 | Gamma |\n';
    await frame.locator('#source-text').fill(numberedSource);
    await frame.locator('#close-source').click();
    await frame.locator('#save').click();
    await expect(frame.locator('#save-state')).toHaveText('保存済み');
    await frame.locator('.ProseMirror tr').nth(1).locator('td p').first().click();
    await frame.getByRole('button', { name: 'この列の自動採番を切り替え（1から連番）', exact: true }).click();
    await expect(frame.locator('[data-table-quick="numberColumn"]')).toHaveAttribute('aria-pressed', 'true');
    await frame.locator('.ProseMirror tr').nth(2).locator('td p').nth(2).click();
    await frame.getByRole('button', { name: '選択した行を削除', exact: true }).click();
    await expect(frame.locator('.ProseMirror tr')).toHaveCount(3);
    await expect(frame.locator('.ProseMirror tr').nth(2).locator('td').first()).toHaveText('2');
    await expect(frame.locator('.ProseMirror tr').nth(2).locator('td').nth(1)).toHaveText('999');
    expect(await readFile(tablePath, 'utf8')).toBe(numberedSource);
    await frame.locator('[data-format="undo"]').click();
    await expect(frame.locator('.ProseMirror tr')).toHaveCount(4);
    await expect(frame.locator('.ProseMirror tr').nth(2).locator('td').nth(2)).toHaveText('Beta');
    await frame.getByRole('button', { name: '選択した行を削除', exact: true }).click();
    await frame.locator('#save').click();
    await expect(frame.locator('#save-state')).toHaveText('保存済み');
    expect(await readFile(tablePath, 'utf8')).toContain('| 2 | 999 | Gamma |');
    await frame.locator('.ProseMirror tr').nth(2).locator('td p').first().click();
    await frame.locator('body').screenshot({ caret: 'initial', path: join(output, `markdown-lens-${name}-auto-number.png`) });
    await captureReadme('table-numbering', '.ProseMirror .quick-table');
    await frame.locator('.ProseMirror tr').nth(1).locator('td p').nth(2).click();
    await frame.getByRole('button', { name: '選択した列を削除', exact: true }).click();
    await expect(frame.locator('.ProseMirror th')).toHaveCount(2);
    await frame.locator('[data-format="undo"]').click();
    await expect(frame.locator('.ProseMirror th')).toHaveCount(3);
    // Color formatting uses the real selection, draft/save protocol and review baseline.
    await frame.locator('#toggle-source').click();
    const colorSource = '# 色付きの設計書\n\n認証の有効期限は24時間です。\n\n重要な仕様を色で区別します。\n\n| 項目 | 方針 |\n| --- | --- |\n| 認証 | 必須 |\n';
    await frame.locator('#source-text').fill(colorSource);
    await frame.locator('#close-source').click();
    await frame.locator('#save').click();
    await expect(frame.locator('#save-state')).toHaveText('保存済み');
    await frame.locator('#reviewed').click();
    await expect(frame.locator('#counter')).toHaveText('✓ 確認完了');
    const selectColorText = async () => {
      await frame.locator('.ProseMirror > p').first().click();
      await page.keyboard.press('Home');
      await frame.evaluate(() => {
        const p=document.querySelector('.ProseMirror > p');
        const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT); let text;
        while ((text=walker.nextNode())) if(text.textContent.includes('24時間')) break;
        if(!text) throw new Error('Missing color sample');
        const range=document.createRange(), start=text.textContent.indexOf('24時間');
        range.setStart(text,start); range.setEnd(text,start+4);
        const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      });
      await expect(frame.locator('#text-color')).toBeEnabled();
    };
    await selectColorText();
    await frame.locator('#text-color').click();
    await frame.getByRole('button',{name:'文字色：青',exact:true}).click();
    await expect(frame.locator('.ProseMirror [data-md-color]')).toHaveText('24時間');
    await frame.locator('#text-highlight').click();
    await frame.getByRole('button',{name:'マーカー：黄',exact:true}).click();
    await expect(frame.locator('.ProseMirror mark')).toHaveText('24時間');
    await expect(frame.locator('.inline-review')).toHaveCount(1);
    expect(await readFile(tablePath,'utf8')).toBe(colorSource);
    await frame.locator('[data-format="undo"]').click();
    await expect(frame.locator('.ProseMirror mark')).toHaveCount(0);
    await frame.locator('[data-format="redo"]').click();
    await expect(frame.locator('.ProseMirror mark')).toHaveCount(1);
    await frame.locator('#save').click();
    await expect(frame.locator('#save-state')).toHaveText('保存済み');
    const savedColors=await readFile(tablePath,'utf8');
    expect(savedColors).toContain('<mark style="background-color:#fff2a8"><span style="color:#3984d5">24時間</span></mark>');
    await frame.locator('.inline-before > summary').click();
    await expect(frame.locator('.inline-comparison .after-block mark')).toHaveText('24時間');
    await closeComparisons();
    await frame.locator('#mode-edit').click();
    await frame.locator('#toggle-source').click();
    await expect(frame.locator('#source-text')).toHaveValue(savedColors);
    await frame.locator('#close-source').click();
    await selectColorText(); await frame.locator('#text-highlight').click();
    await expect(frame.locator('#color-sample span')).toHaveCSS('color', 'rgb(57, 132, 213)');
    await expect(frame.locator('#color-sample span')).toHaveCSS('background-color', 'rgb(255, 242, 168)');
    await captureReadme('text-colors');
    await page.keyboard.press('Escape');
    await frame.locator('#text-color').click();
    await frame.getByRole('textbox',{name:'カラーコード',exact:true}).fill('#7f248b');
    await frame.getByRole('button',{name:'適用',exact:true}).click();
    await expect(frame.locator('.ProseMirror [data-md-color]')).toHaveCSS('color','rgb(127, 36, 139)');
    await frame.locator('#text-color').click();
    await frame.getByRole('button',{name:'文字色を解除',exact:true}).click();
    await expect(frame.locator('.ProseMirror [data-md-color]')).toHaveCount(0);
    await expect(frame.locator('.ProseMirror mark')).toHaveCount(1);
    await frame.locator('.inline-review [data-revert]').click();
    await expect(frame.locator('.ProseMirror mark')).toHaveCount(0);
    await expect(frame.locator('.ProseMirror [data-md-color]')).toHaveCount(0);
    expect(await readFile(tablePath,'utf8')).toBe(savedColors);
    const editingChecks = await checkEditing({ page, frame, workspace, path: tablePath, output: base });
    const productivityChecks = await checkProductivity({ page, workspace, path: tablePath, output: base });
    expect(errors).toEqual([]);
    await writeFile(join(base, 'ui-result.json'), JSON.stringify({ host: name, passed: true, checks: [...editingChecks, ...productivityChecks, 'Selected text color and marker palettes in real Webview', 'Color changes stay drafts until saved as HTML in the same Markdown file', 'Color Undo/Redo, custom hex and independent removal', 'Color-only local comparison, source and revert preserve saved file', 'heading fold hides content and review cards', 'collapsed heading shows change count', 'next change reveals its enclosing section', 'collapse and expand all cover tables', 'fold state retained on unified Preview', 'folding never changes source or save state', 'unified editable diff by default', 'inline deletion disclosure', 'inline unchanged folding', 'typing retains selection and never saves implicitly', 'current source editing and read-only confirmed source', 'local draft confirmation and confirmation undo', 'inline revert without saving', 'WYSIWYG local image and Mermaid preview', 'live Mermaid source editing and Undo', 'task checkbox serializes Markdown', 'real webview rendering', 'dark and light themes', '600px and 360px layout without horizontal overflow', 'always visible per-change actions', 'icon buttons retain accessible names and keyboard tooltips', 'individual approval without saving or changing the file', 're-edits become unreviewed', 'keyboard focus after individual approval and completion', 'next and previous change', 'revert button', 'save button', 'review all button', 'WYSIWYG typing and bold', 'Preview and Markdown source switching', 'Markdown file save', 'table editing and row insertion', 'concurrent edits preserve drafts', 'explicit draft discard loads latest', 'no renderer errors', 'confirmation undo preserves file', 'unchanged section collapse and expansion', 'flowchart node and edge semantic markers', 'diagram before/diff/after switch', 'local SVG image preview', 'changed table cell marker', 'snapshot capture and comparison without changing confirmed baseline', 'narrow diagram controls', 'diagram revert preserves unsaved semantics', 'expanded table and changed-row filter leave file unchanged', 'cell before/after detail', 'external update closes stale expanded table', 'long table WYSIWYG edit and explicit save', 'wide editing mode', 'quick row and column movement in unified review', 'one-click insertion focuses an editable new cell', 'table quick actions remain drafts until explicit save', 'inline revert restores original table order and headers without saving', 'opt-in numbering compacts after row deletion and preserves IDs', 'row deletion and renumbering Undo together in real webview', 'renumbered Markdown saves to the same file', 'quick column deletion and Undo'] }, null, 2));
    console.log('MARKDOWN_REVIEW_UI_RESULT ' + name + ' passed');
  } catch (error) {
    for (const page of browser?.contexts().flatMap(context => context.pages()) ?? []) {
      for (const f of page.frames()) if (await f.locator('.rich-code').count()) await writeFile(join(base,'failure-media.json'),JSON.stringify(await f.evaluate(()=>({source:document.querySelector('#source-text')?.value,code:[...document.querySelectorAll('.rich-code')].map(el=>({class:el.className,language:el.querySelector('input')?.value,source:el.querySelector('code')?.textContent,preview:el.querySelector('.rich-diagram-preview')?.outerHTML.slice(0,2000)}))})),null,2));
      await page.screenshot({path: join(base, 'failure.png')}).catch(() => {});
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    await writeFile(join(workspace, 'done'), 'done');
    await running;
  }
}
