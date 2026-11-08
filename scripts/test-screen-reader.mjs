// What VoiceOver actually speaks for the review UI. macOS only; CI prepares VoiceOver with
// `npx @guidepup/setup --ci`. The complete webview runs against a simulated extension host.
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { voiceOver } from '@guidepup/guidepup';
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

const browser = await chromium.launch({ headless: false });
const spoken = {};
let log = [];
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.goto(pathToFileURL(join(folder, 'index.html')).href);
  await page.waitForFunction(() => window.__posted.some(m => m.type === 'ready'));
  await page.evaluate(s => window.postMessage({ type: 'update', state: s }, '*'), state);
  await page.locator('.ProseMirror .katex').first().waitFor();
  await page.bringToFront();
  await voiceOver.start();
  const speak = async (name, selector) => {
    await page.locator(selector).first().focus();
    await page.waitForTimeout(1200);
    spoken[name] = await voiceOver.lastSpokenPhrase();
  };
  await speak('revert', '.inline-review .revert');
  await speak('review', '.inline-review .confirm-change');
  await speak('menu', '#more-tools');
  await speak('editor', '.ProseMirror');
  // Read the document from the top with the VoiceOver cursor.
  await voiceOver.clearSpokenPhraseLog();
  for (let i = 0; i < 40; i++) await voiceOver.next();
  log = await voiceOver.spokenPhraseLog();
} finally {
  await voiceOver.stop().catch(() => {});
  await browser.close();
  await writeFile(join(folder, 'voiceover.json'), JSON.stringify({ spoken, log }, null, 2));
}
const text = [...Object.values(spoken), ...log].join('\n').toLowerCase();
console.log(JSON.stringify({ spoken, log }, null, 2));
const expectations = {
  'review buttons are announced by name': [/revert change 1/, /mark change 1 as reviewed/],
  'the More actions menu button is announced': [/more actions/],
  'the editor is an editable text area with a name': [/edit markdown/],
  'front matter is read as a metadata table': [/metadata/, /design/],
  'GitHub alert label and text are read': [/warning/, /check the new settings/],
};
const failed = Object.entries(expectations).filter(([, patterns]) => !patterns.every(p => p.test(text)));
if (failed.length) { console.error('VoiceOver did not announce: ' + failed.map(([name]) => name).join('; ')); process.exit(1); }
console.log('VoiceOver checks passed: ' + Object.keys(expectations).join('; '));
