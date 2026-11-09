import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, TextSelection } from 'prosemirror-state';
import { toggleMark } from 'prosemirror-commands';
import { parseRichMarkdown, serializeRichMarkdown, richSchema, parseInlineMarkdown } from '../src/rich-markdown';
import { renderMarkdown, buildReview, countChanges } from '../src/core';
import { frontMatterRows, headingSlug } from '../src/markdown-syntax';

/** Replace one word through the editor model, as typing in Preview does. */
function edit(source: string, from = 'change', to = 'CHANGED') {
  const model = parseRichMarkdown(source); let position = -1;
  model.doc.descendants((node, pos) => { if (position < 0 && node.isText && node.text!.includes(from)) position = pos + node.text!.indexOf(from); });
  assert.ok(position >= 0, `"${from}" is editable text in ${JSON.stringify(source)}`);
  const doc = EditorState.create({ doc: model.doc }).tr.insertText(to, position, position + from.length).doc;
  return serializeRichMarkdown(model, doc);
}
const unchangedApartFromTheEdit = (source: string, from = 'change', to = 'CHANGED') => assert.equal(edit(source, from, to), source.replace(from, to));

const preserved: [string, string][] = [
  ['hard-wrapped English paragraph', 'This change is a long paragraph that\nis hard-wrapped at a fixed\ncolumn width.\n'],
  ['hard-wrapped Japanese paragraph', '日本語の文章を change\n途中で改行しています。\n'],
  ['wrapped quote and list continuation', '> change one\n> line two\n\n- item change\n    indented continuation\n- two\n'],
  ['inline HTML', 'Press <kbd>Ctrl</kbd>+<kbd>C</kbd> to change <img src="a.png" width="100">.\n'],
  ['HTML comment', 'text <!-- keep me --> change\n'],
  ['GitHub alert', '> [!WARNING]\n> change this setting first.\n'],
  ['footnotes', 'Text change[^note].\n\n[^note]: Footnote text\n    continued.\n'],
  ['footnote definition', '[^1]: change the note\n'],
  ['wiki links', 'See [[Other Page|alias]] and change [[Plain]].\n'],
  ['inline math', 'Euler $e^{i\\pi}+1=0$ and $a_1 * b_2$ change.\n'],
  ['entities and kept escapes', 'Copy &copy; 2024 &amp; \\$5 \\# change\n'],
  ['bullet markers', '+ change\n+ two\n\n* three\n'],
  ['ordered delimiter', '1) change\n2) two\n'],
  ['underscore emphasis', '__bold__ and _change_ word\n'],
  ['setext heading', 'Title change\n============\n'],
  ['multi-line setext heading', 'Line one change\nline two\n---\n'],
  ['two-space hard break', 'line change  \nline two\n'],
  ['br hard break', 'a<br>b change and c<br/>\nd\n'],
  ['heading with HTML and math', '# Title change <kbd>x</kbd> $y$<br>Sub\n'],
  ['table padding and delimiter', '| Name   | Value |\n|:-------|------:|\n| change | 1     |\n| keep   | 22    |\n'],
  ['code block first in a list item', '- ```js\n  x\n  ```\n- change\n'],
  ['HTML block first in a list item', '- <div>x</div>\n- change\n'],
];
for (const [name, source] of preserved) test(`editing keeps ${name}`, () => {
  const model = parseRichMarkdown(source);
  assert.equal(serializeRichMarkdown(model, model.doc), source);
  unchangedApartFromTheEdit(source);
});

test('raw blocks keep front matter, math and HTML when their own text is edited', () => {
  unchangedApartFromTheEdit('---\ntitle: change\ntags: [a, b]\n---\n\n# Body\n');
  unchangedApartFromTheEdit('+++\ntitle = "change"\n+++\n\nBody\n');
  unchangedApartFromTheEdit('$$\n\\sum_{change}^n x_i * y_i\n$$\n');
  unchangedApartFromTheEdit('$$x_change$$\n');
  unchangedApartFromTheEdit('<details>\n<summary>change</summary>\n\nHidden body\n\n</details>\n');
  unchangedApartFromTheEdit('~~~js\nconst change = 1;\n~~~\n');
  unchangedApartFromTheEdit('    indented change\n    code\n');
  unchangedApartFromTheEdit('* * *\n\nchange\n');
  const model = parseRichMarkdown('---\ntitle: x\n---\n\nbody\n');
  assert.equal(model.doc.firstChild!.type.name, 'raw_block');
  assert.equal(model.doc.firstChild!.attrs.kind, 'frontmatter');
});

test('a leading thematic break without metadata is not front matter', () => {
  const model = parseRichMarkdown('---\n\nNot front matter\n---\n');
  assert.equal(model.doc.firstChild!.type.name, 'horizontal_rule');
  assert.match(renderMarkdown('---\n\nText\n'), /^<hr>/);
});

test('underscore emphasis falls back to asterisks where it would not parse', () => {
  const model = parseRichMarkdown('_word_\n');
  const doc = EditorState.create({ doc: model.doc }).tr.insert(model.doc.content.size - 1, richSchema.text('x')).doc;
  const saved = serializeRichMarkdown(model, doc);
  assert.equal(saved, '*word*x\n');
  assert.equal(parseRichMarkdown(saved).doc.firstChild!.firstChild!.marks[0].type.name, 'em');
});

test('new lists use the document bullet, and new emphasis uses asterisks', () => {
  const model = parseRichMarkdown('+ one\n\nhello world\n');
  let state = EditorState.create({ doc: model.doc });
  const paragraph = model.doc.child(1);
  const start = model.doc.child(0).nodeSize + 1;
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, start, start + 5)));
  toggleMark(richSchema.marks.strong)(state, tr => { state = state.apply(tr); });
  const list = richSchema.nodes.bullet_list.create({ tight: true }, richSchema.nodes.list_item.create(null, richSchema.nodes.paragraph.create(null, richSchema.text('new'))));
  state = state.apply(state.tr.insert(state.doc.content.size, list));
  assert.equal(paragraph.textContent, 'hello world');
  assert.equal(serializeRichMarkdown(model, state.doc), '+ one\n\n**hello** world\n\n+ new\n');
});

test('soft breaks never let following text start a new block', () => {
  const model = parseRichMarkdown('first\nsecond\n');
  const paragraph = model.doc.firstChild!;
  const replaced = richSchema.node('doc', null, [richSchema.nodes.paragraph.create({ sourceId: '0' }, [paragraph.child(0), paragraph.child(1), richSchema.text('# not a heading')])]);
  const saved = serializeRichMarkdown(model, replaced);
  assert.equal(saved, 'first # not a heading\n');
  assert.equal(parseRichMarkdown(saved).doc.firstChild!.type.name, 'paragraph');
});

test('documents whose blocks the editor cannot represent are refused instead of emptied', () => {
  for (const source of ['# Title<br>Sub\n', 'Line\nline\n---\n', '# a $x$ [^1] <b>c</b>\n']) {
    const model = parseRichMarkdown(source);
    assert.equal(model.doc.firstChild!.type.name, 'heading');
    assert.ok(model.doc.textContent.length > 0);
  }
});

test('raw inline syntax can be replaced from Markdown text', () => {
  const nodes = parseInlineMarkdown('$x_1$ and [^2]')!;
  assert.deepEqual(nodes.map(n => n.type.name), ['raw_inline', 'text', 'raw_inline']);
  assert.equal(parseInlineMarkdown('a\nb'), undefined);
  assert.equal(parseInlineMarkdown('# heading'), undefined);
});

test('review rendering shows front matter, alerts, footnotes and math safely', () => {
  assert.match(renderMarkdown('---\ntitle: Hello\n---\n'), /<th>title<\/th><td>Hello<\/td>/);
  assert.match(renderMarkdown('> [!TIP]\n> text\n'), /markdown-alert-tip/);
  assert.match(renderMarkdown('a[^1]\n'), /<sup class="footnote-ref"[^>]*>1<\/sup>/);
  assert.match(renderMarkdown('$x_1$\n'), /class="math-inline" data-math="x_1"/);
  assert.match(renderMarkdown('$$\nx\n$$\n'), /class="math-block" data-math="x"/);
  assert.match(renderMarkdown('<kbd>K</kbd>\n'), /<kbd>K<\/kbd>/);
  assert.match(renderMarkdown('visit https://example.com now\n'), /<span class="md-link" data-href="https:\/\/example.com"/);
  for (const unsafe of ['<img src=x onerror=alert(1)>', '<kbd onclick="x">a</kbd>', '<div style="x">a</div>', '<script>alert(1)</script>', '<a href="javascript:x">a</a>'])
    assert.ok(!/<(img|kbd onclick|div|script|a) /.test(renderMarkdown(unsafe)), unsafe);
  assert.ok(!renderMarkdown('$x$ costs $5 and $10\n').includes('data-math="5'));
});

test('count-only planning agrees with the rendered review', () => {
  const before = '# A\n\none\n\ntwo\n\n| a | b |\n| - | - |\n| 1 | 2 |\n', after = '# A\n\none!\n\n| a | b |\n| - | - |\n| 1 | 3 |\n\ntwo\n';
  assert.equal(countChanges(before, after), buildReview(before, after).hunks.length);
  assert.equal(countChanges('a\n', 'a\r\n'), 1);
});

test('front matter rows and heading slugs', () => {
  assert.deepEqual(frontMatterRows('title: A\nlist:\n  - one\n  - two\n'), [{ key: 'title', value: 'A' }, { key: 'list', value: '- one\n- two' }]);
  assert.equal(headingSlug('Hello, World! 日本語'), 'hello-world-日本語');
  assert.equal(headingSlug('API v2.0 (beta)'), 'api-v20-beta');
});
