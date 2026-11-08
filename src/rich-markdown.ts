import MarkdownIt from 'markdown-it';
import Token from 'markdown-it/lib/token.mjs';
import { Schema, Node as PMNode, Mark, NodeSpec, MarkSpec, DOMOutputSpec, TagParseRule } from 'prosemirror-model';
import { schema as commonSchema, defaultMarkdownParser, defaultMarkdownSerializer, MarkdownParser, MarkdownSerializer, MarkdownSerializerState } from 'prosemirror-markdown';
import { withoutNumbering } from './table-numbering';
import { tableNodes } from 'prosemirror-tables';
import { colorMarkdown, flattenColorTokens, colorMarks, colorOpen, colorClose } from './text-colors';
import { markdownBreaks } from './markdown-breaks';
import { markdownSyntax, type RawMeta } from './markdown-syntax';
import { splitRow } from './cell-review';
import { limits, byteLength } from './limits';
import { t } from './i18n';

type Attrs = Record<string, { default: unknown }>;
/** Keep source-only attributes through copy/paste by mirroring them as data attributes. */
function preserve<T extends NodeSpec | MarkSpec>(spec: T, extra: Attrs): T {
  const names = Object.keys(extra);
  const read = (dom: HTMLElement) => Object.fromEntries(names.filter(n => dom.hasAttribute(`data-md-${n}`)).map(n => [n, dom.getAttribute(`data-md-${n}`)]));
  const toDOM = spec.toDOM as ((value: PMNode & Mark, inline: boolean) => DOMOutputSpec) | undefined;
  return {
    ...spec,
    attrs: { ...spec.attrs, ...extra },
    parseDOM: spec.parseDOM?.map(rule => {
      const tag = rule as TagParseRule;
      return { ...tag, getAttrs: (dom: HTMLElement) => {
        const base = tag.getAttrs ? tag.getAttrs(dom) : tag.attrs ?? {};
        return base === false ? false : { ...(base ?? {}), ...read(dom) };
      } };
    }),
    toDOM: toDOM && ((value: PMNode & Mark, inline: boolean) => {
      const out = toDOM(value, inline);
      if (!Array.isArray(out)) return out;
      const data = Object.fromEntries(names.filter(n => value.attrs[n] !== null && value.attrs[n] !== undefined && value.attrs[n] !== false).map(n => [`data-md-${n}`, String(value.attrs[n])]));
      const [tag, maybeAttrs, ...rest] = out as [string, ...unknown[]];
      return maybeAttrs && typeof maybeAttrs === 'object' && !Array.isArray(maybeAttrs) && !(typeof Node !== 'undefined' && maybeAttrs instanceof Node)
        ? [tag, { ...maybeAttrs as object, ...data }, ...rest] as DOMOutputSpec
        : [tag, data, ...(maybeAttrs === undefined ? [] : [maybeAttrs]), ...rest] as DOMOutputSpec;
    }),
  };
}

let nodes = commonSchema.spec.nodes.append(tableNodes({ tableGroup: 'block', cellContent: 'paragraph', cellAttributes: {
  align: { default: null, getFromDOM: dom => dom.getAttribute('data-align'), setDOMAttr: (value, attrs) => { if (value) attrs['data-align'] = value; } },
} }));
nodes = nodes.update('table', { ...nodes.get('table'), attrs: { ...nodes.get('table')!.attrs, numberColumn: { default: null } } } as NodeSpec);
// Headings hold any inline syntax, including line breaks, HTML, math and footnotes.
nodes = nodes.update('heading', preserve({ ...nodes.get('heading')!, content: 'inline*' }, { markup: { default: null } }));
nodes = nodes.update('bullet_list', preserve(nodes.get('bullet_list')!, { bullet: { default: null } }));
nodes = nodes.update('ordered_list', preserve(nodes.get('ordered_list')!, { delimiter: { default: null } }));
nodes = nodes.update('code_block', preserve(nodes.get('code_block')!, { fence: { default: null } }));
nodes = nodes.update('horizontal_rule', preserve(nodes.get('horizontal_rule')!, { markup: { default: null } }));
nodes = nodes.update('hard_break', preserve(nodes.get('hard_break')!, { markup: { default: null }, indent: { default: null } }));

nodes = nodes.append({
  // A source line break inside a paragraph. It displays as a space, like rendered Markdown.
  soft_break: { inline: true, group: 'inline', selectable: false, leafText: () => ' ', attrs: { indent: { default: null } },
    parseDOM: [{ tag: 'span[data-md-softbreak]', getAttrs: dom => ({ indent: dom.getAttribute('data-md-softbreak') || null }) }],
    toDOM: node => ['span', { class: 'md-softbreak', 'data-md-softbreak': node.attrs.indent ?? '' }, ' '] },
  // HTML, footnotes, math, wiki links, alerts, entities: kept byte for byte.
  raw_inline: { inline: true, group: 'inline', atom: true, selectable: true,
    attrs: { source: { default: '' }, kind: { default: 'html' }, text: { default: null } },
    leafText: node => node.attrs.text ?? node.attrs.source,
    parseDOM: [{ tag: 'span[data-md-raw]', getAttrs: dom => ({ source: dom.getAttribute('data-md-raw'), kind: dom.getAttribute('data-md-raw-kind') ?? 'html', text: dom.getAttribute('data-md-raw-text') }) }],
    toDOM: node => ['span', { class: 'raw-inline', 'data-md-raw': node.attrs.source, 'data-md-raw-kind': node.attrs.kind, ...(node.attrs.text !== null ? { 'data-md-raw-text': node.attrs.text } : {}) }, node.attrs.text ?? node.attrs.source] },
  raw_block: { group: 'block', content: 'text*', marks: '', code: true, defining: true,
    attrs: { kind: { default: 'html' }, open: { default: null }, close: { default: null }, single: { default: false } },
    parseDOM: [{ tag: 'pre[data-md-raw-block]', preserveWhitespace: 'full', getAttrs: dom => ({ kind: dom.getAttribute('data-md-raw-block'), open: dom.getAttribute('data-md-open'), close: dom.getAttribute('data-md-close'), single: dom.hasAttribute('data-md-single') }) }],
    toDOM: node => ['pre', { class: `raw-block raw-${node.attrs.kind}`, 'data-md-raw-block': node.attrs.kind, ...(node.attrs.open ? { 'data-md-open': node.attrs.open } : {}), ...(node.attrs.close ? { 'data-md-close': node.attrs.close } : {}), ...(node.attrs.single ? { 'data-md-single': '' } : {}) }, ['code', 0]] },
});
// IDs live only in the editor model, never in the saved Markdown.
nodes.forEach((name, spec) => {
  if (spec.group === 'block') nodes = nodes.update(name, { ...spec, attrs: { ...spec.attrs, sourceId: { default: null } } });
});
nodes = nodes.update('list_item', { ...nodes.get('list_item'), attrs: { checked: { default: null } },
  parseDOM: [{ tag: 'li[data-checked]', getAttrs: dom => ({ checked: dom.getAttribute('data-checked') === 'true' }), contentElement: dom => dom.querySelector(':scope > div') as HTMLElement ?? dom }, ...nodes.get('list_item')!.parseDOM!],
  toDOM: node => node.attrs.checked === null ? ['li', 0] : ['li', { class: 'task-item', 'data-checked': String(node.attrs.checked) },
    ['input', { type: 'checkbox', 'data-task': 'true', 'aria-label': t('タスクの完了'), contenteditable: 'false', ...(node.attrs.checked ? { checked: '' } : {}) }], ['div', 0]],
} as NodeSpec);
nodes = nodes.update('image', { ...nodes.get('image'),
  parseDOM: [{ tag: 'span[data-md-image]', getAttrs: dom => ({ src: dom.getAttribute('data-md-image'), alt: dom.getAttribute('data-md-alt'), title: dom.getAttribute('data-md-title') }) }, ...nodes.get('image')!.parseDOM!],
  toDOM: node => ['span', { class: 'image-placeholder', contenteditable: 'false', 'data-md-image': node.attrs.src, 'data-md-alt': node.attrs.alt, 'data-md-title': node.attrs.title }, `${t('画像')}: ${node.attrs.alt || ''} (${node.attrs.src})`],
} as NodeSpec);
const marks = commonSchema.spec.marks.remove('code')
  .update('em', preserve(commonSchema.spec.marks.get('em')!, { markup: { default: null } }))
  .update('strong', preserve(commonSchema.spec.marks.get('strong')!, { markup: { default: null } }))
  .update('link', {
    ...commonSchema.spec.marks.get('link'),
    parseDOM: [{ tag: 'a[data-href]', getAttrs: dom => ({ href: dom.getAttribute('data-href'), title: dom.getAttribute('data-md-link-title') }) }, ...commonSchema.spec.marks.get('link')!.parseDOM!],
    // Inert links: editing never navigates by itself; the host validates explicit link opening.
    toDOM: mark => ['a', { 'data-href': mark.attrs.href, 'data-md-link-title': mark.attrs.title, title: mark.attrs.title ?? mark.attrs.href }, 0],
  });
export const richSchema = new Schema({ nodes, marks: marks.append({ strike: { parseDOM: [{ tag: 's' }, { tag: 'del' }], toDOM: () => ['s', 0] }, ...colorMarks, code: commonSchema.spec.marks.get('code')! }) });

const tokenizer = new MarkdownIt('commonmark', { html: true }).enable(['table', 'strikethrough']);
tokenizer.use(colorMarkdown).use(flattenColorTokens).use(markdownBreaks).use(markdownSyntax);
tokenizer.core.ruler.before('inline', 'task_items', state => {
  for (let i = 0; i < state.tokens.length; i++) {
    const item = state.tokens[i], inline = state.tokens[i + 2];
    if (item.type !== 'list_item_open' || state.tokens[i + 1]?.type !== 'paragraph_open' || inline?.type !== 'inline') continue;
    const match = /^\[([ xX])\] (.*)/s.exec(inline.content);
    if (match) { item.attrSet('checked', String(match[1] !== ' ')); inline.content = match[2]; }
  }
});
tokenizer.core.ruler.after('inline', 'table_paragraphs', state => {
  const expanded: Token[] = [];
  let cell = false;
  for (const token of state.tokens) {
    if (token.type === 'th_open' || token.type === 'td_open') cell = true;
    if (token.type === 'th_close' || token.type === 'td_close') cell = false;
    // `<br>` is the only line break a table cell can hold, so it is the default there.
    if (cell && token.type === 'inline') for (const child of token.children ?? []) if (child.type === 'hardbreak') child.meta = { ...child.meta, cell: true };
    if (token.type === 'th_close' || token.type === 'td_close') expanded.push(new Token('paragraph_close', 'p', -1));
    expanded.push(token);
    if (token.type === 'th_open' || token.type === 'td_open') expanded.push(new Token('paragraph_open', 'p', 1));
  }
  state.tokens = expanded;
});
/** A list is tight when its own paragraphs are hidden; a list without paragraphs counts as tight. */
const listIsTight = (tokens: Token[], i: number) => {
  const level = tokens[i].level;
  for (let j = i + 1; j < tokens.length && !(tokens[j].level === level && tokens[j].nesting === -1); j++)
    if (tokens[j].type === 'paragraph_open' && tokens[j].level === level + 2) return tokens[j].hidden;
  return true;
};
const rawText = (meta: RawMeta, source: string): string | null => {
  switch (meta.kind) {
    case 'entity': case 'escape': return meta.text ?? null;
    case 'wiki': return meta.label ?? null;
    case 'math': return meta.math ?? null;
    default: return source === (meta.text ?? source) ? null : meta.text ?? null;
  }
};
const parser = new MarkdownParser(richSchema, tokenizer, {
  ...defaultMarkdownParser.tokens,
  list_item: { block: 'list_item', getAttrs: token => ({ checked: token.attrGet('checked') === null ? null : token.attrGet('checked') === 'true' }) }, s: { mark: 'strike' },
  bullet_list: { block: 'bullet_list', getAttrs: (token, tokens, i) => ({ tight: listIsTight(tokens, i), bullet: token.markup || null }) },
  ordered_list: { block: 'ordered_list', getAttrs: (token, tokens, i) => ({ order: +(token.attrGet('start') ?? 1) || 1, tight: listIsTight(tokens, i), delimiter: token.markup === ')' ? ')' : null }) },
  heading: { block: 'heading', getAttrs: token => ({ level: +token.tag.slice(1), markup: token.meta?.underline ?? null }) },
  code_block: { block: 'code_block', noCloseToken: true, getAttrs: () => ({ fence: 'indent' }) },
  fence: { block: 'code_block', noCloseToken: true, getAttrs: token => ({ params: token.info || '', fence: token.markup === '```' ? null : token.markup }) },
  hr: { node: 'horizontal_rule', getAttrs: token => ({ markup: token.meta?.rule ?? null }) },
  hardbreak: { node: 'hard_break', getAttrs: token => ({ markup: !token.markup || token.markup === '\\' || (token.meta?.cell && token.markup === '<br>') ? null : token.markup, indent: token.meta?.indent ?? null }) },
  softbreak: { node: 'soft_break', getAttrs: token => ({ indent: token.meta?.indent ?? null }) },
  em: { mark: 'em', getAttrs: token => ({ markup: token.markup === '_' ? '_' : null }) },
  strong: { mark: 'strong', getAttrs: token => ({ markup: token.markup === '__' ? '__' : null }) },
  md_raw: { node: 'raw_inline', getAttrs: token => ({ source: token.content, kind: (token.meta as RawMeta).kind, text: rawText(token.meta as RawMeta, token.content) }) },
  html_block: { block: 'raw_block', noCloseToken: true, getAttrs: token => ({ kind: /^\s*<!--/.test(token.content) ? 'comment' : 'html' }) },
  front_matter: { block: 'raw_block', noCloseToken: true, getAttrs: token => ({ kind: 'frontmatter', open: token.markup, close: token.info }) },
  math_block: { block: 'raw_block', noCloseToken: true, getAttrs: token => ({ kind: 'math', single: !!token.meta?.single }) },
  textColor: { mark: 'textColor', getAttrs: token => ({ color: token.attrGet('color') }) },
  highlight: { mark: 'highlight', getAttrs: token => ({ color: token.attrGet('color') }) },
  table: { block: 'table' }, thead: { ignore: true }, tbody: { ignore: true }, tr: { block: 'table_row' },
  th: { block: 'table_header', getAttrs: t => ({ align: t.attrGet('style')?.replace('text-align:', '') ?? null }) },
  td: { block: 'table_cell', getAttrs: t => ({ align: t.attrGet('style')?.replace('text-align:', '') ?? null }) },
});

interface TableSource { rows: Map<string, string>; lines: string[]; delimiter: string; alignment: string }
type State = MarkdownSerializerState & { emphasis?: Record<string, string>; options: { bullet?: string; table?: TableSource } };
const wordChar = /[\p{L}\p{N}]/u;
/** Underscore emphasis only works at word boundaries; fall back to asterisks elsewhere. */
function emphasis(type: 'em' | 'strong', star: string, underscore: string) {
  return {
    open(state: State, mark: Mark, parent: PMNode, index: number) {
      let char = star;
      if (mark.attrs.markup === underscore) {
        let end = index; while (end < parent.childCount && mark.isInSet(parent.child(end).marks)) end++;
        const before = index > 0 ? parent.child(index - 1) : undefined, after = end < parent.childCount ? parent.child(end) : undefined;
        const touching = (before?.isText && wordChar.test(before.text!.slice(-1))) || (after?.isText && wordChar.test(after.text![0]));
        if (!touching) char = underscore;
      }
      (state.emphasis ??= {})[type] = char;
      return char;
    },
    close(state: State) { return state.emphasis?.[type] ?? star; },
    mixable: true, expelEnclosingWhitespace: true,
  };
}
const rowSignature = (row: PMNode) => JSON.stringify(row.content.toJSON());
const alignmentSignature = (table: PMNode) => { const cells: unknown[] = []; table.firstChild?.forEach(cell => cells.push(cell.attrs.align)); return JSON.stringify(cells); };
const lineStartSyntax = /^\s*([#>=+\-]|\d+[.)](\s|$)|`{3}|~{3}|\|)/;
const setext = (node: PMNode) => typeof node.attrs.markup === 'string' && node.attrs.level <= 2 && (node.attrs.level === 1 ? /^=+$/ : /^-+$/).test(node.attrs.markup) && node.textContent.trim() !== '';
function fenceFor(node: PMNode): string {
  const text = node.textContent, params = node.attrs.params || '';
  let fence: string = typeof node.attrs.fence === 'string' && /^(`{3,}|~{3,})$/.test(node.attrs.fence) ? node.attrs.fence : '```';
  if (fence[0] === '`' && params.includes('`')) fence = '~~~';
  const char = fence[0] === '`' ? '`' : '~';
  while (new RegExp(`^\\s{0,3}\\${char}{${fence.length},}`, 'm').test(text)) fence += char;
  return fence;
}
const nodeSerializers: Record<string, (state: State, node: PMNode, parent: PMNode, index: number) => void> = {
  ...defaultMarkdownSerializer.nodes as unknown as Record<string, (state: State, node: PMNode, parent: PMNode, index: number) => void>,
  list_item(state, node) { if (node.attrs.checked !== null) state.write(node.attrs.checked ? '[x] ' : '[ ] '); state.renderContent(node); },
  heading(state, node) {
    if (setext(node)) { state.renderInline(node); state.write('\n'); state.write(node.attrs.markup); state.closeBlock(node); return; }
    state.write(state.repeat('#', node.attrs.level) + ' '); state.renderInline(node, false); state.closeBlock(node);
  },
  bullet_list(state, node) { state.renderList(node, '  ', () => (node.attrs.bullet || state.options.bullet || '-') + ' '); },
  ordered_list(state, node) {
    const start = node.attrs.order ?? 1, width = String(start + node.childCount - 1).length, delimiter = node.attrs.delimiter === ')' ? ')' : '.';
    state.renderList(node, state.repeat(' ', width + 2), i => { const n = String(start + i); return state.repeat(' ', width - n.length) + n + delimiter + ' '; });
  },
  code_block(state, node) {
    const text = node.textContent;
    if (node.attrs.fence === 'indent' && !node.attrs.params && text.trim()) {
      state.text(text.split('\n').map(line => line ? '    ' + line : '').join('\n'), false); state.closeBlock(node); return;
    }
    const fence = fenceFor(node);
    state.write(fence + (node.attrs.params || '') + '\n'); state.text(text, false); state.write('\n'); state.write(fence); state.closeBlock(node);
  },
  hard_break(state, node, parent, index) {
    for (let i = index + 1; i < parent.childCount; i++) if (parent.child(i).type !== node.type) {
      const markup = node.attrs.markup as string | null;
      if (parent.type.name === 'heading' || (markup && /^<br\s*\/?\s*>$/i.test(markup))) state.write(markup && markup.startsWith('<') ? markup : '<br>');
      else { state.write(markup === '  ' ? '  \n' : '\\\n'); if (node.attrs.indent) state.write(node.attrs.indent); }
      return;
    }
  },
  soft_break(state, node, parent, index) {
    const next = index + 1 < parent.childCount ? parent.child(index + 1) : undefined;
    if (!next) return;
    // A heading is one line, and some text would start a new block on a fresh line.
    const joined = (parent.type.name === 'heading' && !setext(parent)) || (next.isText && lineStartSyntax.test(next.text!));
    state.write(joined ? ' ' : '\n');
    if (!joined && node.attrs.indent) state.write(node.attrs.indent);
  },
  table(state, node) {
    // Unchanged rows and an unchanged delimiter row keep their exact source text, including padding.
    const source = state.options.table;
    node.forEach((row, _offset, rowIndex) => {
      const kept = source?.rows.get(rowSignature(row));
      if (kept !== undefined) state.write(kept + '\n');
      else {
        const cells: string[] = [];
        row.forEach(cell => {
          const text = cellSerializer.serialize(richSchema.node('doc', null, cell.content));
          // Markdown's table parser removes one escape before every pipe, even
          // inside code. Add that escape independently of inline serialization.
          cells.push(text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' '));
        });
        // An edited row keeps the padding of the source row at the same position.
        const line = source?.lines[rowIndex], spans = line === undefined ? [] : splitRow(line);
        if (line !== undefined && spans.length === cells.length) {
          let next = line;
          for (let c = spans.length - 1; c >= 0; c--) {
            const span = spans[c];
            if (span.text === cells[c]) continue;
            next = span.start === span.end ? next.slice(0, span.rawStart) + ' ' + cells[c] + ' ' + next.slice(span.rawEnd) : next.slice(0, span.start) + cells[c] + next.slice(span.end);
          }
          state.write(next + '\n');
        } else state.write('| ' + cells.join(' | ') + ' |\n');
      }
      if (rowIndex !== 0) return;
      if (source && source.alignment === alignmentSignature(node)) { state.write(source.delimiter + '\n'); return; }
      const align: string[] = [];
      row.forEach(cell => align.push(cell.attrs.align === 'center' ? ':---:' : cell.attrs.align === 'right' ? '---:' : cell.attrs.align === 'left' ? ':---' : '---'));
      state.write('| ' + align.join(' | ') + ' |\n');
    });
    state.closeBlock(node);
  },
  raw_inline(state, node) { state.text(node.attrs.source, false); },
  raw_block(state, node) {
    const text = node.textContent;
    if (node.attrs.kind === 'frontmatter') {
      state.write((node.attrs.open || '---') + '\n'); if (text) { state.text(text, false); state.write('\n'); }
      state.write(node.attrs.close || node.attrs.open || '---');
    } else if (node.attrs.kind === 'math') {
      if (node.attrs.single && !text.includes('\n')) state.write('$$' + text + '$$');
      else { state.write('$$\n'); if (text) { state.text(text, false); state.write('\n'); } state.write('$$'); }
    } else state.text(text, false);
    state.closeBlock(node);
  },
};
const serializer: MarkdownSerializer = new MarkdownSerializer(nodeSerializers as never, {
  ...defaultMarkdownSerializer.marks,
  em: emphasis('em', '*', '_'), strong: emphasis('strong', '**', '__'),
  strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
  textColor: { open: (_state: unknown, mark: Mark) => colorOpen('textColor', mark.attrs.color), close: colorClose('textColor'), mixable: true, expelEnclosingWhitespace: true },
  highlight: { open: (_state: unknown, mark: Mark) => colorOpen('highlight', mark.attrs.color), close: colorClose('highlight'), mixable: true, expelEnclosingWhitespace: true },
} as never, { escapeExtraCharacters: /<(?=[A-Za-z!/?])/g });
const cellSerializer = new MarkdownSerializer({ ...serializer.nodes,
  hard_break(state) { state.write('<br>'); },
  soft_break(state) { state.write(' '); },
}, serializer.marks, { escapeExtraCharacters: /<(?=[A-Za-z!/?])/g });

const blockNode: Record<string, string> = {
  paragraph_open: 'paragraph', heading_open: 'heading', blockquote_open: 'blockquote', bullet_list_open: 'bullet_list', ordered_list_open: 'ordered_list',
  fence: 'code_block', code_block: 'code_block', hr: 'horizontal_rule', table_open: 'table', html_block: 'raw_block', front_matter: 'raw_block', math_block: 'raw_block',
};
const nestedBlock = new Set([...Object.keys(blockNode), 'list_item_open', 'tr_open', 'th_open', 'td_open'].filter(type => type !== 'paragraph_open'));
interface SourceBlock { id: string; start: number; end: number; raw: string; original: PMNode }
interface Reference { href: string; title: string }
interface ReferenceEnvironment { references?: Record<string, Reference> }
export interface RichDocument { source: string; doc: PMNode; blocks: SourceBlock[]; gaps: string[]; eol: string; references: Record<string, Reference>; bullet: string; tables: Map<string, TableSource> }

export function parseRichMarkdown(source: string): RichDocument {
  if (byteLength(source) > limits.maxBytes) throw new Error(t('編集できるファイルは{0}までです。', limits.label));
  const environment: ReferenceEnvironment = {};
  const parsed = parser.parse(source, environment);
  const tokens = tokenizer.parse(source, {});
  const offsets = [0];
  const re = /\r\n|\r|\n/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) offsets.push(match.index + match[0].length);
  const top = tokens.filter(t => t.level === 0 && t.map && t.nesting !== -1);
  let maps = top.map(t => t.map!);
  const unsupported = () => new Error(t('このMarkdownの構造は直接編集に対応していません。ソースエディタで編集してください。'));
  // A blank/definitions-only file has one empty paragraph in ProseMirror.
  if (!maps.length && parsed.childCount === 1 && !parsed.firstChild!.content.size) maps = [[offsets.length, offsets.length]];
  else {
    // Never edit a document whose blocks the schema dropped or replaced: saving it would lose text.
    if (maps.length !== parsed.childCount) throw unsupported();
    top.forEach((token, i) => { if (blockNode[token.type] && blockNode[token.type] !== parsed.child(i).type.name) throw unsupported(); });
    // Nested blocks too: every parsed block (ignoring empty filler paragraphs) must have a node.
    let expected = 0, actual = 0;
    tokens.forEach((token, i) => {
      if (token.type === 'paragraph_open') { if (tokens[i + 1]?.content) expected++; }
      else if (token.nesting !== -1 && nestedBlock.has(token.type)) expected++;
    });
    parsed.descendants(node => { if (node.isBlock && (node.type !== richSchema.nodes.paragraph || node.content.size)) actual++; });
    if (expected !== actual) throw unsupported();
  }
  const blocks: SourceBlock[] = [], gaps: string[] = [], children: PMNode[] = [], tables = new Map<string, TableSource>();
  let cursor = 0;
  parsed.forEach((node, _offset, i) => {
    const start = offsets[maps[i][0]] ?? source.length;
    const end = offsets[maps[i][1]] ?? source.length;
    gaps.push(source.slice(cursor, start));
    const id = String(i);
    if (node.type === richSchema.nodes.table) {
      // Header, delimiter, then one source line per body row (top-level tables have no prefixes).
      const line = (n: number) => source.slice(offsets[n] ?? source.length, offsets[n + 1] ?? source.length).replace(/\r?\n$|\r$/, '');
      const rows = new Map<string, string>(), lines: string[] = [];
      node.forEach((row, _o, r) => { const text = line(maps[i][0] + (r === 0 ? 0 : r + 1)), key = rowSignature(row); lines.push(text); if (!rows.has(key)) rows.set(key, text); });
      tables.set(id, { rows, lines, delimiter: line(maps[i][0] + 1), alignment: alignmentSignature(node) });
    }
    const annotated = node.type.create({ ...node.attrs, sourceId: id }, node.content, node.marks);
    children.push(annotated);
    blocks.push({ id, start, end, raw: source.slice(start, end), original: annotated });
    cursor = end;
  });
  gaps.push(source.slice(cursor));
  const bullet = tokens.find(token => token.type === 'bullet_list_open')?.markup || '-';
  return { source, blocks, gaps, doc: richSchema.node('doc', null, children), eol: source.includes('\r\n') ? '\r\n' : '\n', references: environment.references ?? {}, bullet, tables };
}

/** Preserve the exact source of untouched blocks and retain reference definitions in gaps. */
export function serializeRichMarkdown(model: RichDocument, doc: PMNode): string {
  doc = withoutNumbering(doc);
  if (doc.eq(model.doc)) return model.source;
  const used = new Set<string>(), usedGaps = new Set<number>([0]);
  const byId = new Map(model.blocks.map((b, i) => [b.id, { ...b, index: i }]));
  const eol = model.eol;
  let result = model.gaps[0] ?? '';
  // Exactly one blank line separates blocks, counting blank lines the next gap already has.
  const separate = (next = '') => {
    if (!result) return;
    if (!result.endsWith(eol)) result += eol;
    if (!result.endsWith(eol + eol) && !/^[ \t]*\r?\n/.test(next)) result += eol;
  };
  doc.forEach((node, _offset, index) => {
    const candidate = byId.get(node.attrs.sourceId);
    const original = candidate && !used.has(candidate.id) ? candidate : undefined;
    if (original) used.add(original.id);
    if (index > 0) {
      const gap = original ? model.gaps[original.index] : undefined;
      if (gap !== undefined && !usedGaps.has(original!.index)) {
        result += gap;
        usedGaps.add(original!.index);
        if (!gap.trim()) separate();
      } else separate();
    } else if (original && original.index !== 0 && model.gaps[original.index].trim()) {
      result += model.gaps[original.index];
      usedGaps.add(original.index);
    }
    if (original && node.eq(original.original)) result += original.raw;
    else {
      let raw = serializer.serialize(richSchema.node('doc', null, [node]), { bullet: model.bullet, table: original && node.type === richSchema.nodes.table ? model.tables.get(original.id) : undefined } as { tightLists?: boolean }).replace(/\n+$/, '');
      raw = raw.replace(/\n/g, eol);
      const terminal = original ? /[\r\n]$/.test(original.raw) : index < doc.childCount - 1 || /[\r\n]$/.test(model.source);
      result += raw + (terminal ? eol : '');
    }
  });
  // Definitions and other source-only gaps must survive even when their adjacent block is removed.
  for (let i = 1; i < model.gaps.length - 1; i++) {
    if (!usedGaps.has(i) && model.gaps[i].trim()) { separate(model.gaps[i]); result += model.gaps[i]; }
  }
  const suffix = model.gaps[model.gaps.length - 1] ?? '';
  if (suffix.trim()) separate(suffix);
  result += suffix;
  // Definitions nested in edited/deleted quotes or lists are not model nodes.
  // Keep their effective targets, including the first winner among duplicates,
  // so untouched raw reference links and images continue to resolve correctly.
  if (Object.keys(model.references).length) {
    const environment: ReferenceEnvironment = {};
    tokenizer.parse(result, environment);
    const missing = Object.entries(model.references).filter(([label, ref]) => {
      const current = environment.references?.[label];
      return !current || current.href !== ref.href || current.title !== ref.title;
    });
    const definitions = missing.map(([label, ref]) => `[${label}]: <${ref.href.replace(/&/g, '&amp;').replace(/[\\<>]/g, '\\$&')}>${ref.title ? ` "${ref.title.replace(/&/g, '&amp;').replace(/[\\"]/g, '\\$&')}"` : ''}`);
    if (definitions.length) result = definitions.join(eol) + eol + eol + result;
  }
  return result;
}

/** Parse a Markdown fragment as inline content, for editing raw inline syntax in place. */
export function parseInlineMarkdown(source: string): PMNode[] | undefined {
  if (/\r|\n/.test(source)) return;
  const doc = parser.parse(source, {});
  if (doc.childCount !== 1 || doc.firstChild!.type !== richSchema.nodes.paragraph) return;
  const nodes: PMNode[] = []; doc.firstChild!.forEach(node => nodes.push(node));
  return nodes;
}

export function makeTable(rows = 3, columns = 2): PMNode {
  return richSchema.nodes.table.create(null, Array.from({ length: rows }, (_, r) =>
    richSchema.nodes.table_row.create(null, Array.from({ length: columns }, () =>
      (r === 0 ? richSchema.nodes.table_header : richSchema.nodes.table_cell).create(null, richSchema.nodes.paragraph.create())))));
}
