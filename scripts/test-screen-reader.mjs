// What VoiceOver actually speaks for the review UI. macOS only; CI prepares VoiceOver with
// `npx @guidepup/setup --ci`. The complete webview runs against a simulated extension host.
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { voiceOver, macOSActivate } from '@guidepup/guidepup';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const folder = resolve('test-results/screen-reader'); await mkdir(folder, { recursive: true });
await build({ stdin: { contents: `export { buildReview } from './src/core'; export { shellHtml } from './src/shell'; export { setLocale } from './src/i18n';`, resolveDir: resolve('.'), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(folder, 'host.mjs'), logLevel: 'error' });
await build({ entryPoints: ['src/webview.ts'], bundle: true, outfile: join(folder, 'webview.js'), platform: 'browser', target: 'chrome120', format: 'iife', logLevel: 'error',
  loader: { '.woff2': 'file', '.woff': 'empty', '.ttf': 'empty' }, assetNames: 'fonts/[name]-[hash]' });
await copyFile('media/review.css', join(folder, 'review.css'));
const host = await import(pathToFileURL(join(folder, 'host.mjs')).href);
host.setLocale('en');
const nonce = 'screenreader';
const html = host.shellHtml({ cspSource: "file: 'self'", nonce, css: 'review.css', editorCss: 'webview.css', script: 'webview.js' })
  .replace(`<script nonce="${nonce}"`, `<script nonce="${nonce}">window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.__posted.push(JSON.parse(JSON.stringify(m))),setState:()=>{},getState:()=>undefined});</script><script nonce="${nonce}"`);
await writeFile(join(folder, 'index.html'), html.replace('<body>', '<body class="vscode-light">'));
const before = '---\ntitle: Design\n---\n\n# Overview\n\n> [!WARNING]\n> Check the settings.\n\nEuler $e^{i\\pi}+1=0$ and a note[^1].\n\n[^1]: The note.\n';
const after = before.replace('Check the settings.', 'Check the new settings.');
const review = host.buildReview(before, after);
const state = { uri: 'file:///work/doc.md', name: 'doc.md', html: review.html, revision: review.revision, count: review.hunks.length, hunks: review.hunks,
  baselineMarkdown: before, confirmedMarkdown: before, updatedAt: new Date().toISOString(), dirty: false, markdown: after, settings: { math: true, maxBytes: 524288 } };

// Chrome exposes its web content to VoiceOver only once accessibility is enabled for it.
const browser = await chromium.launch({ headless: false, args: ['--force-renderer-accessibility'] });
const log = [];
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.goto(pathToFileURL(join(folder, 'index.html')).href);
  await page.waitForFunction(() => window.__posted.some(m => m.type === 'ready'));
  await page.evaluate(s => window.postMessage({ type: 'update', state: s }, '*'), state);
  await page.locator('.ProseMirror .katex').first().waitFor();
  await voiceOver.start();
  // VoiceOver reads the frontmost application: bring Playwright's browser to the front.
  for (const app of ['Google Chrome for Testing', 'Chromium']) { try { await macOSActivate(app); break; } catch { /* try the next name */ } }
  await page.bringToFront();
  await page.waitForTimeout(3000);
  const record = async name => {
    await page.waitForTimeout(700);
    const phrase = (await voiceOver.lastSpokenPhrase().catch(() => '')) || (await voiceOver.itemText().catch(() => ''));
    log.push(`${name}: ${phrase}`);
    return phrase;
  };
  // The VoiceOver cursor follows keyboard focus: start at the first toolbar control.
  const top = async () => { await page.locator('#mode-edit').focus(); await record('focus top'); };
  // 1. Every control, as VoiceOver's "next control" (VO-Command-J) announces it.
  await top();
  for (let i = 0, last = ''; i < 40; i++) {
    await voiceOver.perform(voiceOver.keyboardCommands.findNextControl);
    const phrase = await record('control');
    if (phrase && phrase === last) break;
    last = phrase;
  }
  // 2. The rest of the page in reading order with the VoiceOver cursor (VO-Right).
  await top();
  for (let i = 0, repeats = 0, last = ''; i < 80 && repeats < 4; i++) {
    await voiceOver.next();
    const phrase = await record('next');
    repeats = phrase === last ? repeats + 1 : 0; last = phrase;
    if (/end of footer/i.test(phrase)) break;
  }
  for (const phrase of await voiceOver.spokenPhraseLog().catch(() => [])) if (phrase) log.push(`log: ${phrase}`);
} finally {
  await voiceOver.stop().catch(() => {});
  await browser.close();
  await writeFile(join(folder, 'voiceover.json'), JSON.stringify({ log }, null, 2));
}
const text = log.join('\n').toLowerCase();
console.log(JSON.stringify({ log }, null, 2));
const expectations = {
  'review buttons are announced by name and role': [/revert change 1 button/, /mark change 1 as reviewed button/, /mark all as reviewed button/],
  'the More actions menu button is announced with its collapsed state': [/more actions collapsed button/],
  'the editor is announced as a named edit text': [/edit markdown directly edit text/],
  // Inside the edit text, VoiceOver reads the front matter preview as text, not as a navigable table.
  'front matter is read with its label, key and value': [/metadata\s+title\s+design/],
  'GitHub alert label and text are read': [/warning/, /check the new settings/],
  'inline math is read as math': [/superscript/, /\bmath\b/],
};
const failed = Object.entries(expectations).filter(([, patterns]) => !patterns.every(p => p.test(text)));
if (failed.length) { console.error('VoiceOver did not announce: ' + failed.map(([name]) => name).join('; ')); process.exit(1); }
console.log('VoiceOver checks passed: ' + Object.keys(expectations).join('; '));
