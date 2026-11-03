import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReview, confirmHunk, revertHunk } from '../src/core';
import { flowDifference, FlowGraph } from '../src/flow-diff';
import { BaselineStore } from '../src/store';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('unique moved paragraph is one atomic review and revert action', () => {
  const a = 'Alpha\n\nBravo\n\nCharlie\n\nDelta\n\n', b = 'Alpha\n\nCharlie\n\nDelta\n\nBravo\n\n';
  const review = buildReview(a, b);
  assert.equal(review.hunks.length, 1);
  assert.ok(review.hunks[0].moveParts);
  assert.match(review.html, /↕ 移動/);
  assert.equal(revertHunk(b, review.hunks[0]), a);
  assert.equal(confirmHunk(a, review.hunks[0]), b);
});
test('moves and unrelated edits can be approved in either order', () => {
  const a = 'Alpha\n\nBravo\n\nCharlie\n\nDelta\n\nEcho\n\n', b = 'Alpha\n\nCharlie\n\nDelta\n\nBravo\n\nEcho edited\n\n';
  for (const last of [false, true]) {
    let baseline = a, steps = 0;
    while (baseline !== b && steps++ < 10) {
      const review = buildReview(baseline, b);
      baseline = confirmHunk(baseline, review.hunks[last ? review.hunks.length - 1 : 0]);
    }
    assert.equal(baseline, b);
  }
});
test('all permutations of unique blocks can be reverted and confirmed exactly', () => {
  const source = ['A\n\n', 'B\n\n', 'C\n\n', 'D\n\n'];
  const permutations = (items: string[]): string[][] => items.length ? items.flatMap((x, i) => permutations(items.filter((_, j) => i !== j)).map(rest => [x, ...rest])) : [[]];
  for (const p of permutations(source)) {
    const before = source.join(''); let current = p.join(''), baseline = before;
    for (let i = 0; current !== before && i < 10; i++) current = revertHunk(current, buildReview(before, current).hunks[0]);
    assert.equal(current, before);
    for (let i = 0; baseline !== p.join('') && i < 10; i++) baseline = confirmHunk(baseline, buildReview(baseline, p.join('')).hunks[0]);
    assert.equal(baseline, p.join(''));
  }
});
test('Mermaid payload is escaped and never becomes document HTML', () => {
  const review = buildReview('```mermaid\nflowchart LR\nA-->B\n```\n', '```mermaid\nflowchart LR\nA["<script>bad</script>"]-->C\n```\n');
  assert.match(review.html, /diagram-review/);
  assert.doesNotMatch(review.html, /<script>/);
  assert.match(review.html, /data-before=/);
});
test('only image resolver output is used, with escaped attributes', () => {
  const source = '![図](./図.png)\n';
  assert.doesNotMatch(buildReview('', source).html, /<img/);
  assert.match(buildReview('', source, { imageUri: () => 'safe://image"' }).html, /src="safe:\/\/image&quot;"/);
});
test('snapshot persists without changing review baseline and can be deleted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ml-snapshot-'));
  try {
    const store = new BaselineStore(dir);
    await Promise.all([store.ensure('file:///a.md', 'baseline'), store.ensure('file:///a.md', 'other')]);
    assert.equal((await store.load('file:///a.md'))?.text, 'baseline');
    const checkpoint = await store.snapshot('file:///a.md', 'draft\r\n');
    const reopened = new BaselineStore(dir);
    assert.equal((await reopened.snapshots('file:///a.md'))[0].text, 'draft\r\n');
    assert.equal((await reopened.load('file:///a.md'))?.text, 'baseline');
    assert.deepEqual(await reopened.snapshots('file:///b.md'), []);
    await reopened.deleteSnapshot('file:///a.md', checkpoint.id);
    assert.deepEqual(await reopened.snapshots('file:///a.md'), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
const graph = (nodes: string[], edges: [string, string, string?][]): FlowGraph => ({ direction: 'LR', nodes: nodes.map(id => ({ id, text: id })), edges: edges.map(([start, end, text]) => ({ start, end, text, type: 'arrow_point' })), subgraphs: 0, styled: false });
test('flowchart adds cache and two edges, removes direct edge', () => {
  const result = flowDifference(graph(['認証', 'DB'], [['認証', 'DB']]), graph(['認証', 'キャッシュ', 'DB'], [['認証', 'キャッシュ'], ['キャッシュ', 'DB']]))!;
  assert.equal(result.summary, '追加 3 · 削除 1 · 変更 0');
  assert.equal(Object.values(result.nodes).filter(x => x === 'added').length, 1);
  assert.deepEqual(result.edges, ['added', 'added', 'removed']);
});
test('flowchart preserves identity for labels and falls back for ambiguous edges and subgraphs', () => {
  const before = graph(['A', 'B'], [['A', 'B', 'old']]), after = graph(['A', 'B'], [['A', 'B', 'new']]);
  after.nodes[0].text = 'changed';
  const result = flowDifference(before, after)!;
  assert.equal(result.summary, '追加 0 · 削除 0 · 変更 2');
  assert.match(result.source, /old → new/);
  assert.equal(flowDifference(before, { ...after, subgraphs: 1 }), undefined);
  assert.equal(flowDifference(before, { ...after, edges: [...after.edges, ...after.edges] }), undefined);
});
