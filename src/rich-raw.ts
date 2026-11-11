import katex from 'katex';
import type { Node as PMNode } from 'prosemirror-model';
import { Decoration, DecorationSet, type NodeViewConstructor } from 'prosemirror-view';
import { Plugin, PluginKey } from 'prosemirror-state';
import { frontMatterRows } from './markdown-syntax';
import { t } from './i18n';

let mathEnabled = true;
/** The `markdownLens.math` setting: when off, math stays visible as its source. */
export function setMathEnabled(value: boolean): void { mathEnabled = value; }
/** KaTeX without \href, \url, \includegraphics or other trusted commands. */
export function renderMath(target: HTMLElement, source: string, display: boolean): void {
  if (!mathEnabled) { target.textContent = display ? `$$${source}$$` : `$${source}$`; target.classList.add('math-source'); return; }
  try {
    katex.render(source, target, { displayMode: display, throwOnError: false, trust: false, strict: 'ignore', maxSize: 50, maxExpand: 1000, output: 'htmlAndMathml' });
    target.classList.remove('math-error');
  } catch {
    target.textContent = source; target.classList.add('math-error');
  }
}
/** Host-rendered comparisons carry escaped math source in data attributes. */
export function renderMathIn(container: HTMLElement): void {
  container.querySelectorAll<HTMLElement>('[data-math]').forEach(element => {
    const target = document.createElement(element.dataset.display === 'true' && element.tagName === 'DIV' ? 'div' : 'span');
    target.className = element.className;
    renderMath(target, element.dataset.math ?? '', element.dataset.display === 'true');
    element.replaceWith(target);
  });
}

/** Formatting tags shown as what they do; the tags themselves fold away until the caret comes near. */
const PREVIEW_TAGS = new Set(['kbd', 'sub', 'sup', 'small', 'u', 'b', 'i', 'em', 'strong', 'mark', 's', 'del', 'ins']);
interface TagPair { tag: string; open: number; openEnd: number; close: number; closeEnd: number }
interface LineBreak { from: number; to: number }
/** Matching attribute-free formatting tags (and `<br>`) within each paragraph, nesting included. */
export function inlineHtmlPairs(doc: PMNode): { pairs: TagPair[]; breaks: LineBreak[] } {
  const pairs: TagPair[] = [], breaks: LineBreak[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const stack: { tag: string; open: number; openEnd: number }[] = [];
    node.forEach((child, offset) => {
      if (child.type.name !== 'raw_inline' || child.attrs.kind !== 'html') return;
      const match = /^<(\/?)([a-z]+)\s*(\/?)>$/i.exec(child.attrs.source ?? ''); if (!match) return;
      const tag = match[2].toLowerCase(), at = pos + 1 + offset, end = at + child.nodeSize;
      if (tag === 'br' && !match[1]) { breaks.push({ from: at, to: end }); return; }
      if (!PREVIEW_TAGS.has(tag) || match[3]) return;
      if (!match[1]) { stack.push({ tag, open: at, openEnd: end }); return; }
      const index = stack.map(entry => entry.tag).lastIndexOf(tag); if (index < 0) return;
      const opened = stack[index]; stack.length = index;
      if (at > opened.openEnd) pairs.push({ tag, open: opened.open, openEnd: opened.openEnd, close: at, closeEnd: end });
    });
    return false;
  });
  return { pairs, breaks };
}
const htmlPreviewKey = new PluginKey<ReturnType<typeof inlineHtmlPairs>>('inlineHtmlPreview');
export const inlineHtmlPreview: Plugin = new Plugin<ReturnType<typeof inlineHtmlPairs>>({
  key: htmlPreviewKey,
  state: { init: (_, state) => inlineHtmlPairs(state.doc), apply: (tr, found, _old, state) => tr.docChanged ? inlineHtmlPairs(state.doc) : found },
  props: { decorations(state): DecorationSet | null {
    const found = htmlPreviewKey.getState(state); if (!found || (!found.pairs.length && !found.breaks.length)) return null;
    const { from, to } = state.selection, near = (start: number, end: number) => to >= start && from <= end;
    const decorations: Decoration[] = [];
    for (const pair of found.pairs) {
      decorations.push(Decoration.inline(pair.openEnd, pair.close, { class: `md-html md-html-${pair.tag}` }));
      if (!near(pair.open, pair.closeEnd)) decorations.push(Decoration.node(pair.open, pair.openEnd, { class: 'raw-tag-folded' }), Decoration.node(pair.close, pair.closeEnd, { class: 'raw-tag-folded' }));
    }
    for (const line of found.breaks) if (!near(line.from, line.to)) decorations.push(Decoration.node(line.from, line.to, { class: 'raw-tag-folded raw-tag-break' }));
    return DecorationSet.create(state.doc, decorations);
  } },
});

export const rawLabel = (kind: string) => ({ frontmatter: t('メタデータ'), math: t('数式'), html: 'HTML', comment: t('HTMLコメント') } as Record<string, string>)[kind] ?? kind;

function inlineContent(node: PMNode): HTMLElement {
  const { source, kind, text } = node.attrs as { source: string; kind: string; text: string | null };
  const element = document.createElement(kind === 'footnote' ? 'sup' : 'span');
  element.className = `raw-inline raw-${kind}`;
  element.dataset.mdRaw = source; element.dataset.mdRawKind = kind;
  element.title = `${source}\n${t('ダブルクリックでMarkdownを編集')}`;
  switch (kind) {
    case 'math': renderMath(element, text ?? source.replace(/^\$+|\$+$/g, ''), /^\$\$/.test(source)); break;
    case 'footnote': element.textContent = /^\[\^([^\]]+)\]/.exec(source)?.[1] ?? source; break;
    case 'footnoteDef': element.textContent = (/^\[\^([^\]]+)\]/.exec(source)?.[1] ?? source) + ':'; break;
    case 'wiki': {
      const target = /^\[\[([^|\]]+)/.exec(source)?.[1]?.trim() ?? '';
      element.classList.add('md-link', 'wiki-link'); element.dataset.wiki = target; element.textContent = text ?? target;
      element.title = `${target}\n${t('⌘/Ctrl+クリックで開く')}`; break;
    }
    case 'alert': {
      const alert = /\[!(\w+)\]/.exec(source)?.[1]?.toLowerCase() ?? 'note';
      element.dataset.alert = alert; element.textContent = ({ note: t('注記'), tip: t('ヒント'), important: t('重要'), warning: t('警告'), caution: t('注意') } as Record<string, string>)[alert] ?? alert; break;
    }
    case 'entity': case 'escape': element.textContent = text ?? source; element.title = source; break;
    default: element.textContent = source;
  }
  return element;
}

export function rawNodeViews(edit: (pos: number) => void): Record<string, NodeViewConstructor> {
  return {
    raw_inline(node, _view, getPos) {
      let current = node, dom = inlineContent(node);
      const open = (event: Event) => { event.preventDefault(); const pos = getPos(); if (pos !== undefined) edit(pos); };
      dom.addEventListener('dblclick', open);
      return {
        dom,
        update(next) {
          if (next.type !== current.type) return false;
          if (next.attrs.source !== current.attrs.source || next.attrs.text !== current.attrs.text) {
            const replacement = inlineContent(next); replacement.addEventListener('dblclick', open);
            dom.replaceWith(replacement); dom = replacement;
          }
          current = next; return true;
        },
        ignoreMutation: () => true,
      };
    },
    raw_block(node) {
      let current = node, timer: ReturnType<typeof setTimeout> | undefined, painted = '';
      const kind = node.attrs.kind as string, previewable = kind === 'frontmatter' || kind === 'math';
      const dom = document.createElement('div'); dom.className = `raw-block-view raw-${kind}`; dom.dataset.rawKind = kind;
      const label = document.createElement('div'); label.className = 'raw-block-label'; label.contentEditable = 'false'; label.textContent = rawLabel(kind);
      const preview = document.createElement('div'); preview.className = 'raw-block-preview'; preview.contentEditable = 'false';
      const details = document.createElement('details'); details.className = 'raw-block-source';
      const summary = document.createElement('summary'); summary.contentEditable = 'false'; summary.textContent = t('ソースを編集');
      const pre = document.createElement('pre'), code = document.createElement('code'); pre.append(code);
      if (previewable) { details.append(summary, pre); dom.append(label, preview, details); } else { details.open = true; details.append(pre); dom.append(label, details); }
      const paint = () => {
        const source = current.textContent; if (!previewable || source === painted) return; painted = source;
        preview.replaceChildren();
        if (kind === 'math') { const target = document.createElement('div'); target.className = 'math-block'; renderMath(target, source, true); preview.append(target); return; }
        const rows = frontMatterRows(source);
        if (!rows) { preview.textContent = t('メタデータ（ソースを表示して確認）'); return; }
        const table = document.createElement('table'), body = document.createElement('tbody');
        for (const row of rows) {
          const tr = document.createElement('tr'), th = document.createElement('th'), td = document.createElement('td');
          th.textContent = row.key; td.textContent = row.value; tr.append(th, td); body.append(tr);
        }
        table.append(body); preview.append(table);
      };
      const schedule = () => { clearTimeout(timer); timer = setTimeout(paint, 150); };
      preview.addEventListener('dblclick', () => { details.open = true; code.focus(); });
      paint();
      return { dom, contentDOM: code,
        update(next: PMNode) { if (next.type !== current.type || next.attrs.kind !== current.attrs.kind) return false; current = next; schedule(); return true; },
        stopEvent: event => label.contains(event.target as globalThis.Node) || preview.contains(event.target as globalThis.Node) || event.target === summary,
        ignoreMutation: mutation => mutation.type !== 'selection' && (label.contains(mutation.target) || preview.contains(mutation.target) || (mutation.type === 'attributes' && (mutation.target === details || mutation.target === dom))),
        destroy() { clearTimeout(timer); },
      };
    },
  };
}
