import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReview } from '../src/core';
import { inlineChanges, reviewDecorations } from '../src/inline-review';
import { parseRichMarkdown } from '../src/rich-markdown';

for (const [name, before, after, expected] of [
  ['Japanese text', '# タイトル\n\n期限は30分。\n', '# タイトル\n\n期限は24時間。\n', '24時間'],
  ['table cell', '| 項目 | 値 |\n| --- | --- |\n| 期限 | 30分 |\n', '| 項目 | 値 |\n| --- | --- |\n| 期限 | 24時間 |\n', '24時間'],
  ['nested list', '- one\n  - old\n', '- one\n  - new\n', 'new'],
  ['emoji and markup', '**old😊**\n', '**new😄**\n', 'new😄'],
  ['CRLF', '# title\r\n\r\nold\r\n', '# title\r\n\r\nnew\r\n', 'new'],
]) test(`inline projection targets exact editable characters: ${name}`, () => {
  const { doc } = parseRichMarkdown(after), { hunks } = buildReview(before, after);
  const plan = inlineChanges(after, doc, hunks);
  const text = plan.flatMap(p => p.inserted).map(p => doc.textBetween(p.from, p.to)).join('');
  assert.equal(text, expected);
  const decorations = reviewDecorations(doc, plan, false, new Set(), () => {});
  assert.ok(decorations.find().length > 0);
  assert.equal(parseRichMarkdown(after).source, after);
});
test('deletion-only and trailing source-only changes have reachable review cards', () => {
  for (const [before, after] of [['one\n\ntwo\n', 'one\n'], ['one\n', ''], ['one\n\n[ref]: /old\n', 'one\n\n[ref]: /new\n']]) {
    const { doc } = parseRichMarkdown(after), { hunks } = buildReview(before, after);
    const plan = inlineChanges(after, doc, hunks);
    assert.equal(plan.length, hunks.length); assert.ok(plan.length);
    for (const p of plan) assert.ok(p.position >= 0 && p.position <= doc.content.size);
    assert.equal(reviewDecorations(doc, plan, false, new Set(), () => {}).find().filter(d => d.from === d.to).length, hunks.length);
  }
});
test('move decoration includes every destination block and does not duplicate text in the document', () => {
  const before = '# A\n\none\n\n# B\n\ntwo\n\n', after = '# A\n\n# B\n\ntwo\n\none\n\n';
  const { doc } = parseRichMarkdown(after), review = buildReview(before, after);
  const plan = inlineChanges(after, doc, review.hunks);
  assert.equal(plan.length, 1); assert.ok(plan[0].hunk.moveParts);
  assert.equal(doc.textContent, 'ABtwoone');
});
test('format-only changes remain reviewable even when visible characters match', () => {
  const before = '[link](/old)\n', after = '[link](/new)\n';
  const { doc } = parseRichMarkdown(after), { hunks } = buildReview(before, after);
  const plan = inlineChanges(after, doc, hunks);
  assert.equal(plan.length, 1); assert.equal(plan[0].inserted.length, 0); assert.equal(plan[0].hunk.before, before);
});
