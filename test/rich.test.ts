import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, TextSelection } from 'prosemirror-state';
import { toggleMark, setBlockType, splitBlock } from 'prosemirror-commands';
import { addRowAfter } from 'prosemirror-tables';
import { parseRichMarkdown, serializeRichMarkdown, richSchema, makeTable } from '../src/rich-markdown';
import { minimalEdit } from '../src/text-edit';
import { renderMarkdown } from '../src/core';

function changeWord(source: string, from = 'change', to = 'updated') {
  const model = parseRichMarkdown(source); let position = -1;
  model.doc.descendants((node, pos) => { if (node.isText && node.text!.includes(from)) position = pos + node.text!.indexOf(from); });
  assert.ok(position >= 0);
  const doc = EditorState.create({ doc: model.doc }).tr.insertText(to, position, position + from.length).doc;
  const saved = serializeRichMarkdown(model, doc);
  return { doc, saved, reloaded: parseRichMarkdown(saved).doc };
}

test('editing another table cell preserves every backslash before a pipe, including code spans', () => {
  for (let slashes = 0; slashes <= 5; slashes++) for (const code of [false, true]) {
    const value = 'a' + '\\'.repeat(slashes) + '|b';
    const escaped = (code ? '`' + value + '`' : value.replace(/\\/g, '\\\\')).replace(/\|/g, '\\|');
    const source = `| Key | Value |\n| --- | --- |\n| change | ${escaped} |\n`;
    const { doc, reloaded } = changeWord(source);
    assert.deepEqual(reloaded.firstChild!.child(1).child(1).toJSON(), doc.firstChild!.child(1).child(1).toJSON(), `slashes=${slashes}, code=${code}`);
    assert.equal(reloaded.firstChild!.child(1).child(1).textContent, value);
  }
});

test('cell hard breaks survive saving, reopening and review rendering without enabling arbitrary HTML', () => {
  const model = parseRichMarkdown('| A | B |\n| --- | --- |\n| one | two |\n');
  let pos = -1; model.doc.descendants((node, at) => { if (node.text === 'one') pos = at + 3; });
  const doc = EditorState.create({ doc: model.doc }).tr.insert(pos, richSchema.nodes.hard_break.create()).insertText('line2', pos + 1).doc;
  const saved = serializeRichMarkdown(model, doc);
  assert.match(saved, /one<br>line2/);
  assert.deepEqual(parseRichMarkdown(saved).doc.firstChild!.child(1).toJSON(), doc.firstChild!.child(1).toJSON());
  assert.match(renderMarkdown(saved), /one<br>\n?line2/);
  for (const unsafe of ['<br onclick="alert(1)">', '<img src="x" onerror="alert(1)">', '<script>alert(1)</script>'])
    assert.ok(!renderMarkdown(unsafe).includes(unsafe));
  assert.equal(parseRichMarkdown('`<br>` and \\<br>\n').doc.firstChild!.textContent, '<br> and <br>');
});

test('references inside edited quotes and lists preserve untouched links, images and first-definition precedence', () => {
  for (const container of [
    '> change\n>\n> [ref]: https://example.com/spec "original"\n',
    '- change\n\n  [ref]: https://example.com/spec "original"\n',
    '> change\n>\n> [ref]: https://example.com/spec "original"\n\n[ref]: https://example.com/wrong\n',
    '> change\n>\n> [ref]: https://example.com/?literal=\\&copy; "literal \\&copy;"\n',
  ]) {
    const source = container + '\nRead [spec][ref].\n\n![diagram][ref]\n';
    const { doc, saved, reloaded } = changeWord(source);
    assert.deepEqual(reloaded.child(1).toJSON(), doc.child(1).toJSON());
    assert.deepEqual(reloaded.child(2).toJSON(), doc.child(2).toJSON());
    assert.ok(saved.includes('https://example.com/'));
    assert.equal(serializeRichMarkdown(parseRichMarkdown(saved), reloaded), saved);
  }
});

test('deleting a reference-defining container preserves the target and title of surviving links', () => {
  const source = '> change\n>\n> [a\\]b]: <https://example.com/a%20b> "quoted \\"title\\""\n\n[link][a\\]b]\n';
  const model = parseRichMarkdown(source);
  const doc = EditorState.create({ doc: model.doc }).tr.delete(0, model.doc.firstChild!.nodeSize).doc;
  const saved = serializeRichMarkdown(model, doc), reloaded = parseRichMarkdown(saved).doc;
  assert.deepEqual(reloaded.firstChild!.content.toJSON(), doc.firstChild!.content.toJSON());
  assert.ok(reloaded.firstChild!.firstChild!.marks.some(m => m.type.name === 'link'));
});

const examples = [
  '', '\n\n', '# 設計書\n\n本文。\n', '見出し\n=====\n\n* one\n* two\n',
  '# CRLF\r\n\r\n本文\r\n', '**太字**と_斜体_と`code`\n',
  '> 引用\n>\n> 次の行\n\n1. one\n2. two\n',
  '[参考][ref]\n\n[ref]: https://example.com "資料"\n',
  '[ref]: https://example.com\n\n本文\n',
  '| 項目 | 値 |\n| :--- | ---: |\n| 期限 | 30分 |\n',
  '```ts\nconst a = 1;\n```\n\n![画像](https://example.com/image.png)\n',
  '<script>alert(1)</script>\n\n- [ ] todo\n',
];
for (const [i, source] of examples.entries()) test(`unchanged rich Markdown preserves every byte ${i}`, () => {
  const model = parseRichMarkdown(source);
  assert.equal(serializeRichMarkdown(model, model.doc), source);
  assert.ok(model.doc.type.validContent(model.doc.content));
});
test('editing one paragraph preserves other source spelling and spacing', () => {
  const source = '題名\n====\n\n\n* 元のリスト\n* そのまま\n\n本文は旧です。\n';
  const model = parseRichMarkdown(source);
  const state = EditorState.create({ doc: model.doc });
  let position = 0;
  state.doc.descendants((node, pos) => { if (node.isText && node.text!.includes('旧')) position = pos + node.text!.indexOf('旧'); });
  const next = state.tr.insertText('新', position, position + 1).doc;
  assert.equal(serializeRichMarkdown(model, next), source.replace('旧', '新'));
});
test('bold, headings and inserted paragraphs serialize to Markdown', () => {
  const model = parseRichMarkdown('hello world\n');
  let state = EditorState.create({ doc: model.doc, selection: TextSelection.create(model.doc, 1, 6) });
  toggleMark(richSchema.marks.strong)(state, tr => { state = state.apply(tr); });
  assert.equal(serializeRichMarkdown(model, state.doc), '**hello** world\n');
  setBlockType(richSchema.nodes.heading, { level: 2 })(state, tr => { state = state.apply(tr); });
  assert.equal(serializeRichMarkdown(model, state.doc), '## **hello** world\n');
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 7)));
  splitBlock(state, tr => { state = state.apply(tr); });
  assert.match(serializeRichMarkdown(model, state.doc), /\n\n/);
});
test('table cells and added rows round-trip without dropping cells', () => {
  const source = '| 項目 | 値 |\n| :--- | ---: |\n| 期限 | 30分 |\n';
  const model = parseRichMarkdown(source);
  let state = EditorState.create({ doc: model.doc });
  let pos = 0;
  state.doc.descendants((node, p) => { if (node.isText && node.text === '30分') pos = p; });
  state = state.apply(state.tr.insertText('24時間', pos, pos + 3));
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
  addRowAfter(state, tr => { state = state.apply(tr); });
  const result = serializeRichMarkdown(model, state.doc);
  assert.match(result, /24時間/); assert.match(result, /:--- \| ---:/);
  assert.equal(parseRichMarkdown(result).doc.firstChild!.childCount, 3);
});
test('reference definitions survive editing or deleting their neighboring paragraph', () => {
  const source = 'first\n\n[ref]: https://example.com\n\n[link][ref]\n';
  const model = parseRichMarkdown(source);
  let state = EditorState.create({ doc: model.doc });
  state = state.apply(state.tr.delete(0, state.doc.firstChild!.nodeSize));
  const result = serializeRichMarkdown(model, state.doc);
  assert.match(result, /\[ref\]: https:\/\/example.com/);
  assert.match(result, /\[link\]\[ref\]/);
});
test('table creation produces a valid Markdown table', () => {
  const model = parseRichMarkdown('');
  const next = richSchema.node('doc', null, [makeTable()]);
  const result = serializeRichMarkdown(model, next);
  assert.equal(parseRichMarkdown(result).doc.firstChild!.type.name, 'table');
});
test('CRLF and emoji survive minimal source replacements', () => {
  for (const [before, after] of [['a😊b', 'a😄b'], ['a\r\nb', 'a\r\nnew\r\nb'], ['old', 'new'], ['', 'a'], ['abc', '']]) {
    const edit = minimalEdit(before, after);
    assert.equal(before.slice(0, edit.start) + edit.text + before.slice(edit.end), after);
    assert.ok(!/^[\uDC00-\uDFFF]$/.test(before[edit.start] ?? ''));
  }
});

test('strikethrough is rendered and preserved when surrounding text changes', () => {
  const model = parseRichMarkdown('~~old~~ and new\n');
  assert.equal(model.doc.firstChild!.firstChild!.marks[0].type.name, 'strike');
  const next = EditorState.create({ doc: model.doc }).tr.insertText('!', model.doc.content.size - 1).doc;
  assert.equal(serializeRichMarkdown(model, next), '~~old~~ and new!\n');
});

test('table alignment from a body cell updates the header separator and all rows', async () => {
  const { alignTableColumns } = await import('../src/rich-table');
  const source = '| Name | Value |\n| --- | --- |\n| first | 42 |\n| second | 100 |\n';
  const model = parseRichMarkdown(source);
  let position = 0; model.doc.descendants((node, pos) => { if (node.text === '42') position = pos; });
  let state = EditorState.create({ doc: model.doc, selection: TextSelection.create(model.doc, position) });
  assert.ok(alignTableColumns('right')(state, tr => { state = state.apply(tr); }));
  const result = serializeRichMarkdown(model, state.doc);
  assert.match(result, /\| --- \| ---: \|/);
  parseRichMarkdown(result).doc.firstChild!.forEach(row => assert.equal(row.child(1).attrs.align, 'right'));
});

test('nested task items preserve original bytes and serialize checkbox edits', () => {
  const source = '- [ ] pending\n  - [X] done\n\nordinary\n';
  const model = parseRichMarkdown(source);
  assert.equal(serializeRichMarkdown(model, model.doc), source);
  assert.equal(model.doc.firstChild!.firstChild!.attrs.checked, false);
  let pos = -1; model.doc.descendants((node, offset) => { if (node.type === richSchema.nodes.list_item && node.attrs.checked === false) pos = offset; });
  const state = EditorState.create({ doc: model.doc });
  const next = state.tr.setNodeMarkup(pos, undefined, { checked: true }).doc;
  const result = serializeRichMarkdown(model, next);
  assert.match(result, /\[x\] pending/); assert.match(result, /\[x\] done/); assert.match(result, /ordinary/);
});
