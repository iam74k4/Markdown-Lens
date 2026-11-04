import type { Hunk } from './core';
import { renderDiagrams } from './diagrams';
import { enhanceTables } from './table-review';

const disposers = new WeakMap<HTMLElement, () => void>();
/** Read-only host-rendered comparisons live beside their change, outside editable content. */
export function comparisonDetails(hunk: Hunk, html?: string): HTMLDetailsElement {
  const details = document.createElement('details'); details.className = 'inline-before';
  details.dataset.kind = html?.includes('<table') ? 'table' : html?.includes('diagram-review') ? 'diagram' : 'text';
  const summary = document.createElement('summary');
  summary.textContent = !hunk.after ? '削除内容を見る' : !hunk.before ? '追加内容を見る' : '変更前・差分を見る';
  details.append(summary);
  let painted = false;
  details.addEventListener('toggle', () => {
    if (!details.open) { disposers.get(details)?.(); disposers.delete(details); details.replaceChildren(summary); painted = false; return; }
    if (painted || !details.isConnected) return;
    painted = true;
    if (html) {
      const content = document.createElement('div'); content.className = 'inline-comparison';
      content.innerHTML = html;
      details.append(content);
      disposers.set(details, enhanceTables(content));
      renderDiagrams(content);
      content.querySelectorAll<HTMLImageElement>('.markdown-image').forEach(img => img.addEventListener('error', () => {
        img.hidden = true; if (img.nextElementSibling instanceof HTMLElement) img.nextElementSibling.hidden = false;
      }));
      const raw = document.createElement('details'); raw.className = 'inline-original-source';
      const label = document.createElement('summary'); label.textContent = hunk.before ? '変更前のMarkdown' : '追加したMarkdown';
      const pre = document.createElement('pre'); pre.textContent = hunk.before || hunk.after;
      raw.append(label, pre); details.append(raw);
    } else {
      const pre = document.createElement('pre'); pre.textContent = hunk.before || hunk.after; details.append(pre);
    }
  });
  return details;
}
export function disposeComparison(card: globalThis.Node): void {
  if (!(card instanceof HTMLElement)) return;
  card.querySelectorAll<HTMLElement>('.inline-before').forEach(details => {
    disposers.get(details)?.(); disposers.delete(details);
  });
}
