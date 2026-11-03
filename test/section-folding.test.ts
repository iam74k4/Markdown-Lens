import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headingSections, insideSection, sectionDecorations } from '../src/section-folding';
import { parseRichMarkdown, serializeRichMarkdown } from '../src/rich-markdown';
import { buildReview } from '../src/core';
import { inlineChanges, reviewDecorations } from '../src/inline-review';

test('sections include nested headings, tables and diagrams up to the next peer heading', () => {
  const model = parseRichMarkdown('# A\n\nintro\n\n## B\n\n| X |\n| - |\n| 1 |\n\n### C\n\n```mermaid\nflowchart LR\nA --> B\n```\n\n## D\n\nlast\n');
  const [a,b,c,d] = headingSections(model.doc);
  assert.equal(a.end, model.doc.content.size); assert.equal(b.end, d.from); assert.equal(c.end, d.from);
  assert.equal(insideSection(b, c.from, model.doc.content.size), true);
  assert.equal(insideSection(b, d.from, model.doc.content.size), false);
  assert.equal(insideSection(d, model.doc.content.size, model.doc.content.size), true);
});
test('duplicate headings have independent keys, retained after ordinary content edits', () => {
  const first = headingSections(parseRichMarkdown('# A\n\none\n\n## B\n\ntwo\n\n## B\n\nthree\n').doc);
  const second = headingSections(parseRichMarkdown('# A\n\nchanged\n\n## B\n\nmore text\n\n## B\n\nthree\n').doc);
  assert.equal(new Set(first.map(s => s.key)).size, 3);
  assert.deepEqual(first.map(s => s.key), second.map(s => s.key));
});
test('empty sections and headings inside lists or quotes are not fold controls', () => {
  assert.equal(headingSections(parseRichMarkdown('# A\n\n## Empty\n').doc).length, 1);
  assert.equal(headingSections(parseRichMarkdown('> # Quoted\n\n- ## List\n').doc).length, 0);
});
test('folding hides review cards and whole blocks but preserves exact source and hunk count', () => {
  const after = '# A\r\n\r\nnew\r\n', model = parseRichMarkdown(after), sections = headingSections(model.doc);
  const plan = inlineChanges(after, model.doc, buildReview(after.replace('new','old'), after).hunks);
  const folded = new Set(sections.map(s => s.key));
  const hidden = (pos: number) => sections.some(s => folded.has(s.key) && insideSection(s, pos, model.doc.content.size));
  const review = reviewDecorations(model.doc, plan, true, new Set(), () => {}, hidden, new Set(sections.map(s => s.from)));
  assert.equal(review.find().filter(d => d.from === d.to).length, plan.length);
  assert.ok(sectionDecorations(model.doc, sections, folded, plan, () => {}).some(d => d.from === sections[0].body));
  assert.equal(serializeRichMarkdown(model, model.doc), after);
});
