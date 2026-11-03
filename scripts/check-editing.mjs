import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Exercise the host, real Webview and Chromium's composition pipeline together. */
export async function checkEditing({ page, frame, workspace, path, output }) {
  const checks = [];
  const selectEnd = async selector => {
    await frame.locator(selector).click();
    await frame.locator(selector).evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element); range.collapse(false);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
  };
  const save = async () => {
    await frame.locator('#save').click();
    await expect(frame.locator('#save-state')).toHaveText('保存済み');
  };
  const setSource = async source => {
    await frame.locator('#toggle-source').click();
    await frame.locator('#source-version').selectOption('current');
    const started = Date.now();
    await frame.locator('#source-text').fill(source, { timeout: 15000 });
    if (source.length > 10000) await writeFile(join(output, 'source-paste.json'), JSON.stringify({ bytes: Buffer.byteLength(source), fillMs: Date.now() - started }, null, 2));
    await frame.locator('#close-source').click();
    await save();
    if (await frame.locator('#reviewed').isEnabled()) {
      await frame.locator('#reviewed').click();
      await expect(frame.locator('#counter')).toHaveText('✓ 確認完了');
    }
  };
  const inputSession = async () => {
    // VS Code nests a same-process frame inside its isolated Webview target.
    for (let target = frame; target; target = target.parentFrame()) {
      try { return await page.context().newCDPSession(target); }
      catch (error) { if (!String(error).includes('does not have a separate CDP session')) throw error; }
    }
    return page.context().newCDPSession(page);
  };
  let cdp = await inputSession();
  const compose = async text => cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  const commit = async text => cdp.send('Input.insertText', { text });
  const fixture = '# 日本語の設計書\n\n仕様を確認します。\n\n| 項目 | 値 |\n| --- | --- |\n| 名前 | <mark style="background-color:#fff2a8"><span style="color:#3984d5">確認</span></mark> |\n';
  await setSource(fixture);
  const changed = fixture.replace('仕様を確認します。', '仕様を見直します。');
  await writeFile(path, changed);
  await expect(frame.locator('.inline-review')).toHaveCount(1);
  await selectEnd('.ProseMirror > p');
  await frame.evaluate(() => { window.imeCard = document.querySelector('.inline-review'); window.hostUpdates = 0;
    window.addEventListener('message', event => { if (event.data.type === 'update') window.hostUpdates++; }); });
  await compose('にほんご');
  await expect(frame.locator('.ProseMirror > p')).toContainText('にほんご');
  expect(await frame.evaluate(() => window.imeCard.isConnected)).toBe(true);
  // Programmatic click intentionally leaves composition active to test the save guard.
  await frame.locator('#save').evaluate(button => button.click());
  await expect(frame.locator('#feedback-text')).toContainText('入力を確定');
  expect(await readFile(path, 'utf8')).toBe(changed);
  await compose('日本語'); await commit('日本語');
  await expect(frame.locator('.ProseMirror > p')).toHaveText('仕様を見直します。日本語');
  await expect(frame.locator('.inline-review [data-review]')).toBeEnabled();
  await save();
  const savedJapanese = await readFile(path, 'utf8');
  expect(savedJapanese).toBe(changed.replace('仕様を見直します。', '仕様を見直します。日本語'));
  console.log('EDITING_CHECK', checks.length + 1);
  checks.push('Chromium IME composition preserves review DOM and guards save until commit');

  // Type inside a colored table cell, then restore the unsaved draft by reopening the panel.
  await selectEnd('.ProseMirror td p >> nth=1');
  await compose('にほんご'); await compose('日本語'); await commit('日本語');
  await expect(frame.locator('.ProseMirror td').nth(1)).toHaveText('確認日本語');
  await expect(frame.locator('.inline-review [data-review]').last()).toBeEnabled();
  await frame.locator('#toggle-source').click();
  const unsaved = await frame.locator('#source-text').inputValue();
  expect(unsaved).toContain('確認日本語</span></mark>');
  expect(await readFile(path, 'utf8')).toBe(savedJapanese);
  await frame.locator('#close-source').click();
  await cdp.detach();
  const request = String(Date.now());
  await writeFile(join(workspace, 'reopen-request'), request);
  await expect.poll(() => readFile(join(workspace, 'reopen-ready'), 'utf8').catch(() => '')).toBe(request);
  await expect(async () => {
    for (const candidate of page.frames()) if (await candidate.locator('#reviewed').count()) frame = candidate;
    await expect(frame.locator('.ProseMirror td').nth(1)).toHaveText('確認日本語');
  }).toPass({ timeout: 15000 });
  await expect(frame.locator('#save-state')).toContainText('編集中');
  await save();
  expect(await readFile(path, 'utf8')).toBe(unsaved);
  console.log('EDITING_CHECK', checks.length + 1);
  checks.push('Japanese input in a colored table cell restores after tab close and saves exact Markdown');
  cdp = await inputSession();
  await frame.evaluate(() => { window.hostUpdates = 0; window.addEventListener('message', event => { if (event.data.type === 'update') window.hostUpdates++; }); });

  await selectEnd('.ProseMirror > p');
  await compose('へんかん');
  await expect(frame.locator('.ProseMirror > p')).toContainText('へんかん');
  let updates = await frame.evaluate(() => window.hostUpdates);
  const external = unsaved.replace('仕様を見直します。日本語', 'AIが外部から更新しました。');
  await writeFile(path, external);
  await expect.poll(() => frame.evaluate(() => window.hostUpdates)).toBeGreaterThan(updates);
  await expect(frame.locator('.ProseMirror > p')).toContainText('へんかん');
  await commit('変換');
  await expect(frame.locator('#conflict')).toBeVisible();
  await expect(frame.locator('.ProseMirror > p')).toHaveText('仕様を見直します。日本語変換');
  await expect(frame.locator('#save')).toBeDisabled();
  expect(await readFile(path, 'utf8')).toBe(external);
  await frame.locator('#discard-draft').click();
  await expect(frame.locator('.ProseMirror > p')).toHaveText('AIが外部から更新しました。');
  console.log('EDITING_CHECK', checks.length + 1);
  checks.push('External edits during composition retain both the Japanese draft and newer file');

  // Cancelled composition must adopt the external update, not leave a false conflict.
  await selectEnd('.ProseMirror > p'); await compose('とりけし');
  await expect(frame.locator('.ProseMirror > p')).toContainText('とりけし');
  updates = await frame.evaluate(() => window.hostUpdates);
  const cancelledExternal = external.replace('AIが外部から更新しました。', '取り消し中の外部更新です。');
  await writeFile(path, cancelledExternal);
  await expect.poll(() => frame.evaluate(() => window.hostUpdates)).toBeGreaterThan(updates);
  await compose('');
  await expect(frame.locator('.ProseMirror > p')).toHaveText('取り消し中の外部更新です。');
  await expect(frame.locator('#conflict')).toBeHidden();
  console.log('EDITING_CHECK', checks.length + 1);
  checks.push('Cancelling composition adopts deferred external edits without false conflict');

  await frame.locator('#toggle-source').click();
  const source = frame.locator('#source-text'); await source.focus();
  await source.evaluate(field => field.setSelectionRange(field.value.length, field.value.length));
  await compose('げんぶん');
  await expect(source).toHaveValue(cancelledExternal + 'げんぶん');
  updates = await frame.evaluate(() => window.hostUpdates);
  const sourceExternal = cancelledExternal.replace('取り消し中の外部更新です。', 'ソース編集中の外部更新です。');
  await writeFile(path, sourceExternal);
  await expect.poll(() => frame.evaluate(() => window.hostUpdates)).toBeGreaterThan(updates);
  await expect(source).toHaveValue(cancelledExternal + 'げんぶん');
  await commit('原文');
  await expect(frame.locator('#conflict')).toBeVisible();
  await expect(source).toHaveValue(cancelledExternal + '原文');
  await expect(frame.locator('#save')).toBeDisabled();
  expect(await readFile(path, 'utf8')).toBe(sourceExternal);
  await frame.locator('#discard-draft').click();
  await expect(source).toHaveValue(sourceExternal);
  await frame.locator('#close-source').click();
  console.log('EDITING_CHECK', checks.length + 1);
  checks.push('Source textarea IME preserves preedit and committed text through external updates');

  const large = Array.from({ length: 500 }, (_, i) => '## 節 ' + i + '\n\n' + '日本語で書かれた設計書の内容を確認します。'.repeat(5) + '\n\n').join('');
  await setSource(large);
  await selectEnd('.ProseMirror > p >> nth=0');
  await frame.evaluate(() => { window.inputFrames = []; document.querySelector('.ProseMirror').addEventListener('input', () => {
    const start = performance.now(); requestAnimationFrame(() => window.inputFrames.push(performance.now() - start));
  }, true); });
  for (const text of ['追記', '日本語', '😊', '確認', '完了']) await commit(text);
  await expect(frame.locator('.ProseMirror > p').first()).toContainText('追記日本語😊確認完了');
  await expect.poll(() => frame.evaluate(() => window.inputFrames.length)).toBe(5);
  await expect(frame.locator('.inline-review [data-review]')).toBeEnabled({ timeout: 15000 });
  await save();
  const expected = large.replace('。\n\n', '。追記日本語😊確認完了\n\n');
  expect(await readFile(path, 'utf8')).toBe(expected);
  const frames = await frame.evaluate(() => window.inputFrames);
  const performance = { bytes: Buffer.byteLength(large), sections: 500, inputToNextFrameMs: frames, maxMs: Math.max(...frames) };
  expect(performance.maxMs).toBeLessThan(1000);
  await writeFile(join(output, 'editing-performance.json'), JSON.stringify(performance, null, 2));
  console.log('EDITING_CHECK', checks.length + 1);
  checks.push('164 KB / 500-section Japanese document accepts sequential input and saves exact source');
  await selectEnd('.ProseMirror > p >> nth=0');
  await compose('つづき'); await commit('続き');
  const switched = '# 入力先の切り替え\n\nソースで入力した最新の本文。\n';
  // Switch within the composition-settling window, before its deferred callback.
  await frame.evaluate(text => {
    document.querySelector('#toggle-source').click();
    const field = document.querySelector('#source-text'); field.focus(); field.value = text;
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }, switched);
  await expect(frame.locator('#source-text')).toHaveValue(switched);
  await expect(frame.locator('.ProseMirror > p').first()).toHaveText('ソースで入力した最新の本文。');
  await expect(frame.locator('.ProseMirror > p')).toHaveCount(1);
  await frame.locator('#close-source').click(); await save();
  expect(await readFile(path, 'utf8')).toBe(switched);
  checks.push('Source input immediately after IME commit wins over delayed rich-editor callbacks');
  await cdp.detach();
  return checks;
}
