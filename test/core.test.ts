import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReview, splitBlocks, revertHunk, confirmHunk, MAX_BYTES } from '../src/core';

const examples = [
  ['# 設計書\n\n期限は30分です。\n', '# 設計書\n\n期限は24時間です。\n'],
  ['', '# 新規\n\n新しい段落\n'],
  ['# 削除\n\n段落\n', ''],
  ['\r\n# CRLF\r\n\r\n旧文\r\n', '\r\n# CRLF\r\n\r\n新文\r\n'],
  ['# 見出し\r\r前\r', '# 見出し\r\r後\r'],
  ['- A\n  - B\n- C\n', '- A\n  - D\n- C\n'],
  ['| 項目 | 値 |\n|---|---|\n| 期限 | 30分 |\n', '| 項目 | 値 |\n|---|---|\n| 期限 | 24時間 |\n'],
  ['```ts\nconst a = 1;\n```\n', '```ts\nconst a = 2;\n```\n'],
  ['先頭\n\n同じ\n\n同じ\n\n末尾\n', '先頭\n\n変更\n\n同じ\n\n追加\n\n末尾\n'],
  ['**太字**で`old`\n', '**太字**で`new`\n'],
  ['文字\n', '**文字**\n'],
  ['A\n\nB\n\nC\n', 'C\n\nA\n\nB\n'],
  ['改行なし', '改行あり\n'],
  ['   \n\n', '\n'],
  ['[参考][ref]\n\n[ref]: https://example.com/old\n', '[参考][ref]\n\n[ref]: https://example.com/new\n'],
  ['家族👨‍👩‍👧は😊\n', '家族👨‍👩‍👧は😄\n'],
];

for (const [i, [before, after]] of examples.entries()) {
  test(`exact source reconstruction and reverts: fixture ${i + 1}`, () => {
    for (const source of [before, after]) assert.equal(splitBlocks(source).map(b => b.raw).join(''), source);
    let current = after;
    for (let step = 0; step < 30; step++) {
      const review = buildReview(before, current);
      if (!review.hunks.length) break;
      const hunk = review.hunks[step % review.hunks.length];
      assert.equal(current.slice(hunk.start, hunk.end), hunk.after);
      current = revertHunk(current, hunk);
    }
    assert.equal(current, before);
  });
}

test('Japanese words are highlighted inside rendered paragraphs', () => {
  const result = buildReview('期限は30分です。\n', '期限は24時間です。\n');
  assert.equal(result.hunks.length, 1);
  assert.match(result.html, /<del>30分<\/del><ins>24時間<\/ins>/);
  assert.doesNotMatch(result.html, /変更前/);
});
test('separate changed paragraphs can be individually reverted', () => {
  const result = buildReview('A before\n\nB before\n', 'A after\n\nB after\n');
  assert.equal(result.hunks.length, 2);
  assert.equal(revertHunk('A after\n\nB after\n', result.hunks[1]), 'A after\n\nB before\n');
});
test('table cells use inline changes when the structure is stable', () => {
  const result = buildReview(examples[6][0], examples[6][1]);
  assert.equal((result.html.match(/<table>/g) ?? []).length, 1);
  assert.match(result.html, /<td><del>30分<\/del><ins>24時間<\/ins><\/td>/);
});
test('URL-only changes are not hidden behind identical link labels', () => {
  const result = buildReview('[資料](https://old.example)\n', '[資料](https://new.example)\n');
  assert.match(result.html, /source-diff" open/);
  assert.match(result.html, /<del>old.example<\/del><ins>new.example<\/ins>/);
});
test('unchanged reference links resolve in the full-document environment', () => {
  const text = '# Doc\n\n[参考][ref]\n\n[ref]: https://example.com\n';
  assert.match(buildReview(text, text).html, /title="https:\/\/example.com"/);
});
test('raw HTML, scripts and remote images are inert', () => {
  const result = buildReview('', '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n![pic](https://evil.example/track)\n\n[bad](javascript:alert(1))\n');
  assert.doesNotMatch(result.html, /<script|<img|<iframe|<a\s/);
  assert.match(result.html, /&lt;script&gt;/);
});
test('whitespace-only changes remain visible and revertible', () => {
  const result = buildReview('text\n', 'text\n\n');
  assert.equal(result.hunks.length, 1);
  assert.match(result.html, /source-diff" open/);
});
test('stale hunk contents are rejected', () => {
  const hunk = buildReview('before', 'after').hunks[0];
  assert.throws(() => revertHunk('a new edit', hunk), /更新/);
});
test('size limit is measured in UTF-8 bytes', () => {
  assert.throws(() => buildReview('', 'あ'.repeat(MAX_BYTES / 3 + 1)), /512KB/);
});
test('changing document line endings is one explicitly labelled whole-file edit', () => {
  const before = '# A\n\n旧文\n', after = '# A\r\n\r\n新文\r\n';
  const review = buildReview(before, after);
  assert.equal(review.hunks.length, 1);
  assert.equal(review.hunks[0].eol, 'LF');
  assert.match(review.html, /LF → CRLF/);
  assert.equal(revertHunk(after, review.hunks[0]), before);
});
test('random insertion/deletion/replacement reverts preserve exact text', () => {
  let seed = 621;
  const rand = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  const blocks = ['# 見出し\n\n', '段落A\n\n', '段落B\n\n', '- リスト\n- item\n\n', '```\ncode\n```\n\n', '😊\n\n'];
  for (let i = 0; i < 100; i++) {
    const before = Array.from({ length: rand(8) }, () => blocks[rand(blocks.length)]).join('');
    let after = Array.from({ length: rand(8) }, () => blocks[rand(blocks.length)]).join('');
    for (let step = 0; step < 30 && after !== before; step++) {
      const review = buildReview(before, after);
      assert.ok(review.hunks.length);
      after = revertHunk(after, review.hunks[rand(review.hunks.length)]);
    }
    assert.equal(after, before);
  }
});

test('confirming one paragraph preserves every other unreviewed baseline', () => {
  const before = '# 設計\n\nA before\n\nB before\n\nC before\n';
  const after = before.replaceAll('before', 'after');
  const review = buildReview(before, after);
  const baseline = confirmHunk(before, review.hunks[1]);
  assert.equal(baseline, before.replace('B before', 'B after'));
  assert.deepEqual(buildReview(baseline, after).hunks.map(h => h.before), ['A before\n\n', 'C before\n']);
});

test('adjacent deletions sharing a current offset can be confirmed separately', () => {
  const before = '# 削除\n\n第一段落\n\n第二段落\n\n第三段落\n\n';
  const after = '# 削除\n\n';
  const review = buildReview(before, after);
  assert.equal(review.hunks.length, 3);
  assert.equal(review.hunks[0].start, review.hunks[1].start);
  assert.equal(confirmHunk(before, review.hunks[1]), before.replace('第二段落\n\n', ''));
});

test('adjacent additions are confirmed at their baseline position', () => {
  const before = '# 追加\n\n';
  const after = before + '第一段落\n\n第二段落\n\n';
  const baseline = confirmHunk(before, buildReview(before, after).hunks[1]);
  assert.equal(baseline, before + '第二段落\n\n');
  assert.equal(buildReview(baseline, after).hunks[0].after, '第一段落\n\n');
});

test('re-editing a confirmed paragraph compares against the approved text', () => {
  const before = '期限は30分です。\n\n名称は旧称です。\n';
  const after = before.replace('30分', '24時間').replace('旧称', '新称');
  const baseline = confirmHunk(before, buildReview(before, after).hunks[0]);
  const review = buildReview(baseline, after.replace('24時間', '48時間'));
  assert.equal(review.hunks.length, 2);
  assert.equal(review.hunks[0].before, '期限は24時間です。\n\n');
  assert.equal(review.hunks[0].after, '期限は48時間です。\n\n');
});

test('stale baseline contents cannot be confirmed', () => {
  const hunk = buildReview('before', 'after').hunks[0];
  assert.throws(() => confirmHunk('another baseline', hunk), /更新/);
});

test('a partially confirmed baseline still respects the file size limit', () => {
  const before = 'a'.repeat(300000) + '\n\n# anchor\n\n';
  const after = '# anchor\n\n' + 'b'.repeat(300000) + '\n\n';
  const hunk = buildReview(before, after).hunks.find(h => h.before === '')!;
  assert.ok(hunk);
  // Both documents fit; adopting the addition before confirming the deletion does not.
  assert.throws(() => confirmHunk(before, hunk), /512KB/);
});

test('confirming all fixtures in arbitrary order preserves every source byte', () => {
  for (const [before, after] of [...examples, ['# A\n\n旧文\n', '# A\r\n\r\n新文\r\n']]) {
    let baseline = before;
    for (let step = 0; step < 30 && baseline !== after; step++) {
      const review = buildReview(baseline, after);
      assert.ok(review.hunks.length);
      const hunk = review.hunks[(step + 1) % review.hunks.length];
      assert.equal(baseline.slice(hunk.oldStart, hunk.oldEnd), hunk.before);
      baseline = confirmHunk(baseline, hunk);
    }
    assert.equal(baseline, after);
  }
});

test('random individual confirmations converge without losing insertions or duplicate blocks', () => {
  let seed = 803;
  const rand = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  const blocks = ['# 見出し\n\n', '同じ段落\n\n', '変更\n\n', '- 項目\n\n', '```\nコード\n```\n\n', '😊\n\n'];
  for (let i = 0; i < 100; i++) {
    let baseline = Array.from({ length: rand(8) }, () => blocks[rand(blocks.length)]).join('');
    const current = Array.from({ length: rand(8) }, () => blocks[rand(blocks.length)]).join('');
    for (let step = 0; step < 30 && baseline !== current; step++) {
      const review = buildReview(baseline, current);
      assert.ok(review.hunks.length);
      baseline = confirmHunk(baseline, review.hunks[rand(review.hunks.length)]);
    }
    assert.equal(baseline, current);
  }
});
