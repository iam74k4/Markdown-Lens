import type MarkdownIt from 'markdown-it';
import Token from 'markdown-it/lib/token.mjs';
import type { MarkSpec } from 'prosemirror-model';
import type { Command, EditorState } from 'prosemirror-state';
import { closeHistory } from 'prosemirror-history';

export type ColorKind = 'textColor' | 'highlight';
export const colorLabels: Record<ColorKind, string> = { textColor: '文字色', highlight: 'マーカー' };
export const colorPresets: Record<ColorKind, readonly (readonly [string, string])[]> = {
  textColor: [['赤', '#e05252'], ['オレンジ', '#c77724'], ['黄', '#a88a16'], ['緑', '#32855a'], ['青', '#3984d5'], ['紫', '#9b6bd3'], ['黒', '#202124'], ['白', '#ffffff']],
  highlight: [['黄', '#fff2a8'], ['緑', '#c8efc4'], ['水色', '#bfe8f5'], ['青', '#ccdfff'], ['紫', '#e4d3f5'], ['ピンク', '#ffd5e5'], ['オレンジ', '#ffdfb6'], ['グレー', '#e2e5e9']],
};
export const normalizeColor = (value: unknown): string | null => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
const property = (kind: ColorKind) => kind === 'textColor' ? 'color' : 'background-color';
const tag = (kind: ColorKind) => kind === 'textColor' ? 'span' : 'mark';
export function colorOpen(kind: ColorKind, value: unknown): string {
  const color = normalizeColor(value);
  if (!color) throw new Error('色は #RRGGBB 形式で指定してください。');
  return `<${tag(kind)} style="${property(kind)}:${color}">`;
}
export const colorClose = (kind: ColorKind) => `</${tag(kind)}>`;

export const colorMarks: Record<ColorKind, MarkSpec> = {
  // Put the marker outside the text color so an explicit foreground wins.
  highlight: makeMark('highlight'), textColor: makeMark('textColor'),
};
function makeMark(kind: ColorKind): MarkSpec {
  return {
    attrs: { color: { validate: value => { if (!normalizeColor(value)) throw new RangeError('Invalid color'); } } },
    parseDOM: [{ tag: `${tag(kind)}[data-md-${kind === 'textColor' ? 'color' : 'highlight'}]`, getAttrs: dom => {
      const color = normalizeColor(dom.getAttribute(kind === 'textColor' ? 'data-md-color' : 'data-md-highlight'));
      return color ? { color } : false;
    } }],
    toDOM: mark => [tag(kind), {
      [kind === 'textColor' ? 'data-md-color' : 'data-md-highlight']: normalizeColor(mark.attrs.color) || '#000000',
      class: kind === 'textColor' ? 'md-text-color' : 'md-highlight',
      style: `${property(kind)}:${normalizeColor(mark.attrs.color) || '#000000'}`,
    }, 0],
  };
}

/** Only paired, single-property color tags are recognized; general HTML stays disabled. */
export function colorMarkdown(md: MarkdownIt): void {
  md.inline.ruler.before('html_inline', 'text_colors', (state, silent) => {
    const start = state.pos, max = state.posMax;
    if (state.src[start] !== '<') return false;
    const open = /^<(span|mark) style="(color|background-color):\s*(#[0-9a-f]{6});?">/i.exec(state.src.slice(start, start + 80));
    if (!open || (open[1].toLowerCase() === 'span') !== (open[2].toLowerCase() === 'color')) return false;
    const kind: ColorKind = open[1].toLowerCase() === 'span' ? 'textColor' : 'highlight';
    const endTag = colorClose(kind), contentStart = start + open[0].length;
    // Skip escaped text, code and complete nested tags when locating the matching close.
    state.pos = contentStart;
    while (state.pos < max && state.src.slice(state.pos, state.pos + endTag.length).toLowerCase() !== endTag) md.inline.skipToken(state);
    const end = state.pos;
    state.pos = start;
    if (end >= max) return false;
    if (silent) { state.pos = end + endTag.length; return true; }
    const token = state.push(`${kind}_open`, tag(kind), 1);
    token.attrSet('color', open[3].toLowerCase());
    state.pos = contentStart; state.posMax = end;
    md.inline.tokenize(state);
    state.push(`${kind}_close`, tag(kind), -1);
    state.pos = end + endTag.length; state.posMax = max;
    return true;
  });
  for (const kind of ['textColor', 'highlight'] as const) {
    md.renderer.rules[`${kind}_open`] = (tokens, i) => colorOpen(kind, tokens[i].attrGet('color'));
    md.renderer.rules[`${kind}_close`] = () => colorClose(kind);
  }
}

/** ProseMirror has one mark of each type. Restore outer colors after nested overrides. */
export function flattenColorTokens(md: MarkdownIt): void {
  md.core.ruler.after('inline', 'flatten_colors', state => {
    for (const block of state.tokens) {
      if (!block.children) continue;
      const stacks: Record<ColorKind, Token[]> = { textColor: [], highlight: [] }, result: Token[] = [];
      for (const token of block.children) {
        const kind = (['textColor', 'highlight'] as const).find(k => token.type.startsWith(k + '_'));
        if (!kind) { result.push(token); continue; }
        const stack = stacks[kind];
        if (token.nesting === 1) {
          if (stack.length) result.push(new Token(`${kind}_close`, tag(kind), -1));
          stack.push(token); result.push(token);
        } else {
          result.push(token); stack.pop();
          if (stack.length) result.push(stack[stack.length - 1]);
        }
      }
      block.children = result;
    }
  });
}

function colorRanges(state: EditorState, kind: ColorKind): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  if (state.selection.empty) return ranges;
  for (const { $from, $to } of state.selection.ranges) state.doc.nodesBetween($from.pos, $to.pos, (node, pos, parent) => {
    if (node.isText && parent?.type.allowsMarkType(state.schema.marks[kind]) && !node.marks.some(m => m.type.name === 'code')) {
      ranges.push({ from: Math.max(pos, $from.pos), to: Math.min(pos + node.nodeSize, $to.pos) });
    }
  });
  return ranges.filter(r => r.to > r.from);
}
export function setSelectionColor(kind: ColorKind, value: string | null): Command {
  return (state, dispatch) => {
    const color = value === null ? null : normalizeColor(value);
    if (value !== null && !color) return false;
    const ranges = colorRanges(state, kind);
    if (!ranges.length) return false;
    if (dispatch) {
      const tr = closeHistory(state.tr), type = state.schema.marks[kind];
      for (const { from, to } of ranges) color ? tr.addMark(from, to, type.create({ color })) : tr.removeMark(from, to, type);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}
export function selectionColor(state: EditorState, kind: ColorKind): string | null {
  const colors = new Set<string | null>();
  for (const { from, to } of colorRanges(state, kind)) state.doc.nodesBetween(from, to, node => {
    if (node.isText) colors.add(node.marks.find(m => m.type.name === kind)?.attrs.color ?? null);
  });
  return colors.size === 1 ? [...colors][0] : null;
}
