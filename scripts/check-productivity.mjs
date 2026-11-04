import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
export async function checkProductivity({page, workspace, path, output}) {
  let frame;
  const checks = [];
  const findFrame = async () => { await expect(async()=>{
    for(const candidate of page.frames()) if(await candidate.locator('#toggle-find').count()) frame=candidate;
    await expect(frame.locator('.ProseMirror')).toBeVisible();
  }).toPass({timeout:15000}); };
  await findFrame();
  const save = async()=>{await frame.locator('#save').click();await expect(frame.locator('#save-state')).toHaveText('保存済み');};
  const source = async text => {
    await frame.locator('#toggle-source').click();await frame.locator('#source-version').selectOption('current');
    await frame.locator('#source-text').fill(text);await frame.locator('#close-source').click();await save();
    if(await frame.locator('#reviewed').isEnabled()){await frame.locator('#reviewed').click();await expect(frame.locator('#counter')).toHaveText('✓ 確認完了');}
  };
  const base='# 作業ツール\n\n## 金額\n\n| 項目 | 値 |\n| --- | --- |\n| A | 10 |\n| B | 20 |\n\n## 用語\n\n日本語と日**本**語。\n\n## 終わり\n\n完了です。\n';
  await source(base);
  const after=base.replace('| 10 |','| 100 |').replace('| 20 |','| 200 |');await writeFile(path,after);
  await expect(frame.locator('.cell-review-controls')).toHaveCount(2);
  await frame.locator('.quick-table').screenshot({path:join(output,'cell-review.png')});
  await frame.locator('[data-cell-action="reviewCell"][data-row="1"]').click();
  await expect(frame.locator('.cell-review-controls')).toHaveCount(1);
  expect(await readFile(path,'utf8')).toBe(after);
  await frame.locator('#toggle-source').click();await frame.locator('#source-version').selectOption('confirmed');
  await expect(frame.locator('#source-text')).toHaveValue(base.replace('| 10 |','| 100 |'));
  await frame.locator('#source-version').selectOption('current');await frame.locator('#close-source').click();
  await frame.locator('#undo-review').click();await expect(frame.locator('.cell-review-controls')).toHaveCount(2);
  await frame.locator('[data-cell-action="revertCell"][data-row="2"]').click();
  await expect(frame.locator('.cell-review-controls')).toHaveCount(1);
  expect(await readFile(path,'utf8')).toBe(after);
  await save();expect(await readFile(path,'utf8')).toBe(base.replace('| 10 |','| 100 |'));
  checks.push('Cell confirmation changes only its baseline; Undo and cell revert preserve other cells and explicit save');
  await frame.locator('#mode-diff').click();await frame.locator('.cell-review-list > summary').click();
  await frame.locator('#document [data-cell-action="reviewCell"]').click();await expect(frame.locator('#counter')).toHaveText('✓ 確認完了');
  await frame.locator('#mode-edit').click();checks.push('Detailed comparison exposes the same cell review actions');
  const beforeDraftCell=await readFile(path,'utf8');
  await frame.locator('.ProseMirror td p').nth(3).fill('21');
  await expect(frame.locator('[data-cell-action="reviewCell"][data-row="2"]')).toBeEnabled();
  await frame.locator('[data-cell-action="reviewCell"][data-row="2"]').click();
  await expect(frame.locator('#counter')).toHaveText('✓ 確認完了');
  expect(await readFile(path,'utf8')).toBe(beforeDraftCell);await expect(frame.locator('#save-state')).toContainText('未保存');await save();
  checks.push('Cell confirmation on an unsaved rich-text draft applies that cell without implicitly saving');


  await frame.locator('#toggle-find').click();await frame.locator('#find-query').fill('日本語');
  await expect(frame.locator('#find-count')).toHaveText('1 / 2');
  await expect(frame.locator('.search-hit')).toHaveCount(4); // second occurrence crosses three marks
  await frame.locator('#replace-text').fill('利用者');await frame.locator('#replace-all').click();
  await expect(frame.locator('#find-count')).toHaveText('0 / 0');await frame.locator('#find-close').click();
  await frame.locator('[data-format="undo"]').click();await expect(frame.locator('.ProseMirror')).toContainText('日本語と日本語。');
  await frame.locator('[data-format="redo"]').click();await expect(frame.locator('.ProseMirror')).toContainText('利用者と利用者。');
  expect(await readFile(path,'utf8')).toContain('日**本**語');
  await save();expect(await readFile(path,'utf8')).toContain('利用者と利用者。');
  checks.push('Literal find crosses inline marks; replace all is one Undo action and stays a draft until saved');
  await frame.locator('#toggle-find').click();await frame.locator('#find-query').fill('利用者');await frame.locator('#find-changes').check();
  await expect(frame.locator('#find-count')).toHaveText('1 / 2');
  await frame.locator('#toggle-outline').click();await expect(frame.locator('.outline-item').filter({hasText:'用語'})).toContainText('1');
  await page.screenshot({path:join(output,'search-outline.png')});await frame.locator('#outline-close').click();
  await frame.locator('#find-query').fill('完了');await expect(frame.locator('#find-count')).toHaveText('0 / 0');
  await frame.locator('#find-changes').uncheck();await expect(frame.locator('#find-count')).toHaveText('1 / 1');
  await frame.locator('#find-close').click();checks.push('Changes-only search excludes unchanged text');

  await frame.locator('#fold-all').click();await frame.locator('#toggle-outline').click();
  await expect(frame.locator('.outline-item')).toHaveCount(4);
  await expect(frame.locator('.outline-item').filter({hasText:'用語'})).toContainText('1');
  await frame.locator('.outline-item').filter({hasText:'用語'}).click();
  await expect(frame.locator('.ProseMirror > p').filter({hasText:'利用者'})).toBeVisible();
  await frame.locator('#outline-close').click();await frame.locator('#unfold-all').click();
  checks.push('Outline includes nested headings and unreviewed counts; jumping reveals a folded section');

  await frame.locator('.ProseMirror > p').last().click();await page.keyboard.press('End');
  const beforeImage=await readFile(path,'utf8');
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1xkAAAAASUVORK5CYII=';
  await frame.evaluate(data=>{
    const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'clipboard.png',{type:'image/png'}));
    document.querySelector('.ProseMirror').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  },png);
  await expect(frame.locator('.ProseMirror img.markdown-image')).toHaveCount(1);
  await expect.poll(()=>frame.locator('.ProseMirror img.markdown-image').evaluate(img=>img.complete&&img.naturalWidth===1)).toBe(true);
  expect(await readFile(path,'utf8')).toBe(beforeImage);await save();
  await page.screenshot({path:join(output,'image-paste.png')});
  const withImage=await readFile(path,'utf8'), imagePath=withImage.match(/\.\/\.markdown-lens-images\/[a-f0-9-]+\.png/)?.[0];expect(imagePath).toBeTruthy();
  expect(await readFile(join(dirname(path),imagePath))).toEqual(Buffer.from(png,'base64'));
  await frame.locator('[data-format="undo"]').click();await expect(frame.locator('.ProseMirror img.markdown-image')).toHaveCount(0);
  await frame.locator('[data-format="redo"]').click();await expect(frame.locator('.ProseMirror img.markdown-image')).toHaveCount(1);
  checks.push('Clipboard image bytes save locally, render inline, persist as a relative path and support Undo/Redo');
  await frame.locator('#toggle-source').click();
  await frame.locator('#source-text').evaluate((field,data)=>{
    field.focus();field.setSelectionRange(field.value.length,field.value.length);
    const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],'clipboard.png',{type:'image/png'}));
    field.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  },png);
  await expect.poll(async()=>((await frame.locator('#source-text').inputValue()).match(/\.markdown-lens-images/g)??[]).length).toBe(2);
  await frame.locator('#close-source').click();await save();
  const twoImages=(await readFile(path,'utf8')).match(/\.\/\.markdown-lens-images\/[a-f0-9-]+\.png/g);
  expect(new Set(twoImages).size).toBe(2);
  for(const file of twoImages)expect(await readFile(join(dirname(path),file))).toEqual(Buffer.from(png,'base64'));
  checks.push('Source-pane image paste inserts at the captured caret and saves a distinct local file');


  const long='# 復元\n\n'+Array.from({length:30},(_,i)=>`## 節 ${i}\n\n日本語の本文 ${i}。\n\n`).join('');await source(long);
  await frame.getByRole('button',{name:'「節 20」を折りたたむ',exact:true}).click();
  await frame.locator('.ProseMirror h2').nth(19).scrollIntoViewIfNeeded();
  const previousY=await frame.evaluate(()=>scrollY);expect(previousY).toBeGreaterThan(1000);
  // Let the scroll event's rAF persist its bookmark before the host closes the tab.
  await frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const request=String(Date.now());await writeFile(join(workspace,'reopen-request'),request);
  await expect.poll(()=>readFile(join(workspace,'reopen-ready'),'utf8').catch(()=>'' )).toBe(request);await findFrame();
  await expect(frame.getByRole('button',{name:'「節 20」を展開',exact:true})).toHaveCount(1);
  await expect.poll(()=>frame.evaluate(()=>scrollY)).toBeGreaterThan(1000);
  expect(Math.abs((await frame.evaluate(()=>scrollY))-previousY)).toBeLessThan(120);
  expect(await readFile(path,'utf8')).toBe(long);checks.push('Closing and reopening restores per-file fold state and reading position without modifying Markdown');
  await frame.locator('#toggle-find').click();await frame.locator('#find-query').fill('日本語');
  for(const width of [1100,360]){
    await page.setViewportSize({width,height:900});await expect(frame.locator('#find-panel')).toBeVisible();
    expect(await frame.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)).toBe(false);
    await page.screenshot({path:join(output,`productivity-${width}.png`)});
  }
  checks.push('Search and outline controls fit both 1100px and 360px layouts');
  await frame.locator('#find-close').click();
  return checks;
}
