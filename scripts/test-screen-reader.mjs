// What a real screen reader speaks for the review UI: VoiceOver on macOS, NVDA on Windows.
// CI prepares it with `npx @guidepup/setup setup --ci`. The complete webview runs against a
// simulated extension host.
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { voiceOver, nvda, macOSActivate, windowsActivate } from '@guidepup/guidepup';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const windows = process.platform === 'win32';
if (!windows && process.platform !== 'darwin') throw new Error('Run the screen reader check on macOS (VoiceOver) or Windows (NVDA)');
const reader = windows ? nvda : voiceOver, readerName = windows ? 'NVDA' : 'VoiceOver';
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

// Chrome exposes its web content to screen readers only once accessibility is enabled for it.
const browser = await chromium.launch({ headless: false, args: ['--force-renderer-accessibility'] });
const log = [];
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.goto(pathToFileURL(join(folder, 'index.html')).href);
  await page.waitForFunction(() => window.__posted.some(m => m.type === 'ready'));
  await page.evaluate(s => window.postMessage({ type: 'update', state: s }, '*'), state);
  await page.locator('.ProseMirror .katex').first().waitFor();
  await reader.start();
  // The screen reader reads the foreground window: bring Playwright's browser to the front.
  // The page title, "Markdown Lens", is the window title the activation looks for.
  if (windows) await windowsActivate(chromium.executablePath(), 'Markdown Lens').catch(() => {});
  else for (const app of ['Google Chrome for Testing', 'Chromium']) { try { await macOSActivate(app); break; } catch { /* try the next name */ } }
  await page.bringToFront();
  await page.waitForTimeout(3000);
  const record = async name => {
    await page.waitForTimeout(700);
    const phrase = (await reader.lastSpokenPhrase().catch(() => '')) || (await reader.itemText().catch(() => ''));
    log.push(`${name}: ${phrase}`);
    return phrase;
  };
  // The screen reader follows keyboard focus: start at the first toolbar control.
  const top = async () => { await page.locator('#mode-edit').focus(); await record('focus top'); };
  // 1. Every control: VoiceOver's "next control" (VO-Command-J); NVDA's browse mode "next button" (B)
  //    and "next edit field" (E).
  const step = async (command, name, limit) => {
    for (let i = 0, last = ''; i < limit; i++) {
      await reader.perform(command);
      const phrase = await record(name);
      if (phrase && phrase === last) break;
      last = phrase;
    }
  };
  await top();
  // NVDA's browse mode cursor does not follow focus set by script: Control+Home moves it to the top.
  const start = async () => { if (windows) { await reader.press('Control+Home'); await record('top of page'); } else await top(); };
  if (windows) {
    await step(nvda.keyboardCommands.moveToNextButton, 'button', 20);
    await start();
    await step(nvda.keyboardCommands.moveToNextEditField, 'edit field', 2);
  } else await step(voiceOver.keyboardCommands.findNextControl, 'control', 40);
  // 2. The page in reading order (VoiceOver: VO-Right; NVDA: down arrow in browse mode).
  await start();
  for (let i = 0, repeats = 0, last = ''; i < 80 && repeats < 4; i++) {
    await reader.next();
    const phrase = await record('next');
    repeats = phrase === last ? repeats + 1 : 0; last = phrase;
    if (/end of footer/i.test(phrase)) break;
  }
  for (const phrase of await reader.spokenPhraseLog().catch(() => [])) if (phrase) log.push(`log: ${phrase}`);
} finally {
  await reader.stop().catch(() => {});
  await browser.close();
  await writeFile(join(folder, readerName.toLowerCase() + '.json'), JSON.stringify({ reader: readerName, log }, null, 2));
}
const text = log.join('\n').toLowerCase();
console.log(JSON.stringify({ reader: readerName, log }, null, 2));
const expectations = windows ? {
  // NVDA speaks the name, then the role and state, separated by commas.
  'review buttons are announced by name and role': [/revert change 1, button/, /mark change 1 as reviewed, button/, /mark all as reviewed, button/],
  'the More actions menu button is announced with its collapsed state': [/more actions, button, collapsed/],
  'the editor is announced as a named multi line edit field': [/edit markdown directly, edit, multi line/],
  'front matter is read with its label, key and value': [/metadata/, /title/, /design/],
  'GitHub alert label and text are read': [/block quote, warning, check the new settings/],
  'inline math is read as math': [/raised to the/, /pi power/],
} : {
  'review buttons are announced by name and role': [/revert change 1 button/, /mark change 1 as reviewed button/, /mark all as reviewed button/],
  'the More actions menu button is announced with its collapsed state': [/more actions collapsed button/],
  'the editor is announced as a named edit text': [/edit markdown directly edit text/],
  // Inside the edit text, VoiceOver reads the front matter preview as text, not as a navigable table.
  'front matter is read with its label, key and value': [/metadata\s+title\s+design/],
  'GitHub alert label and text are read': [/warning/, /check the new settings/],
  'inline math is read as math': [/superscript/, /\bmath\b/],
};
const failed = Object.entries(expectations).filter(([, patterns]) => !patterns.every(p => p.test(text)));
if (failed.length) { console.error(readerName + ' did not announce: ' + failed.map(([name]) => name).join('; ')); process.exit(1); }
console.log(readerName + ' checks passed: ' + Object.keys(expectations).join('; '));
