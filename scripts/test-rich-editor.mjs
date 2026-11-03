import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const folder = resolve('test-results/rich-browser'); await mkdir(folder, { recursive: true });
await build({ stdin: { contents: `import {RichEditor} from './src/rich-editor'; import 'prosemirror-view/style/prosemirror.css'; window.loadEditor=(text)=>{if(window.richEditor) {window.richEditor.load(text);return;} window.richEditor=new RichEditor(document.getElementById('editor'),text,()=>{window.changed=(window.changed??0)+1});};`, resolveDir: resolve('.') }, bundle: true, platform: 'browser', outfile: join(folder, 'rich.js') });
await copyFile('media/review.css', join(folder, 'review.css'));
await writeFile(join(folder, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="review.css"><link rel="stylesheet" href="rich.css"><body class="vscode-light"><select id="block-type"></select><select id="table-action"></select><main id="editor" class="document"></main><script src="rich.js"></script>');
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
 expect(errors).toEqual([]);
 console.log('RICH_EDITOR_BROWSER passed');
} finally { await browser.close(); }
