import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, TextSelection } from 'prosemirror-state';
import { history, undo, redo } from 'prosemirror-history';
import { parseRichMarkdown, serializeRichMarkdown } from '../src/rich-markdown';
import { normalizeColor, setSelectionColor } from '../src/text-colors';
import { buildReview, confirmHunk, renderMarkdown, revertHunk } from '../src/core';

test('selected text colors and markers save, reload, clear independently and Undo/Redo', () => {
  const model = parseRichMarkdown('これは **重要** な仕様です。\n\nUntouched  \r\n');
  let from = 0; model.doc.descendants((n, pos) => { if (n.text === '重要') from = pos; });
  let state = EditorState.create({ doc: model.doc, selection: TextSelection.create(model.doc, from, from + 2), plugins: [history()] });
  const dispatch = (tr: Parameters<typeof state.apply>[0]) => { state = state.apply(tr); };
  assert.ok(setSelectionColor('textColor', '#3984D5')(state, dispatch));
  assert.ok(setSelectionColor('highlight', '#fff2a8')(state, dispatch));
  const result = serializeRichMarkdown(model, state.doc);
  assert.match(result, /style="color:#3984d5"/); assert.match(result, /style="background-color:#fff2a8"/);
  assert.ok(result.endsWith('Untouched  \r\n'));
  const reopened = parseRichMarkdown(result); let marks: string[] = [];
  reopened.doc.descendants(n => { if (n.text === '重要') marks = n.marks.map(m => m.type.name); });
  assert.deepEqual(marks.sort(), ['highlight', 'strong', 'textColor']);
  setSelectionColor('highlight', null)(state, dispatch);
  assert.doesNotMatch(serializeRichMarkdown(model, state.doc), /<mark/);
  assert.match(serializeRichMarkdown(model, state.doc), /color:#3984d5/);
  undo(state, dispatch); assert.equal(serializeRichMarkdown(model, state.doc), result);
  redo(state, dispatch); assert.doesNotMatch(serializeRichMarkdown(model, state.doc), /<mark/);
});

test('color-only changes are reviewable, confirmable and exactly reversible', () => {
  const before = '期限は30分。\n', after = '期限は<span style="color:#e05252">30分</span>。\n';
  const review = buildReview(before, after);
  assert.equal(review.hunks.length, 1); assert.match(review.html, /変更前/); assert.match(review.html, /color:#e05252/);
  assert.equal(revertHunk(after, review.hunks[0]), before); assert.equal(confirmHunk(before, review.hunks[0]), after);
});

test('nested colors restore their outer color, code and escaped closing tags stay literal', () => {
  const source = '<span style="color:#ff0000">赤<span style="color:#0000ff">青</span>赤 `</span>` \\</span> 後</span>\n';
  const model = parseRichMarkdown(source);
  assert.equal(serializeRichMarkdown(model, model.doc), source);
  const text: [string, string | null][] = [];
  model.doc.descendants(n => { if (n.isText) text.push([n.text!, n.marks.find(m => m.type.name === 'textColor')?.attrs.color || null]); });
  assert.deepEqual(text.slice(0, 3), [['赤', '#ff0000'], ['青', '#0000ff'], ['赤 ', '#ff0000']]);
  assert.equal(text.at(-1)?.[1], '#ff0000');
  assert.match(renderMarkdown(source), /<code>&lt;\/span&gt;<\/code>/);
  const edited = EditorState.create({ doc: model.doc }).tr.insertText('!', model.doc.content.size - 1).doc;
  const saved = serializeRichMarkdown(model, edited);
  assert.equal(parseRichMarkdown(saved).doc.textContent, model.doc.textContent + '!');
});

test('unsupported HTML and unsafe CSS remain literal, even next to valid colors', () => {
  for (const source of [
    '<span style="color:red">bad</span>', '<span style="color:#123456" onclick="alert(1)">bad</span>',
    '<mark style="background-color:url(https://example.com)">bad</mark>', '<span style="color:#123456;background:url(x)">bad</span>',
    '<span style="color:#123456">unclosed', '<script>alert(1)</script>', '<img src=x onerror=alert(1)>',
    '`<mark style="background-color:#fff2a8">code</mark>`',
  ]) {
    const html = renderMarkdown(source);
    assert.doesNotMatch(html, /<(?:span|mark|script|img)[ >]/); assert.match(html, /&lt;/);
    const model = parseRichMarkdown(source);
    model.doc.descendants(n => assert.ok(!n.marks.some(m => ['textColor', 'highlight'].includes(m.type.name))));
    assert.equal(serializeRichMarkdown(model, model.doc), source);
  }
  assert.equal(normalizeColor('red'), null); assert.equal(normalizeColor('#FFFFFF'), '#ffffff');
});

test('colors cross paragraphs and table cells without coloring code or changing other content', () => {
  const source = '# 題名\n\n本文と`code`\n\n| 項目 | 内容 |\n| --- | --- |\n| a | b |\n\n```js\nconst x = 1;\n```\n';
  const model = parseRichMarkdown(source);
  let state = EditorState.create({ doc: model.doc, selection: TextSelection.create(model.doc, TextSelection.atStart(model.doc).from, TextSelection.atEnd(model.doc).to) });
  assert.ok(setSelectionColor('highlight', '#ccdfff')(state, tr => { state = state.apply(tr); }));
  const result = serializeRichMarkdown(model, state.doc);
  const next = parseRichMarkdown(result);
  assert.equal(next.doc.textContent, model.doc.textContent);
  assert.match(result, /<mark style="background-color:#ccdfff">題名/);
  assert.match(result, /\| <mark style="background-color:#ccdfff">a<\/mark>/);
  assert.match(result, /```js\nconst x = 1;\n```/);
  next.doc.descendants((n, _pos, parent) => {
    if (n.marks.some(m => m.type.name === 'code') || parent?.type.name === 'code_block') assert.ok(!n.marks.some(m => m.type.name === 'highlight'));
  });
});

test('partial removal keeps neighboring colors, and empty selections never color future typing', () => {
  const model = parseRichMarkdown('<span style="color:#3984d5">ABCDE</span>\n');
  let state = EditorState.create({ doc: model.doc, selection: TextSelection.create(model.doc, 2, 4) });
  setSelectionColor('textColor', null)(state, tr => { state = state.apply(tr); });
  assert.equal(serializeRichMarkdown(model, state.doc), '<span style="color:#3984d5">A</span>BC<span style="color:#3984d5">DE</span>\n');
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)));
  assert.equal(setSelectionColor('textColor', '#000000')(state), false);
});

test('editing literal tag examples never turns them into active formatting', () => {
  const source = '\\<span style="color:#e05252">example\\</span>\n';
  const model = parseRichMarkdown(source);
  let state = EditorState.create({ doc: model.doc, selection: TextSelection.create(model.doc, TextSelection.atStart(model.doc).from, TextSelection.atEnd(model.doc).to) });
  setSelectionColor('highlight', '#fff2a8')(state, tr => { state = state.apply(tr); });
  const next = parseRichMarkdown(serializeRichMarkdown(model, state.doc));
  assert.equal(next.doc.textContent, model.doc.textContent);
  next.doc.descendants(node => assert.ok(!node.marks.some(m => m.type.name === 'textColor')));
});

test('link labels, punctuation and existing emphasis keep their content after color edits', () => {
  for (const source of ['[**link**](https://example.com/a) and ~~old~~\n', 'a < b & c 😊\n', '**bold _italic_**\n', '| a | b |\n| --- | --- |\n| a\\|b | _value_ |\n']) {
    const model = parseRichMarkdown(source);
    const state = EditorState.create({ doc: model.doc, selection: TextSelection.create(model.doc, TextSelection.atStart(model.doc).from, TextSelection.atEnd(model.doc).to) });
    let next = state;
    setSelectionColor('textColor', '#3984d5')(state, tr => { next = state.apply(tr); });
    const reopened = parseRichMarkdown(serializeRichMarkdown(model, next.doc));
    assert.equal(reopened.doc.textContent, model.doc.textContent);
    const links = (doc: typeof model.doc) => { const values: string[] = []; doc.descendants(n => { for (const m of n.marks) if (m.type.name === 'link') values.push(m.attrs.href); }); return [...new Set(values)]; };
    assert.deepEqual(links(reopened.doc), links(model.doc));
  }
});
