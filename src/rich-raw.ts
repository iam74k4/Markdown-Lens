import katex from 'katex';
import type { Node as PMNode } from 'prosemirror-model';
import type { NodeViewConstructor } from 'prosemirror-view';
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

const alertNames: Record<string, string> = { note: '注記', tip: 'ヒント', important: '重要', warning: '警告', caution: '注意' };
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
      element.dataset.alert = alert; element.textContent = t(alertNames[alert] ?? alert); break;
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
