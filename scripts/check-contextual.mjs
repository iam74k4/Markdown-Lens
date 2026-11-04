import { expect } from '@playwright/test';
import { join } from 'node:path';
import { clickTool } from './ui-tools.mjs';

export async function checkContextual({ page, frame, output }) {
  const checks = [];
  const selectText = async () => {
    const paragraph = frame.locator('.ProseMirror > p').first();
    await paragraph.click();
    await paragraph.evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await expect(frame.locator('#formatting')).toBeVisible();
  };
  await expect(frame.locator('#tools-panel')).toBeHidden();
  await expect(frame.locator('#formatting')).toBeHidden();
  await expect(frame.locator('.toolbar button')).toHaveCount(3);
  await expect(frame.locator('#review-actions')).toBeVisible();
  await frame.locator('body').screenshot({ caret: 'initial', path: join(output, 'contextual-preview.png') });
  checks.push('Quiet header contains only Preview, MD and More; review navigation is at the bottom');

  await frame.locator('#more-tools').click();
  await expect(frame.locator('#fold-all')).toBeVisible();
  await expect(frame.locator('[data-format="image"]')).toBeVisible();
  await frame.locator('body').screenshot({ caret: 'initial', path: join(output, 'contextual-menu.png') });
  await page.keyboard.press('Escape');
  await expect(frame.locator('#tools-panel')).toBeHidden();
  await expect(frame.locator('#more-tools')).toBeFocused();
  await clickTool(frame, '#toggle-find');
  await expect(frame.locator('#find-query')).toBeFocused();
  await expect(frame.locator('#tools-panel')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(frame.locator('#more-tools')).toBeFocused();
  checks.push('More menu supports keyboard dismissal and search restores visible focus');

  await selectText();
  await frame.locator('body').screenshot({ caret: 'initial', path: join(output, 'contextual-selection.png') });
  await frame.locator('[data-format="bold"]').click();
  await expect(frame.locator('.ProseMirror > p').first().locator('strong')).toHaveCount(1);
  await clickTool(frame, '[data-format="undo"]');
  await expect(frame.locator('.ProseMirror > p').first().locator('strong')).toHaveCount(0);
  await selectText();
  await frame.locator('#close-formatting').click();
  await expect(frame.locator('#formatting')).toBeHidden();
  await selectText();
  checks.push('Selection toolbar formats the selected text, preserves Undo, and reopens for the same selection');

  await frame.locator('#toggle-source').click();
  await expect(frame.locator('#source-text')).toBeVisible();
  await expect(frame.locator('.reading-pane')).toBeHidden();
  await expect(frame.locator('#formatting')).toBeHidden();
  await expect(frame.locator('#review-actions')).toBeHidden();
  await frame.locator('#more-tools').click();
  await expect(frame.locator('#insert-tools')).toBeHidden();
  await page.keyboard.press('Escape');
  await frame.locator('#source-version').selectOption('confirmed');
  await expect(frame.locator('#source-text')).toHaveAttribute('readonly', '');
  await frame.locator('body').screenshot({ caret: 'initial', path: join(output, 'contextual-source.png') });
  await frame.locator('#source-version').selectOption('current');
  await frame.locator('#mode-edit').click();
  await expect(frame.locator('.ProseMirror')).toBeVisible();
  checks.push('Preview and MD are exclusive views; MD hides rich-edit commands and keeps confirmed-source access');

  await frame.locator('.ProseMirror > p').first().click();
  await page.mouse.move(0, 0);
  await expect(frame.locator('.quick-table-tools').first()).toBeHidden();
  await frame.locator('.quick-table td p').first().click();
  await expect(frame.locator('.quick-table-tools').first()).toBeVisible();
  checks.push('Row and column controls appear when a table is selected');

  for (const width of [360, 600]) {
    await page.setViewportSize({ width, height: 800 });
    await selectText();
    expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const toolbar = await frame.locator('#formatting').boundingBox();
    expect(toolbar.width).toBeLessThanOrEqual(width);
    await frame.locator('#more-tools').click();
    await expect(frame.locator('#tools-panel')).toBeVisible();
    expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await frame.locator('body').screenshot({ caret: 'initial', path: join(output, `contextual-${width}.png`) });
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1280, height: 960 });
  await frame.locator('.identity').click();
  await expect(frame.locator('#formatting')).toBeHidden();
  checks.push('Selection toolbar and More menu fit narrow editor widths without page overflow');
  await frame.locator('.ProseMirror > p').first().click();
  await page.keyboard.press('Alt+F10');
  await expect(frame.locator('#formatting')).toBeVisible();
  await expect(frame.locator('#block-type')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(frame.locator('#formatting')).toBeHidden();
  checks.push('Alt+F10 opens formatting without a text selection; Escape returns to the document');

  await frame.locator('#reviewed').click();
  await expect(frame.locator('#review-actions')).toBeHidden();
  await expect(frame.locator('#empty')).toBeVisible();
  await expect(frame.locator('#undo-review')).toBeVisible();
  await frame.locator('body').screenshot({ caret: 'initial', path: join(output, 'contextual-reviewed.png') });
  await frame.locator('#undo-review').click();
  await expect(frame.locator('#review-actions')).toBeVisible();
  await expect(frame.locator('#counter')).toHaveText('未確認 3件');
  checks.push('Review completion hides the bottom bar; the compact Undo notification restores all three changes');
  return checks;
}
