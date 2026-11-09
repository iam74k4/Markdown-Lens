import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaselineStore } from '../src/store';
import { similarity, reviewSummary, changeLines } from '../src/review-summary';
import { planReview } from '../src/core';
import { documentLinks, headingAnchors, linkTarget } from '../src/links';
import { safeFolder, savePastedImage } from '../src/pasted-image';
import { configureLimits, limits } from '../src/limits';
import { setLocale, t } from '../src/i18n';
import { en } from '../src/locales/en';

test('rename matching prefers the deleted file with the most shared lines', () => {
  const old = '# Spec\n\nIntro\n\n- a\n- b\n- c\n';
  assert.equal(similarity(old, old), 1);
  assert.ok(similarity(old, old.replace('Intro', 'Intro, edited')) >= 0.5);
  assert.ok(similarity(old, '# Other\n\nUnrelated text\n') < 0.5);
});

test('a moved file keeps its baseline, draft and snapshots, and never overwrites', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-store-'));
  try {
    const store = new BaselineStore(dir);
    await store.save('file:///a.md', 'baseline');
    await store.saveDraft('file:///a.md', { text: 'draft', baseText: 'baseline' });
    await store.snapshot('file:///a.md', 'snap');
    assert.equal(await store.move('file:///a.md', 'file:///b.md'), true);
    assert.equal((await store.load('file:///b.md'))?.text, 'baseline');
    assert.equal((await store.load('file:///b.md'))?.uri, 'file:///b.md');
    assert.equal((await store.loadDraft('file:///b.md'))?.text, 'draft');
    assert.equal((await store.snapshots('file:///b.md'))[0].text, 'snap');
    assert.equal(await store.load('file:///a.md'), undefined);
    await store.save('file:///c.md', 'other');
    assert.equal(await store.move('file:///b.md', 'file:///c.md'), false);
    assert.equal((await store.load('file:///c.md'))?.text, 'other');
    assert.deepEqual((await store.entries()).map(e => e.uri).sort(), ['file:///b.md', 'file:///c.md']);
    await store.remove('file:///b.md');
    assert.deepEqual((await store.entries()).map(e => e.uri), ['file:///c.md']);
    assert.ok(!(await readdir(dir)).some(name => name.endsWith('.tmp')));
    assert.ok(await store.size() > 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the change summary lists each hunk with its heading path and a diff', () => {
  const before = '# Design\n\n## Session\n\nTimeout is 30 minutes.\n\n## Terms\n\nUser.\n';
  const after = before.replace('30 minutes', '24 hours') + '\n## New\n\nAdded.\n';
  const summary = reviewSummary([{ name: 'docs/design.md', baselineLabel: 'reviewed', before, after }]);
  assert.match(summary, /^# Markdown Lens 変更の要約/);
  assert.match(summary, /1ファイル · 未確認 3件/);
  assert.doesNotMatch(summary, /\n {2}\n```/);
  assert.match(summary, /### 1\. 変更 · 5行目 · Design › Session/);
  assert.match(summary, /- Timeout is 30 minutes\.\n\+ Timeout is 24 hours\./);
  assert.match(summary, /### 2\. 追加/);
});

test('changed line ranges skip blank separator lines', () => {
  const before = 'a\n\nb\n\nc\n', after = 'a\n\nB\n\nc\n\nd\n';
  const lines = changeLines(after, planReview(before, after).hunks);
  assert.deepEqual(lines.map(l => [l.kind, l.start, l.end]), [['changed', 2, 2], ['added', 6, 6]]);
  const removed = changeLines('a\n', planReview('a\n\nb\n', 'a\n').hunks);
  assert.equal(removed[0].kind, 'removed');
});

test('documents expose their links, images, wiki links and anchors', () => {
  const source = '# Intro\n\n## Intro\n\nSee [a](./a.md#x), ![i](img/p%20q.png), [[Page#Part]] and <https://e.com>.\n\n<a id="custom"></a>\n';
  const links = documentLinks(source);
  assert.deepEqual(links.map(l => [l.kind, l.href]), [['link', './a.md#x'], ['image', 'img/p%20q.png'], ['wiki', 'Page#Part']]);
  assert.equal(links[0].line, 4);
  assert.equal(source.split('\n')[4].slice(links[0].column, links[0].column + links[0].length), './a.md#x');
  assert.deepEqual([...headingAnchors(source)].sort(), ['custom', 'intro', 'intro-1']);
  assert.deepEqual(linkTarget('./a%20b.md#Sec%20One'), { path: './a b.md', fragment: 'Sec One' });
  assert.deepEqual(linkTarget('#top'), { path: undefined, fragment: 'top' });
  assert.ok(linkTarget('https://example.com').external);
  assert.ok(linkTarget('command:workbench.action.quit').unsupported);
  assert.ok(linkTarget('javascript:alert(1)').unsupported);
});

test('pasted images go to a configured folder below the document only', async () => {
  for (const ok of ['assets', 'docs/img', '.markdown-lens-images']) assert.equal(safeFolder(ok), true, ok);
  for (const bad of ['', '/abs', 'C:\\x', '../up', 'a/../b', 'a/./b', 'bad|name']) assert.equal(safeFolder(bad), false, bad);
  const dir = await mkdtemp(join(tmpdir(), 'lens-image-'));
  try {
    await mkdir(join(dir, 'docs'));
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
    const src = await savePastedImage(join(dir, 'docs', 'a.md'), [dir], png, 'assets/shots');
    assert.match(src, /^\.\/assets\/shots\/[0-9a-f-]+\.png$/);
    assert.ok((await readFile(join(dir, 'docs', src))).length > 0);
    await assert.rejects(savePastedImage(join(dir, 'docs', 'a.md'), [dir], png, '../outside'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the size limit is configurable within safe bounds', () => {
  try {
    configureLimits(1024); assert.equal(limits.maxBytes, 1024 * 1024); assert.equal(limits.label, '1MB');
    configureLimits(1); assert.equal(limits.maxBytes, 128 * 1024);
    configureLimits(1e9); assert.equal(limits.maxBytes, 4 * 1024 * 1024);
  } finally { configureLimits(512); }
  assert.equal(limits.label, '512KB');
});

test('every translated string keeps its placeholders', () => {
  for (const [ja, english] of Object.entries(en)) {
    const placeholders = (s: string) => [...s.matchAll(/\{(\d+)\}/g)].map(m => m[1]).sort().join();
    assert.equal(placeholders(english), placeholders(ja), ja);
    assert.ok(english.trim(), ja);
  }
  try {
    setLocale('en');
    assert.equal(t('未確認 {0}件', 3), en['未確認 {0}件'].replace('{0}', '3'));
  } finally { setLocale('ja'); }
  assert.equal(t('未確認 {0}件', 3), '未確認 3件');
});

test('every string passed to t() has an English translation', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const files = (await readdir('src', { recursive: true })).filter(f => String(f).endsWith('.ts') && !String(f).includes('locales'));
  const missing: string[] = [];
  for (const file of files) {
    const source = await readFile(join('src', String(file)), 'utf8');
    for (const match of source.matchAll(/\bt\('((?:[^'\\\n]|\\.)*)'/g)) {
      const key = match[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      if (!(key in en)) missing.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});
