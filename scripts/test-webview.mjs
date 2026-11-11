// The complete webview (shell markup + bundled UI) against a simulated extension host.
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, copyFile, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const folder = resolve('test-results/webview'); await mkdir(folder, { recursive: true });
await build({ stdin: { contents: `export { buildReview } from './src/core'; export { shellHtml } from './src/shell'; export { setLocale } from './src/i18n';`, resolveDir: resolve('.'), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(folder, 'host.mjs'), logLevel: 'error' });
await build({ entryPoints: ['src/webview.ts'], bundle: true, outfile: join(folder, 'webview.js'), platform: 'browser', target: 'chrome120', format: 'iife', logLevel: 'error',
  loader: { '.woff2': 'file', '.woff': 'empty', '.ttf': 'empty' }, assetNames: 'fonts/[name]-[hash]' });
await copyFile('media/review.css', join(folder, 'review.css'));
const host = await import(pathToFileURL(join(folder, 'host.mjs')).href);

async function page(locale) {
  host.setLocale(locale);
  const nonce = 'test' + locale;
  const html = host.shellHtml({ cspSource: "file: 'self'", nonce, css: 'review.css', editorCss: 'webview.css', script: 'webview.js' })
    .replace(`<script nonce="${nonce}"`, `<script nonce="${nonce}">window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.__posted.push(JSON.parse(JSON.stringify(m))),setState:s=>{window.__state=s},getState:()=>window.__state});</script><script nonce="${nonce}"`);
  const file = join(folder, `index-${locale}.html`);
  await writeFile(file, html.replace('<body>', '<body class="vscode-light">'));
  return pathToFileURL(file).href;
}
function state(before, after, extra = {}) {
  const review = host.buildReview(before, after);
  return { uri: 'file:///work/doc.md', name: 'doc.md', html: review.html, revision: review.revision, count: review.hunks.length, hunks: review.hunks,
    baselineMarkdown: before, confirmedMarkdown: before, updatedAt: new Date().toISOString(), dirty: false, markdown: after, settings: { math: true, maxBytes: 524288 }, ...extra };
}
const before = `---
title: Design
owner: team
---

# Overview

This paragraph is
hard-wrapped across lines.

> [!WARNING]
> Check the settings.

Euler $e^{i\\pi}+1=0$ and a note[^1]. Press <kbd>K</kbd>.

$$
\\sum_{i=1}^n x_i
$$

See [setup](#setup), [guide](./guide.md), [[Other Page]] and https://example.com.

## Setup

[^1]: The note.
`;
const after = before.replace('Check the settings.', 'Check the new settings.');

const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : process.env.CI ? { headless: true } : { headless: true, channel: 'chrome' });
const posted = p => p.evaluate(() => window.__posted);
const send = (p, message) => p.evaluate(m => window.postMessage(m, '*'), message);
try {
  const p = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = []; p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(await page('ja'));
  await expect.poll(() => posted(p).then(m => m.some(x => x.type === 'ready'))).toBe(true);
  await send(p, { type: 'update', state: state(before, after) });
  // Syntax renders as content, not escaped text.
  await expect(p.locator('.raw-block-view.raw-frontmatter th').first()).toHaveText('title');
  await expect(p.locator('.ProseMirror .katex')).toHaveCount(2);
  await expect(p.locator('.ProseMirror [data-alert="warning"]')).toHaveText('警告');
  await expect(p.locator('.ProseMirror sup.raw-footnote')).toHaveText('1');
  await expect(p.locator('.ProseMirror .raw-html').first()).toHaveText('<kbd>');
  await expect(p.locator('.ProseMirror .wiki-link')).toHaveText('Other Page');
  await expect(p.locator('.ProseMirror .md-autolink')).toHaveText('https://example.com');
  const alertColor = await p.locator('.ProseMirror blockquote').evaluate(el => getComputedStyle(el).borderLeftColor);
  expect(alertColor).toBe('rgb(210, 153, 34)');
  // One change card for the edited quote; confirming posts that hunk.
  await expect(p.locator('.inline-review')).toHaveCount(1);
  await p.locator('.inline-review .confirm-change').click({ force: true });
  await expect.poll(() => posted(p).then(m => m.find(x => x.type === 'reviewHunk')?.id)).toBeTruthy();
  await send(p, { type: 'update', state: state(after, after) });
  await expect(p.locator('#empty')).toBeVisible();
  // ⌘/Ctrl+click opens links through the host; in-document anchors scroll locally.
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await p.locator('.ProseMirror a[data-href="./guide.md"]').click({ modifiers: [modifier] });
  await p.locator('.ProseMirror .wiki-link').click({ modifiers: [modifier] });
  await p.locator('.ProseMirror .md-autolink').click({ modifiers: [modifier] });
  await p.locator('.ProseMirror a[data-href="#setup"]').click({ modifiers: [modifier] });
  await p.locator('.ProseMirror a[data-href="./guide.md"]').click();
  const links = (await posted(p)).filter(m => m.type === 'openLink');
  expect(links).toEqual([{ type: 'openLink', href: './guide.md' }, { type: 'openLink', wiki: 'Other Page' }, { type: 'openLink', href: 'https://example.com' }]);
  // Footnote reference jumps to its definition.
  await p.locator('.ProseMirror sup.raw-footnote').click({ modifiers: [modifier] });
  await expect.poll(() => p.evaluate(() => { const s = window.getSelection(); return s?.anchorNode?.parentElement?.closest('p')?.textContent ?? document.activeElement?.className; })).toBeTruthy();
  // Host-validated broken links are marked and counted.
  await send(p, { type: 'links', broken: { './guide.md': 'リンク先のファイルが見つかりません' } });
  await expect(p.locator('.ProseMirror .broken-link')).toHaveCount(1);
  await p.locator('#more-tools').click();
  await expect(p.locator('#link-status')).toHaveText('⚠ リンク切れ 1件');
  // Review-wide host commands from the ⋯ menu.
  await p.locator('#text-diff').click();
  await p.locator('#more-tools').click(); await p.locator('#export-summary').click();
  expect((await posted(p)).filter(m => m.type === 'hostCommand').map(m => m.command)).toEqual(['textDiff', 'exportSummary']);
  // Raw inline syntax is edited as Markdown and saved verbatim.
  await p.locator('.ProseMirror .raw-math .katex-html').first().dblclick();
  await expect(p.locator('#raw-form')).toBeVisible();
  await expect(p.locator('#raw-source')).toHaveValue('$e^{i\\pi}+1=0$');
  await p.locator('#raw-source').fill('$a_1 * b_2$');
  await p.locator('#raw-form button[type=submit]').click();
  await expect.poll(() => posted(p).then(m => m.filter(x => x.type === 'draft').at(-1)?.text ?? '')).toContain('Euler $a_1 * b_2$ and');
  // Typing keeps hard wraps and turns **text** into bold.
  await p.locator('.ProseMirror p', { hasText: 'This paragraph is' }).click();
  await p.keyboard.press('End'); await p.keyboard.type(' **bold**');
  const draft = await posted(p).then(m => m.filter(x => x.type === 'draft').at(-1).text);
  expect(draft).toContain('This paragraph is\nhard-wrapped across lines. **bold**');
  expect(draft).toContain('---\ntitle: Design\nowner: team\n---');
  expect(draft).toContain('> [!WARNING]\n> Check the new settings.');
  expect(draft).toContain('Press <kbd>K</kbd>.');
  expect(await p.locator('.ProseMirror strong', { hasText: 'bold' }).count()).toBe(1);
  // Palette commands drive the same controls.
  await send(p, { type: 'update', state: state(before, after.replace('Press', 'Hit')) });
  await send(p, { type: 'command', name: 'next' });
  expect(errors).toEqual([]);

  // Japanese IME: composing in the raw source form never submits it early, and composing
  // next to math and footnotes keeps those raw nodes byte for byte.
  const cdp = await p.context().newCDPSession(p);
  const compose = text => cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  const commit = text => cdp.send('Input.insertText', { text });
  await send(p, { type: 'update', state: state(before, after) });
  await p.locator('.ProseMirror sup.raw-footnote').dblclick();
  await expect(p.locator('#raw-form')).toBeVisible();
  await p.locator('#raw-source').fill('');
  await compose('ちゅう'); await expect(p.locator('#raw-form')).toBeVisible();
  await compose('注'); await commit('注');
  await expect(p.locator('#raw-form')).toBeVisible();
  await expect(p.locator('#raw-source')).toHaveValue('注');
  await p.locator('#raw-source').fill('[^1]注');
  await p.locator('#raw-source').press('Enter');
  await expect(p.locator('#raw-form')).toBeHidden();
  await expect.poll(() => posted(p).then(m => m.filter(x => x.type === 'draft').at(-1)?.text ?? '')).toContain('a note[^1]注. Press');
  const mathParagraph = p.locator('.ProseMirror p', { hasText: 'Euler' });
  await mathParagraph.click(); await p.keyboard.press('End');
  await compose('すうしき'); await compose('数式'); await commit('数式');
  await expect.poll(() => posted(p).then(m => m.filter(x => x.type === 'draft').at(-1)?.text ?? '')).toContain('Euler $a_1 * b_2$ and a note[^1]注. Press <kbd>K</kbd>.数式\n');
  expect(errors).toEqual([]);

  // Automated accessibility audit of the new controls and rendered syntax (axe-core, WCAG 2 A/AA).
  const audit = await browser.newContext({ bypassCSP: true, viewport: { width: 1100, height: 900 } });
  const a11y = await audit.newPage();
  await a11y.goto(await page('ja'));
  await expect.poll(() => posted(a11y).then(m => m.some(x => x.type === 'ready'))).toBe(true);
  await send(a11y, { type: 'update', state: state(before, after) });
  await send(a11y, { type: 'links', broken: { './guide.md': 'missing' } });
  await expect(a11y.locator('.ProseMirror .katex')).toHaveCount(2);
  await a11y.addScriptTag({ path: resolve('node_modules/axe-core/axe.min.js') });
  const scan = async (label) => {
    const { violations, passed } = await a11y.evaluate(async () => {
      const run = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'] });
      return { passed: run.passes.length, violations: run.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target.join(' ')).slice(0, 5) })) };
    });
    expect(passed, label).toBeGreaterThan(10);
    expect(violations, label).toEqual([]);
    console.log(`axe: ${label} — ${passed} rules passed, no serious or critical violations`);
  };
  await scan('document with front matter, math, alerts, footnotes, HTML and links');
  await a11y.locator('#more-tools').click(); await scan('⋯ menu with Git, diff, reset and summary commands');
  await a11y.keyboard.press('Escape');
  await a11y.locator('.ProseMirror .raw-math .katex-html').first().dblclick(); await scan('raw source form');
  await a11y.keyboard.press('Escape'); await a11y.locator('#raw-cancel').click();
  // What assistive technology receives: the accessibility tree built by Chromium.
  const tree = await a11y.locator('body').ariaSnapshot();
  for (const expected of [
    /row "title Design"/,                     // front matter is a real table
    /math/,                                   // KaTeX exposes MathML, not only drawn glyphs
    /button "変更 1 を戻す"/, /button "変更 1 を確認済みにする"/,
    /textbox "Markdownを直接編集"/,
    /button "その他の操作"/,
  ]) expect(tree, 'accessibility tree').toMatch(expected);
  const alert = await a11y.locator('.ProseMirror blockquote').ariaSnapshot();
  expect(alert).toContain('警告'); expect(alert).toContain('Check the new settings.');
  const status = await a11y.locator('#link-status').evaluate(el => ({ text: el.textContent, title: el.title }));
  expect(status).toEqual({ text: '⚠ リンク切れ 1件', title: 'missing: ./guide.md' });
  console.log('accessibility tree: tables, MathML, review buttons, editor textbox and alerts are exposed with names');
  await audit.close();

  // English UI.
  const en = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const enErrors = []; en.on('pageerror', e => enErrors.push(e.message));
  await en.goto(await page('en'));
  await expect.poll(() => posted(en).then(m => m.some(x => x.type === 'ready'))).toBe(true);
  await send(en, { type: 'update', state: state(before, after) });
  await expect(en.locator('#counter')).toHaveText('1 unreviewed');
  await expect(en.locator('.ProseMirror [data-alert="warning"]')).toHaveText('Warning');
  await expect(en.locator('#reviewed span')).toHaveText('Review all');
  await expect(en.locator('html')).toHaveAttribute('lang', 'en');
  expect(enErrors).toEqual([]);
  if (process.env.MARKDOWN_REVIEW_SCREENSHOTS) {
    const shot = await browser.newPage({ viewport: { width: 900, height: 820 }, deviceScaleFactor: 2 });
    await shot.goto(await page('ja'));
    await expect.poll(() => posted(shot).then(m => m.some(x => x.type === 'ready'))).toBe(true);
    await send(shot, { type: 'update', state: state(before, after) });
    await expect(shot.locator('.ProseMirror .katex')).toHaveCount(2);
    await shot.waitForTimeout(500);
    await shot.screenshot({ path: join(process.env.MARKDOWN_REVIEW_SCREENSHOTS, 'syntax-preview.png') });
  }
  // Narrow windows: with every comparison (text, table, diagram) open and only the changes shown,
  // the page never scrolls sideways.
  const narrowBefore = '# 手順\n\n認証後、データを取得する。\n\n```mermaid\nflowchart LR\nA[認証] --> D[(DB)]\n```\n\n| 設定 | 値 |\n| --- | --- |\n| 保持期間 | 30秒 |\n| 再試行 | 3回 |\n';
  const narrowAfter = narrowBefore.replace('認証後、', '認証後、キャッシュを経由して').replace('A[認証] --> D[(DB)]', 'A[認証] --> C[キャッシュ]\nC --> D[(DB)]').replace('30秒', '60秒');
  const narrow = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  await narrow.goto(await page('ja'));
  await expect.poll(() => posted(narrow).then(m => m.some(x => x.type === 'ready'))).toBe(true);
  await send(narrow, { type: 'update', state: state(narrowBefore, narrowAfter) });
  await expect(narrow.locator('.inline-before > summary').first()).toBeVisible();
  for (const summary of await narrow.locator('.inline-before > summary').all()) { await summary.click(); await narrow.waitForTimeout(400); }
  for (const width of [360, 320]) {
    await narrow.setViewportSize({ width, height: 800 });
    await narrow.waitForTimeout(500);
    await expect.poll(() => narrow.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), { message: `no horizontal scroll at ${width}px` }).toBe(false);
  }
  await narrow.close();
  console.log('Webview browser checks passed');
} finally { await browser.close(); }
