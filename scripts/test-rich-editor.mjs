import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const folder = resolve('test-results/rich-browser'); await mkdir(folder, { recursive: true });
await build({ stdin: { contents: `import {RichEditor} from './src/rich-editor'; import {colorToolbar} from './src/color-toolbar'; document.getElementById('formatting').insertAdjacentHTML('beforeend',colorToolbar()); import {detailFolding} from './src/detail-folding'; window.detailFolding=detailFolding; import 'prosemirror-view/style/prosemirror.css'; window.loadEditor=(text)=>{if(window.richEditor) {window.richEditor.load(text);return;} window.richEditor=new RichEditor(document.getElementById('editor'),text,()=>{window.changed=(window.changed??0)+1});};`, resolveDir: resolve('.') }, bundle: true, platform: 'browser', outfile: join(folder, 'rich.js') });
await copyFile('media/review.css', join(folder, 'review.css'));
await writeFile(join(folder, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="review.css"><link rel="stylesheet" href="rich.css"><body class="vscode-light"><div id="formatting" class="formatting"><select id="block-type"></select><select id="table-action"></select></div><main id="editor" class="document"></main><script src="rich.js"></script>');
const browser = await chromium.launch(process.env.CI ? { headless: true } : { headless: true, channel: 'chrome' });
try {
 const page = await browser.newPage(); const errors = []; page.on('pageerror', e=>errors.push(e.message));
 await page.goto(pathToFileURL(join(folder, 'index.html')).href);
 const source = '# Demo\n\n```mermaid\nflowchart LR\nA[開始] --> B[完了]\n```\n\n- [ ] task\n';
 await page.evaluate(s=>window.loadEditor(s), source);
 await expect(page.locator('.diagram-canvas svg')).toHaveCount(1, { timeout: 20000 });
 await page.locator('.rich-code-source > summary').click();
 await page.locator('.rich-code-source code').fill('flowchart LR\nA[開始] --> C[更新]');
 await expect.poll(()=>page.evaluate(()=>window.richEditor.text)).toContain('C[更新]');
 await expect(page.locator('.diagram-canvas .node')).toContainText(['開始', '更新']);
 await page.locator('input[data-task]').check();
 await expect.poll(()=>page.evaluate(()=>window.richEditor.text)).toContain('[x] task');
 await page.evaluate(()=>window.richEditor.command('undo'));
 await expect(page.locator('input[data-task]')).not.toBeChecked();
 const tableSource = '# Table\n\n| Name | Value |\n| :--- | ---: |\n| Alpha | 10 |\n| Beta | 20 |\n| Gamma | 30 |\n';
 await page.evaluate(s=>window.loadEditor(s),tableSource);
 await expect(page.getByRole('button',{name:'行を上へ移動',exact:true})).toBeDisabled();
 await page.locator('.ProseMirror tr').nth(2).locator('td p').nth(1).click();
 await expect(page.locator('.quick-table-position')).toHaveText('2行目 · 2列目');
 await page.getByRole('button',{name:'行を上へ移動',exact:true}).click();
 await expect(page.locator('.ProseMirror tr').nth(1)).toContainText('Beta');
 await expect(page.getByRole('button',{name:'行を上へ移動',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'列を左へ移動',exact:true}).click();
 await expect(page.locator('.ProseMirror th').first()).toHaveText('Value');
 await expect(page.locator('.ProseMirror td').first()).toHaveText('20');
 await expect.poll(()=>page.evaluate(()=>window.richEditor.text)).toContain('| ---: | :--- |');
 await page.getByRole('button',{name:'下に行を追加',exact:true}).click();
 await expect(page.locator('.ProseMirror tr')).toHaveCount(5);
 await page.keyboard.type('new value');
 await expect(page.locator('.ProseMirror tr').nth(2)).toContainText('new value');
 await page.getByRole('button',{name:'右に列を追加',exact:true}).click();
 await expect(page.locator('.ProseMirror th')).toHaveCount(3);
 await page.keyboard.type('new cell');
 await expect.poll(()=>page.evaluate(()=>window.richEditor.text)).toContain('new cell');
 await page.evaluate(()=>window.richEditor.enable(false));
 for (const button of await page.locator('[data-table-quick]').all()) await expect(button).toBeDisabled();
 await page.evaluate(()=>window.richEditor.enable(true));
 await page.getByRole('button',{name:'末尾に列を追加',exact:true}).click();
 await expect(page.locator('.ProseMirror th')).toHaveCount(4);
 await page.evaluate(()=>window.richEditor.command('undo'));
 await expect(page.locator('.ProseMirror th')).toHaveCount(3);
 // A second table's edge control must not act on the table containing the caret.
 await page.evaluate(s=>window.loadEditor(s+'\n| Other |\n| --- |\n| second |\n'),tableSource);
 await page.locator('.quick-table').first().locator('td p').first().click();
 await page.locator('.quick-table').last().getByRole('button',{name:'末尾に行を追加',exact:true}).click();
 await expect(page.locator('.quick-table').first().locator('tr')).toHaveCount(4);
 await expect(page.locator('.quick-table').last().locator('tr')).toHaveCount(3);
 await page.locator('.quick-table').first().locator('td p').first().click();
 for (const width of [1100,360]) {
  await page.setViewportSize({width,height:900});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)).toBe(false);
  await expect(page.getByRole('button',{name:'行を下へ移動',exact:true}).first()).toBeVisible();
  await page.screenshot({path:join(folder,`quick-table-${width}.png`)});
 }
 const numberedSource = '| No | ID | Name |\n| --- | --- | --- |\n| 7 | 101 | Alpha |\n| 9 | 205 | Beta |\n| 20 | 999 | Gamma |\n';
 await page.setViewportSize({width:1100,height:900});
 await page.evaluate(s=>window.loadEditor(s),numberedSource);
 await page.locator('.ProseMirror tr').nth(1).locator('td p').first().click();
 await page.getByRole('button',{name:'この列の自動採番を切り替え（1から連番）',exact:true}).click();
 await expect(page.locator('.ProseMirror tr').nth(3).locator('td').first()).toHaveText('3');
 await page.locator('.ProseMirror tr').nth(2).locator('td p').nth(2).click();
 await page.getByRole('button',{name:'選択した行を削除',exact:true}).click();
 await expect(page.locator('.ProseMirror tr')).toHaveCount(3);
 await expect(page.locator('.ProseMirror tr').nth(2).locator('td').first()).toHaveText('2');
 await expect(page.locator('.ProseMirror tr').nth(2).locator('td').nth(1)).toHaveText('999');
 await page.evaluate(()=>window.richEditor.command('undo'));
 await expect(page.locator('.ProseMirror tr')).toHaveCount(4);
 await expect(page.locator('.ProseMirror tr').nth(2)).toContainText('Beta');
 await page.getByRole('button',{name:'行を下へ移動',exact:true}).click();
 await expect(page.locator('.ProseMirror tr').nth(3).locator('td').first()).toHaveText('3');
 await expect(page.locator('.ProseMirror tr').nth(3)).toContainText('Beta');
 await page.getByRole('button',{name:'選択した列を削除',exact:true}).click();
 await expect(page.locator('.ProseMirror th')).toHaveCount(2);
 await expect(page.locator('.ProseMirror th').first()).toHaveText('No');
 await page.screenshot({path:join(folder,'numbering-and-delete.png')});
 // Exercise every formatting family on the same editor used by both hosts.
 for (const [command, selector, marker] of [
  ['bold','strong','**word**'], ['italic','em','*word*'], ['strike','s','~~word~~'], ['inlineCode','code','`word`'],
  ['bullet','ul','word'], ['number','ol','word'], ['quote','blockquote','> word'],
  ...Array.from({length:6},(_,i)=>['h'+(i+1),'h'+(i+1),'#'.repeat(i+1)+' word']),
 ]) {
  await page.evaluate(()=>{ window.loadEditor('word\n'); const e=window.richEditor; e.view.dispatch(e.view.state.tr.setSelection(e.view.state.selection.constructor.create(e.view.state.doc,1,5))); });
  await page.evaluate(c=>window.richEditor.command(c),command);
  await expect(page.locator('.ProseMirror '+selector).first()).toContainText('word');
  expect(await page.evaluate(()=>window.richEditor.text)).toContain(marker);
  await page.evaluate(()=>window.richEditor.command('undo'));
  expect(await page.evaluate(()=>window.richEditor.text)).toBe('word\n');
  await page.evaluate(()=>window.richEditor.command('redo'));
  expect(await page.evaluate(()=>window.richEditor.text)).toContain(marker);
 }
 await page.evaluate(()=>window.richEditor.command('paragraph'));
 await expect(page.locator('.ProseMirror > p')).toHaveText('word');
 await page.evaluate(()=>{window.loadEditor('word\n');const e=window.richEditor;e.view.dispatch(e.view.state.tr.setSelection(e.view.state.selection.constructor.create(e.view.state.doc,1,5)));});
 expect(await page.evaluate(()=>window.richEditor.link('https://example.com/a'))).toBe(true);
 await expect(page.locator('.ProseMirror a')).toHaveAttribute('data-href','https://example.com/a');
 expect(await page.locator('.ProseMirror a').getAttribute('href')).toBeNull();
 expect(await page.evaluate(()=>window.richEditor.link('javascript:alert(1)'))).toBe(false);
 expect(await page.evaluate(()=>window.richEditor.link(''))).toBe(true);
 await expect(page.locator('.ProseMirror a')).toHaveCount(0);
 expect(await page.evaluate(()=>window.richEditor.image('javascript:alert(1)','bad'))).toBe(false);
 expect(await page.evaluate(()=>window.richEditor.image('./diagram.png','構成図'))).toBe(true);
 expect(await page.evaluate(()=>window.richEditor.text)).toContain('![構成図](./diagram.png)');
 await expect(page.locator('.rich-image')).toContainText('構成図');
 await expect(page.locator('.rich-image img')).toHaveCount(0); // unresolved paths never load directly
 for (const [command,selector] of [['rule','hr'],['table','table'],['mermaid','.diagram-canvas svg'],['task','input[data-task]']]) {
  await page.evaluate(()=>window.loadEditor('word\n'));
  await page.evaluate(c=>window.richEditor.command(c),command);
  await expect(page.locator('.ProseMirror '+selector)).toHaveCount(1,{timeout:20000});
  await page.evaluate(()=>window.richEditor.command('undo'));
  expect(await page.evaluate(()=>window.richEditor.text)).toBe('word\n');
 }
 // Use the actual palette, preserving the selected range while its controls take focus.
 const selectWords = async () => page.evaluate(() => {
  const e=window.richEditor; let pos=0; e.view.state.doc.descendants((n,p)=>{if(n.isText && n.text.includes('重要な仕様')) pos=p+n.text.indexOf('重要な仕様');});
  e.view.dispatch(e.view.state.tr.setSelection(e.view.state.selection.constructor.create(e.view.state.doc,pos,pos+5))); e.view.focus();
 });
 await page.evaluate(()=>window.loadEditor('# 色付きの設計書\n\nこれは重要な仕様です。\n'));
 await expect(page.getByRole('button',{name:'文字色',exact:true})).toBeDisabled();
 await selectWords();
 await page.getByRole('button',{name:'文字色',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'文字色',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'文字色：青',exact:true}).click();
 await expect(page.locator('.ProseMirror [data-md-color]')).toHaveText('重要な仕様');
 await expect(page.locator('.ProseMirror [data-md-color]')).toHaveCSS('color','rgb(57, 132, 213)');
 await page.getByRole('button',{name:'マーカー',exact:true}).click();
 await page.getByRole('button',{name:'マーカー：黄',exact:true}).click();
 await expect(page.locator('.ProseMirror mark')).toHaveText('重要な仕様');
 await expect(page.locator('.ProseMirror mark span')).toHaveCSS('color','rgb(57, 132, 213)');
 const colored=await page.evaluate(()=>window.richEditor.text);
 expect(colored).toContain('<mark style="background-color:#fff2a8"><span style="color:#3984d5">重要な仕様</span></mark>');
 await page.evaluate(()=>window.richEditor.command('undo'));
 await expect(page.locator('.ProseMirror mark')).toHaveCount(0);
 await expect(page.locator('.ProseMirror [data-md-color]')).toHaveCount(1);
 await page.evaluate(()=>window.richEditor.command('redo'));
 await expect(page.locator('.ProseMirror mark')).toHaveCount(1);
 await page.evaluate(s=>window.loadEditor(s),colored); await selectWords();
 await page.getByRole('button',{name:'文字色',exact:true}).click();
 await page.getByRole('textbox',{name:'カラーコード',exact:true}).fill('#7f248b');
 await page.getByRole('button',{name:'適用',exact:true}).click();
 await expect(page.locator('.ProseMirror [data-md-color]')).toHaveCSS('color','rgb(127, 36, 139)');
 await page.getByRole('button',{name:'文字色',exact:true}).click();
 await page.getByRole('button',{name:'文字色を解除',exact:true}).click();
 await expect(page.locator('.ProseMirror [data-md-color]')).toHaveCount(0);
 await expect(page.locator('.ProseMirror mark')).toHaveCount(1);
 for(const width of [1100,360]) {
  await page.setViewportSize({width,height:800});
  await selectWords(); await page.getByRole('button',{name:'マーカー',exact:true}).click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)).toBe(false);
  const bounds=await page.locator('#color-palette').boundingBox(); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x+bounds.width).toBeLessThanOrEqual(width);
  await page.screenshot({path:join(folder,`text-colors-${width}.png`)});
  await page.keyboard.press('Escape'); await expect(page.locator('#color-palette')).toBeHidden();
  await expect(page.getByRole('button',{name:'マーカー',exact:true})).toBeFocused();
 }
 await page.getByRole('button',{name:'マーカー',exact:true}).click();
 await page.evaluate(()=>window.richEditor.enable(false));
 await expect(page.locator('#color-palette')).toBeHidden();
 await expect(page.getByRole('button',{name:'マーカー',exact:true})).toBeDisabled();
 await page.evaluate(()=>window.richEditor.enable(true));
 await page.getByRole('button',{name:'マーカー',exact:true}).click();
 await page.evaluate(()=>window.loadEditor('external update\n'));
 await expect(page.locator('#color-palette')).toBeHidden();
 await expect(page.locator('.ProseMirror mark')).toHaveCount(0);
 await page.setViewportSize({width:1100,height:900});
 // Real Chromium composition events retain the active DOM while preedit text changes.
 const imeSource='# 日本語\n\n新しい本文\n';
 await page.evaluate(source=>{
  window.loadEditor(source); const e=window.richEditor;
  e.review(source,[{id:'ime',start:7,end:source.length,oldStart:7,oldEnd:source.length,before:'元の本文\n',after:'新しい本文\n'}],'');
  window.imeCard=document.querySelector('.inline-review');
  e.view.dispatch(e.view.state.tr.setSelection(e.view.state.selection.constructor.atEnd(e.view.state.doc)));e.view.focus();
 },imeSource);
 const cdp=await page.context().newCDPSession(page);
 await cdp.send('Input.imeSetComposition',{text:'にほんご',selectionStart:4,selectionEnd:4});
 await expect.poll(()=>page.evaluate(()=>window.richEditor.text)).toContain('にほんご');
 expect(await page.evaluate(()=>window.richEditor.composing && window.imeCard.isConnected)).toBe(true);
 await page.evaluate(()=>window.richEditor.command('bold'));
 expect(await page.evaluate(()=>window.richEditor.text)).not.toContain('**');
 await cdp.send('Input.imeSetComposition',{text:'日本語',selectionStart:3,selectionEnd:3});
 await cdp.send('Input.insertText',{text:'日本語'});
 await expect.poll(()=>page.evaluate(()=>window.richEditor.composing)).toBe(false);
 expect(await page.evaluate(()=>window.richEditor.text)).toBe('# 日本語\n\n新しい本文日本語\n');
 await page.evaluate(()=>window.richEditor.command('undo'));
 expect(await page.evaluate(()=>window.richEditor.text)).toBe(imeSource);
 await page.evaluate(()=>window.richEditor.command('redo'));
 expect(await page.evaluate(()=>window.richEditor.text)).toBe('# 日本語\n\n新しい本文日本語\n');
 await page.evaluate(()=>{const e=window.richEditor;e.view.dispatch(e.view.state.tr.setSelection(e.view.state.selection.constructor.atEnd(e.view.state.doc)));e.view.focus();});
 await cdp.send('Input.imeSetComposition',{text:'とりけし',selectionStart:4,selectionEnd:4});
 await expect.poll(()=>page.evaluate(()=>window.richEditor.text)).toContain('とりけし');
 await cdp.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});
 await expect.poll(()=>page.evaluate(()=>window.richEditor.composing)).toBe(false);
 expect(await page.evaluate(()=>window.richEditor.text)).toBe('# 日本語\n\n新しい本文日本語\n');
 // Reading derived editor state repeatedly must not mutate Markdown, selection or history.
 const largeSource=Array.from({length:500},(_,i)=>'## 節 '+i+'\n\n'+('日本語で書かれた設計書の内容を確認します。'.repeat(5))+'\n\n').join('');
 await page.evaluate(source=>window.loadEditor(source),largeSource);
 const performanceResult=await page.evaluate(()=>{
  const e=window.richEditor, start=performance.now();
  for(let i=0;i<100;i++){void e.text;void e.sectionCount;void e.numbering;}
  return {bytes:new TextEncoder().encode(e.text).length,paragraphs:e.view.state.doc.childCount,reads100ms:performance.now()-start};
 });
 expect(await page.evaluate(()=>window.richEditor.text)).toBe(largeSource);
 await writeFile(join(folder,'performance.json'),JSON.stringify(performanceResult,null,2));
 await cdp.detach();
 // Nested sections, review widgets, source preservation and keyboard editing after folding.
 const foldSource = '# 設計書\n\n概要\n\n## 認証\n\n期限は24時間\n\n### 設定\n\n| 項目 | 値 |\n| --- | --- |\n| 期限 | 24時間 |\n\n```mermaid\nflowchart LR\nA --> B\n```\n\n## API\n\n公開API\n';
 await page.evaluate(s=>window.loadEditor(s),foldSource);
 await page.locator('.ProseMirror > p').nth(1).click();
 await page.getByRole('button',{name:'「認証」を折りたたむ',exact:true}).click();
 await expect(page.locator('.quick-table')).toBeHidden();
 await expect(page.locator('.rich-code-source')).toBeHidden();
 await expect(page.locator('.ProseMirror > p').last()).toBeVisible();
 expect(await page.evaluate(()=>window.richEditor.text)).toBe(foldSource);
 await page.getByRole('button',{name:'「認証」を展開',exact:true}).click();
 await expect(page.locator('.quick-table')).toBeVisible();
 await page.getByRole('button',{name:'「設定」を折りたたむ',exact:true}).click();
 await page.getByRole('button',{name:'「認証」を折りたたむ',exact:true}).click();
 await page.getByRole('button',{name:'「認証」を展開',exact:true}).click();
 await expect(page.getByRole('button',{name:'「設定」を展開',exact:true})).toBeVisible();
 await expect(page.locator('.quick-table')).toBeHidden();
 await page.evaluate(()=>window.richEditor.foldAll(false));
 await page.locator('.ProseMirror > p').last().fill('編集後のAPI');
 await page.evaluate(()=>window.richEditor.foldAll(true));
 await page.evaluate(()=>window.richEditor.foldAll(false));
 await page.evaluate(()=>window.richEditor.command('undo'));
 expect(await page.evaluate(()=>window.richEditor.text)).toBe(foldSource);
 await page.getByRole('button',{name:'「認証」を折りたたむ',exact:true}).click();
 // Selection navigation must reveal a folded paragraph instead of editing invisibly.
 await page.evaluate(()=>{ const e=window.richEditor; const heading=[...e.view.dom.querySelectorAll('h2')][0]; const pos=e.view.posAtDOM(heading,heading.childNodes.length); e.view.dispatch(e.view.state.tr.setSelection(e.view.state.selection.constructor.near(e.view.state.doc.resolve(pos+2)))); });
 await expect(page.locator('.ProseMirror > p').nth(1)).toBeVisible();
 // Detailed comparison can span multiple wrappers and ignore the old version's headings.
 await page.evaluate(()=>{
   const host=document.createElement('main'); host.id='detail-test';host.className='document';document.body.append(host);
   host.innerHTML='<details class="unchanged" open><summary>unchanged</summary><div><h1>設計書</h1><p>intro</p><h2>認証</h2></div></details><section data-hunk="one" class="change"><div class="change-content"><p>new</p></div><div class="change-actions"><button>review</button></div></section><details class="unchanged" open><summary>unchanged</summary><div><h3>設定</h3><p>settings</p><h2>API</h2><p>api</p></div></details><section class="change" data-hunk="two"><div class="before-block"><h2>OLD</h2></div><div class="after-block"><h2>New</h2><p>new heading body</p></div></section>';
   window.detail=window.detailFolding(host,[],()=>{});
 });
 await page.locator('#detail-test').getByRole('button',{name:'「認証」を折りたたむ',exact:true}).click();
 await expect(page.locator('#detail-test [data-hunk="one"]')).toBeHidden();
 await expect(page.locator('#detail-test h2').filter({hasText:'API'})).toBeVisible();
 await expect(page.locator('#detail-test .section-fold-count')).toContainText(['1件']);
 await page.evaluate(()=>window.detail.reveal(document.querySelector('#detail-test [data-hunk="one"]')));
 await expect(page.locator('#detail-test [data-hunk="one"]')).toBeVisible();
 await expect(page.locator('#detail-test .before-block .section-toggle')).toHaveCount(0);
 await page.evaluate(()=>document.querySelector('#detail-test').remove());
 await page.getByRole('button',{name:'「認証」を折りたたむ',exact:true}).click();
 await page.screenshot({path:join(folder,'heading-folding.png')});
 expect(errors).toEqual([]);
 await writeFile(join(folder,'result.json'),JSON.stringify({passed:true,checks:['Chromium IME preedit preserves review DOM, commits Japanese, cancels cleanly and supports Undo/Redo', '164 KB document retains exact source across cached derived-state reads', 'Text color and marker palettes preserve selection and combine styles', 'Color save/reload, custom hex, independent removal and Undo/Redo', 'Color palette keyboard dismissal, narrow layout and stale selection guards', 'Mermaid editing and live preview','Task editing and Undo','Selected row and column quick moves','Header and data stay together','Column alignment follows column','Insert and immediately type into new row/cell','Disabled editor prevents table actions','One-action Undo','Edge controls target the correct table','1100px and 360px without document overflow','Opt-in numbering after row deletion and reorder preserves IDs','Row deletion and renumbering Undo together','Column deletion removes header and body cells','Nested heading folds cover tables and Mermaid', 'Folding preserves exact Markdown and does not enter Undo history', 'Keyboard entry reveals hidden content', 'Detailed comparison folds across review wrappers and navigation reveals changes', 'All heading levels, paragraph, emphasis, lists and quotes with Undo/Redo', 'Link insertion and removal; unsafe links rejected and navigation inert', 'Image insertion rejects executable schemes and unresolved paths stay inert', 'Rule, table, Mermaid and task insertion with Undo', 'No renderer exceptions']},null,2));
 console.log('RICH_EDITOR_BROWSER passed');
} finally { await browser.close(); }
