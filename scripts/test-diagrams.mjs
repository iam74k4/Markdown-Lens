import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const folder = resolve('test-results/diagram-browser');
await mkdir(folder, { recursive: true });
await build({ stdin: { contents: `import { renderDiagrams, refreshDiagramThemes } from './src/diagrams'; window.renderDiagrams=renderDiagrams; window.refreshDiagramThemes=refreshDiagramThemes;`, resolveDir: resolve('.') }, bundle: true, platform: 'browser', outfile: join(folder, 'diagrams.js') });
await writeFile(join(folder, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'unsafe-inline\'; img-src \'none\'"><body class="vscode-light"><main id="fixtures"></main><script src="diagrams.js"></script>');
const browser = await chromium.launch(process.env.CI ? { headless: true } : { headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage();
  const requests = [], errors = [];
  page.on('request', r => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(join(folder, 'index.html')).href);
  const flow = 'flowchart LR\nA[認証] --> B[(DB)]';
  const fixtures = [
    { id: 'normal', after: flow }, { id: 'duplicate', after: flow },
    { id: 'sequence', before: 'sequenceDiagram\nAlice->>Bob: Hello', after: 'sequenceDiagram\nAlice->>Bob: Updated' },
    { id: 'broken', after: 'this is not mermaid' },
    { id: 'directive', after: '%%{init: {securityLevel: "loose"}}%%\n' + flow },
    { id: 'link', after: 'flowchart LR\nA[Safe] --> B\nclick A "https://example.invalid/track"' },
    { id: 'hostile', after: 'flowchart LR\nA["<img src=https://example.invalid/pixel onerror=alert(1)>"] --> B' },
    { id: 'large', after: 'x'.repeat(30001) },
  ];
  await page.evaluate(fixtures => {
    const container = document.getElementById('fixtures');
    for (const f of fixtures) {
      const block = document.createElement('div'); block.id = f.id; block.className = 'diagram-review';
      block.dataset.before = f.before ?? ''; block.dataset.after = f.after;
      block.innerHTML = '<div class="diagram-canvas"></div><details class="diagram-source"><summary>ソース</summary></details>';
      container.append(block);
    }
    window.renderDiagrams(container);
  }, fixtures);
  await expect(page.locator('#normal svg')).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator('#duplicate svg')).toHaveCount(1);
  await expect(page.locator('#sequence svg')).toHaveCount(2);
  await expect(page.locator('#sequence')).toContainText('Updated');
  await expect(page.locator('#broken .diagram-source')).toHaveAttribute('open', '');
  await expect(page.locator('#directive .diagram-canvas')).toContainText('設定ディレクティブ');
  await expect(page.locator('#link svg')).toHaveCount(1);
  await expect(page.locator('#link a')).toHaveCount(0);
  await expect(page.locator('#large .diagram-canvas')).toContainText('30,000');
  await expect(page.locator('#hostile img, #hostile script, #hostile foreignObject')).toHaveCount(0);
  const ids = await page.locator('svg [id], svg[id]').evaluateAll(nodes => nodes.map(n => n.id));
  expect(new Set(ids).size).toBe(ids.length);
  await page.evaluate(() => { document.body.className = 'vscode-dark'; window.refreshDiagramThemes(document.getElementById('fixtures')); });
  await expect(page.locator('#normal svg')).toHaveCount(1);
  expect(requests).toEqual([]); expect(errors).toEqual([]);
  await writeFile(join(folder, 'result.json'), JSON.stringify({ passed: true, checks: ['flowchart rendering', 'unique cached SVG identifiers', 'sequence diagram before/after fallback', 'invalid Mermaid source fallback', 'directive rejection', 'inert links and HTML', 'large diagram rejection', 'no remote requests', 'no browser exceptions'] }, null, 2));
  console.log('Diagram browser checks passed');
} finally { await browser.close(); }
