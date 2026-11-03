import MarkdownIt from 'markdown-it';
import Token from 'markdown-it/lib/token.mjs';
import { Schema, Node as PMNode, NodeSpec } from 'prosemirror-model';
import { schema as commonSchema, defaultMarkdownParser, defaultMarkdownSerializer, MarkdownParser, MarkdownSerializer } from 'prosemirror-markdown';
import { tableNodes } from 'prosemirror-tables';

let nodes = commonSchema.spec.nodes.append(tableNodes({ tableGroup: 'block', cellContent: 'paragraph', cellAttributes: {
  align: { default: null, getFromDOM: dom => dom.getAttribute('data-align'), setDOMAttr: (value, attrs) => { if (value) attrs['data-align'] = value; } },
} }));
// IDs live only in the editor model, never in the saved Markdown.
nodes.forEach((name, spec) => {
  if (spec.group === 'block') nodes = nodes.update(name, { ...spec, attrs: { ...spec.attrs, sourceId: { default: null } } });
});
nodes = nodes.update('list_item', { ...nodes.get('list_item'), attrs: { checked: { default: null } },
  toDOM: node => node.attrs.checked === null ? ['li', 0] : ['li', { class: 'task-item', 'data-checked': String(node.attrs.checked) },
    ['input', { type: 'checkbox', 'data-task': 'true', 'aria-label': 'タスクの完了', contenteditable: 'false', ...(node.attrs.checked ? { checked: '' } : {}) }], ['div', 0]],
} as NodeSpec);
nodes = nodes.update('image', { ...nodes.get('image'), toDOM: node => ['span', { class: 'image-placeholder', contenteditable: 'false' }, `画像: ${node.attrs.alt || ''} (${node.attrs.src})`] } as NodeSpec);
export const richSchema = new Schema({ nodes, marks: commonSchema.spec.marks.update('link', {
  ...commonSchema.spec.marks.get('link'),
  // Inert links: editing must never navigate, execute commands, or load remote resources.
  toDOM: mark => ['a', { 'data-href': mark.attrs.href, title: mark.attrs.href }, 0],
}).append({ strike: { parseDOM: [{ tag: 's' }, { tag: 'del' }], toDOM: () => ['s', 0] } }) });

const tokenizer = new MarkdownIt('commonmark', { html: false }).enable(['table', 'strikethrough']);
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
  for (const token of state.tokens) {
    if (token.type === 'th_close' || token.type === 'td_close') expanded.push(new Token('paragraph_close', 'p', -1));
    expanded.push(token);
    if (token.type === 'th_open' || token.type === 'td_open') expanded.push(new Token('paragraph_open', 'p', 1));
  }
  state.tokens = expanded;
});
const parser = new MarkdownParser(richSchema, tokenizer, {
  ...defaultMarkdownParser.tokens, list_item: { block: 'list_item', getAttrs: token => ({ checked: token.attrGet('checked') === null ? null : token.attrGet('checked') === 'true' }) }, s: { mark: 'strike' },
  table: { block: 'table' }, thead: { ignore: true }, tbody: { ignore: true }, tr: { block: 'table_row' },
  th: { block: 'table_header', getAttrs: t => ({ align: t.attrGet('style')?.replace('text-align:', '') ?? null }) },
  td: { block: 'table_cell', getAttrs: t => ({ align: t.attrGet('style')?.replace('text-align:', '') ?? null }) },
});

const serializer: MarkdownSerializer = new MarkdownSerializer({
  ...defaultMarkdownSerializer.nodes,
  list_item(state, node) { if (node.attrs.checked !== null) state.write(node.attrs.checked ? '[x] ' : '[ ] '); state.renderContent(node); },
  table(state, node) {
    node.forEach((row, _offset, rowIndex) => {
      const cells: string[] = [];
      row.forEach(cell => {
        const text = serializer.serialize(richSchema.node('doc', null, cell.content));
        cells.push(text.replace(/(?<!\\)\|/g, '\\|').replace(/\r?\n/g, ' '));
      });
      state.write('| ' + cells.join(' | ') + ' |\n');
      if (rowIndex === 0) {
        const align: string[] = [];
        row.forEach(cell => align.push(cell.attrs.align === 'center' ? ':---:' : cell.attrs.align === 'right' ? '---:' : cell.attrs.align === 'left' ? ':---' : '---'));
        state.write('| ' + align.join(' | ') + ' |\n');
      }
    });
    state.closeBlock(node);
  },
}, { ...defaultMarkdownSerializer.marks, strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true } });

interface SourceBlock { id: string; start: number; end: number; raw: string; original: PMNode }
export interface RichDocument { source: string; doc: PMNode; blocks: SourceBlock[]; gaps: string[]; eol: string }

export function parseRichMarkdown(source: string): RichDocument {
  if (new TextEncoder().encode(source).length > 512 * 1024) throw new Error('編集できるファイルは512KBまでです。');
  const parsed = parser.parse(source);
  const tokens = tokenizer.parse(source, {});
  const offsets = [0];
  const re = /\r\n|\r|\n/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) offsets.push(match.index + match[0].length);
  let maps = tokens.filter(t => t.level === 0 && t.map && t.nesting !== -1).map(t => t.map!);
  // A blank/definitions-only file has one empty paragraph in ProseMirror.
  if (!maps.length && parsed.childCount === 1 && !parsed.firstChild!.content.size) maps = [[offsets.length, offsets.length]];
  if (maps.length !== parsed.childCount) throw new Error('このMarkdownの構造は直接編集に対応していません。ソースエディタで編集してください。');
  const blocks: SourceBlock[] = [], gaps: string[] = [], children: PMNode[] = [];
  let cursor = 0;
  parsed.forEach((node, _offset, i) => {
    const start = offsets[maps[i][0]] ?? source.length;
    const end = offsets[maps[i][1]] ?? source.length;
    gaps.push(source.slice(cursor, start));
    const id = String(i);
    const annotated = node.type.create({ ...node.attrs, sourceId: id }, node.content, node.marks);
    children.push(annotated);
    blocks.push({ id, start, end, raw: source.slice(start, end), original: annotated });
    cursor = end;
  });
  gaps.push(source.slice(cursor));
  return { source, blocks, gaps, doc: richSchema.node('doc', null, children), eol: source.includes('\r\n') ? '\r\n' : '\n' };
}

/** Preserve the exact source of untouched blocks and retain reference definitions in gaps. */
export function serializeRichMarkdown(model: RichDocument, doc: PMNode): string {
  if (doc.eq(model.doc)) return model.source;
  const used = new Set<string>(), usedGaps = new Set<number>([0]);
  const byId = new Map(model.blocks.map((b, i) => [b.id, { ...b, index: i }]));
  const eol = model.eol;
  let result = model.gaps[0] ?? '';
  const separate = () => {
    if (!result) return;
    if (!result.endsWith(eol)) result += eol;
    if (!result.endsWith(eol + eol)) result += eol;
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
      let raw = serializer.serialize(richSchema.node('doc', null, [node])).replace(/\n+$/, '');
      raw = raw.replace(/\n/g, eol);
      const terminal = original ? /[\r\n]$/.test(original.raw) : index < doc.childCount - 1 || /[\r\n]$/.test(model.source);
      result += raw + (terminal ? eol : '');
    }
  });
  // Definitions and other source-only gaps must survive even when their adjacent block is removed.
  for (let i = 1; i < model.gaps.length - 1; i++) {
    if (!usedGaps.has(i) && model.gaps[i].trim()) { separate(); result += model.gaps[i]; }
  }
  const suffix = model.gaps[model.gaps.length - 1] ?? '';
  if (suffix.trim()) separate();
  result += suffix;
  return result;
}

export function makeTable(rows = 3, columns = 2): PMNode {
  return richSchema.nodes.table.create(null, Array.from({ length: rows }, (_, r) =>
    richSchema.nodes.table_row.create(null, Array.from({ length: columns }, () =>
      (r === 0 ? richSchema.nodes.table_header : richSchema.nodes.table_cell).create(null, richSchema.nodes.paragraph.create())))));
}
