import { Node as PMNode } from 'prosemirror-model';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { Plugin, PluginKey } from 'prosemirror-state';
import { diffArrays } from 'diff';
import { parseRichMarkdown } from './rich-markdown';
import type { Hunk } from './core';
import { icon } from './icons';
import { comparisonDetails, disposeComparison } from './inline-comparison';

export const inlineReviewKey = new PluginKey<DecorationSet>('inlineReview');
export const inlineReviewPlugin = new Plugin({
  key: inlineReviewKey,
  state: {
    init: () => DecorationSet.empty,
    apply: (tr, value) => tr.getMeta(inlineReviewKey) ?? value.map(tr.mapping, tr.doc),
  },
  props: { decorations: state => inlineReviewKey.getState(state) },
});

export interface InlineChange { hunk: Hunk; position: number; blocks: { from: number; to: number }[]; inserted: { from: number; to: number }[] }
function visibleText(nodes: { node: PMNode; pos: number }[]) {
  let text = ''; const positions: number[] = [];
  for (const { node, pos } of nodes) {
    node.descendants((child, offset) => {
      if (child.isText) {
        for (let i = 0; i < child.text!.length; i++) { text += child.text![i]; positions.push(pos + 1 + offset + i); }
      } else if (child.isLeaf && child.type.spec.leafText) {
        // Raw syntax and soft breaks compare by their visible text but cannot be highlighted inside.
        const leaf = child.type.spec.leafText(child); text += leaf; for (let i = 0; i < leaf.length; i++) positions.push(-1);
      } else if (child.isLeaf || child.isTextblock) { text += '\n'; positions.push(-1); }
    });
    text += '\n'; positions.push(-1);
  }
  return { text, positions };
}
/** Source offsets come from the host; decorations are projected onto the live editor, never saved. */
export function inlineChanges(source: string, doc: PMNode, hunks: Hunk[]): InlineChange[] {
  const parsed = parseRichMarkdown(source);
  const nodes: { node: PMNode; pos: number; start: number; end: number }[] = [];
  if (doc.childCount !== parsed.blocks.length) throw new Error('本文の構造が変わりました。ソースで確認してください。');
  doc.forEach((node, pos, index) => nodes.push({ node, pos, ...parsed.blocks[index] }));
  return hunks.map(hunk => {
    const parts = hunk.moveParts ?? [hunk];
    const affected = nodes.filter(n => parts.some(h => h.start < n.end && h.end > n.start));
    const position = affected[0]?.pos ?? nodes.find(n => n.start >= hunk.start)?.pos ?? doc.content.size;
    const after = visibleText(affected);
    let before = '';
    try {
      const old = parseRichMarkdown(parts.map(h => h.before).join('\n\n')).doc;
      const oldNodes: { node: PMNode; pos: number }[] = []; old.forEach((node, pos) => oldNodes.push({ node, pos }));
      before = visibleText(oldNodes).text;
    } catch { /* A source-only change still has a visible review card. */ }
    const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
    const words = (text: string) => Array.from(segmenter.segment(text), part => part.segment);
    const diff = diffArrays(words(before), words(after.text), { timeout: 40 });
    const inserted: { from: number; to: number }[] = [];
    let cursor = 0;
    for (const part of diff ?? [{ value: [after.text], added: true, removed: false }]) {
      if (part.removed) continue;
      const length = part.value.join('').length;
      if (part.added) for (let i = cursor; i < cursor + length; i++) {
        const position = after.positions[i];
        if (position < 0 || position === undefined) continue;
        const last = inserted[inserted.length - 1];
        if (last?.to === position) last.to++; else inserted.push({ from: position, to: position + 1 });
      }
      cursor += length;
    }
    return { hunk, position, blocks: affected.map(n => ({ from: n.pos, to: n.pos + n.node.nodeSize })), inserted };
  });
}

export function reviewDecorations(doc: PMNode, plan: InlineChange[], changesOnly: boolean, expanded: Set<number>, expand: (pos: number) => void, hidden: (pos: number) => boolean = () => false, headings = new Set<number>(), comparisons = new Map<string, string>()): DecorationSet {
  const decorations: Decoration[] = [];
  const changed = new Set<number>();
  for (const [index, { hunk, position, blocks, inserted }] of plan.entries()) {
    for (const block of blocks) {
      changed.add(block.from);
      decorations.push(Decoration.node(block.from, block.to, { class: 'inline-changed-block' }));
    }
    if (hunk.cells?.length && blocks.length === 1) {
      const table = doc.nodeAt(blocks[0].from);
      if (table?.type.name === 'table') table.forEach((row, rowOffset, r) => row.forEach((cell, cellOffset, c) => {
        if (!hunk.cells!.some(change => change.row === r && change.column === c)) return;
        const cellPos = blocks[0].from + 2 + rowOffset + cellOffset;
        decorations.push(Decoration.node(cellPos, cellPos + cell.nodeSize, { class: 'cell-unreviewed' }));
        decorations.push(Decoration.widget(cellPos + cell.nodeSize - 2, () => {
          const controls = document.createElement('span'); controls.className = 'cell-review-controls'; controls.contentEditable = 'false';
          for (const [action, label, svg] of [['revertCell', '戻す', 'undo'], ['reviewCell', '確認済みにする', 'check']] as const) {
            const button = document.createElement('button'); button.type = 'button'; button.innerHTML = icon(svg);
            button.dataset.cellAction = action; button.dataset.cellHunk = hunk.id; button.dataset.row = String(r); button.dataset.column = String(c);
            button.title = `このセルを${label}`; button.setAttribute('aria-label', `${r === 0 ? '見出し' : r + '行目'}・${c + 1}列目のセルを${label}`);
            button.addEventListener('mousedown', e => e.preventDefault()); controls.append(button);
          }
          return controls;
        }, { side: 1, key: `cell:${hunk.id}:${r}:${c}`, stopEvent: () => true, ignoreSelection: true }));
      }));
    }
    for (const span of inserted) decorations.push(Decoration.inline(span.from, span.to, { class: 'inline-insert', 'data-change': hunk.id }));
    decorations.push(Decoration.widget(position, () => {
      const card = document.createElement('div'); card.className = 'inline-review change' + (hidden(position) ? ' section-hidden' : ''); card.dataset.hunk = hunk.id; card.contentEditable = 'false'; card.tabIndex = -1;
      const label = hunk.eol ? '改行コードの変更' : hunk.moveParts ? '移動した内容' : !hunk.after ? '− 削除された内容' : !hunk.before ? '＋ 追加した内容' : '変更した内容';
      const row = document.createElement('div'); row.className = 'inline-review-row';
      const title = document.createElement('span'); title.textContent = label; row.append(title);
      const actions = document.createElement('div'); actions.className = 'change-actions';
      for (const [type, text, svg] of [['revert', '戻す', 'undo'], ['review', '確認済みにする', 'check']] as const) {
        const button = document.createElement('button'); button.type = 'button'; button.dataset[type] = hunk.id;
        button.className = (type === 'review' ? 'confirm-change' : 'revert') + ' has-tooltip'; button.title = text; button.dataset.tooltip = text;
        button.setAttribute('aria-label', `変更 ${index + 1} を${text}`); button.innerHTML = icon(svg);
        button.addEventListener('mousedown', event => event.preventDefault()); actions.append(button);
      }
      row.append(actions); card.append(row);
      if (hunk.before || comparisons.get(hunk.id)?.includes('<table')) card.append(comparisonDetails(hunk, comparisons.get(hunk.id)));
      return card;
    }, { side: -1, key: `${hunk.id}:${index}:${hidden(position)}`, stopEvent: () => true, ignoreSelection: true, destroy: disposeComparison }));
  }
  if (changesOnly) doc.forEach((node, pos) => {
    if (changed.has(pos) || expanded.has(pos) || hidden(pos) || headings.has(pos)) return;
    decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'inline-folded' }));
    decorations.push(Decoration.widget(pos, () => {
      const button = document.createElement('button'); button.className = 'inline-expand'; button.type = 'button'; button.contentEditable = 'false';
      button.textContent = '⋯ 変更のない段落を表示'; button.addEventListener('click', () => expand(pos)); return button;
    }, { side: -1, key: `fold:${pos}`, stopEvent: () => true }));
  });
  return DecorationSet.create(doc, decorations);
}
