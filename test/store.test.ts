import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BaselineStore } from '../src/store';

test('baselines persist across instances and remain isolated by URI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'md-review-store-'));
  try {
    const store = new BaselineStore(root);
    assert.equal(await store.load('file:///a.md'), undefined);
    await store.save('file:///a.md', '旧文\r\n');
    await store.save('file:///b.md', '別の文');
    const reopened = new BaselineStore(root);
    assert.equal((await reopened.load('file:///a.md'))?.text, '旧文\r\n');
    assert.equal((await reopened.load('file:///b.md'))?.text, '別の文');
    await reopened.save('file:///a.md', '確認した新しい文');
    assert.equal((await store.load('file:///a.md'))?.text, '確認した新しい文');
    assert.equal((await readdir(root)).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('corrupt baseline is surfaced instead of silently replacing history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'md-review-store-'));
  try {
    const store = new BaselineStore(root);
    await store.save('file:///a.md', 'old');
    const [name] = await readdir(root);
    await writeFile(join(root, name), '{"version":1}');
    await assert.rejects(store.load('file:///a.md'), /比較元/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
