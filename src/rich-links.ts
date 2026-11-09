import type { Node as PMNode } from 'prosemirror-model';
import { Decoration } from 'prosemirror-view';
import { t } from './i18n';

const URL = /\bhttps?:\/\/[^\s<>"'`]+/g;
/** Bare URLs look like links (as GitHub renders them) without changing the document. */
export function linkDecorations(doc: PMNode, broken: Map<string, string>): Decoration[] {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos, parent) => {
    if (parent?.type.spec.code) return false;
    if (node.isText) {
      const link = node.marks.find(mark => mark.type.name === 'link');
      if (link) {
        const reason = broken.get(link.attrs.href);
        if (reason) decorations.push(Decoration.inline(pos, pos + node.nodeSize, { class: 'broken-link', title: `${link.attrs.href}\n${reason}` }));
        return;
      }
      if (node.marks.some(mark => mark.type.name === 'code')) return;
      for (const match of node.text!.matchAll(URL)) {
        const url = match[0].replace(/[.,;:!?)\]}、。]+$/, '');
        decorations.push(Decoration.inline(pos + match.index!, pos + match.index! + url.length, { class: 'md-autolink', 'data-href': url, title: `${url}\n${t('⌘/Ctrl+クリックで開く')}` }));
      }
    } else if (node.type.name === 'image' && broken.has(node.attrs.src)) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'broken-link', title: `${node.attrs.src}\n${broken.get(node.attrs.src)}` }));
    } else if (node.type.name === 'raw_inline' && node.attrs.kind === 'wiki') {
      const target = /^\[\[([^|\]]+)/.exec(node.attrs.source)?.[1]?.trim() ?? '';
      if (broken.has(target)) decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'broken-link', title: `${target}\n${broken.get(target)}` }));
    }
  });
  return decorations;
}

export interface LinkRequest { href?: string; wiki?: string; footnote?: string }
/** The link under a click: rich link marks, bare URLs, wiki links and host-rendered links. */
export function linkAt(target: Element): LinkRequest | undefined {
  const footnote = target.closest<HTMLElement>('[data-md-raw-kind="footnote"], [data-md-raw-kind="footnoteDef"]');
  if (footnote) return { footnote: /^\[\^([^\]]+)\]/.exec(footnote.dataset.mdRaw ?? '')?.[1] };
  const wiki = target.closest<HTMLElement>('[data-wiki]');
  if (wiki) return { wiki: wiki.dataset.wiki };
  const link = target.closest<HTMLElement>('a[data-href], .md-autolink[data-href], .md-link[data-href]');
  const href = link?.getAttribute('data-href');
  return href ? { href } : undefined;
}
