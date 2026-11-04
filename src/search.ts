import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import { DecorationSet } from 'prosemirror-view';
export interface Match { from: number; to: number }
export const searchKey = new PluginKey<DecorationSet>('markdownSearch');
export const searchPlugin = new Plugin({ key: searchKey, state: { init: () => DecorationSet.empty, apply: (tr, value) => tr.getMeta(searchKey) ?? value.map(tr.mapping, tr.doc) }, props: { decorations: state => searchKey.getState(state) } });
/** Literal matches across inline marks; never across cells, blocks, images or hard breaks. */
export function findText(doc: PMNode, query: string, sensitive: boolean, ranges?: Match[], limit = 2000): { matches: Match[]; truncated: boolean } {
  const matches: Match[] = []; let truncated = false;
  if (!query || query.length > 1000) return { matches, truncated };
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped, sensitive ? 'gu' : 'giu');
  doc.descendants((node, pos) => {
    if (truncated) return false;
    if (!node.isTextblock) return;
    let text = '', start = pos + 1;
    const flush = () => {
      regex.lastIndex = 0;
      for (const m of text.matchAll(regex)) {
        const match = { from: start + m.index!, to: start + m.index! + m[0].length };
        if (ranges && !ranges.some(r => match.from < r.to && match.to > r.from)) continue;
        if (matches.length >= limit) { truncated = true; break; }
        matches.push(match);
      }
      text = '';
    };
    node.forEach((child, offset) => { if (child.isText) { if (!text) start = pos + 1 + offset; text += child.text; } else flush(); });
    flush(); return false;
  });
  return { matches, truncated };
}
