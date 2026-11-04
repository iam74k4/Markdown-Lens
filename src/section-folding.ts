import type { Node as PMNode } from 'prosemirror-model';
import { Decoration } from 'prosemirror-view';
import { icon } from './icons';

export interface HeadingSection { key: string; title: string; level: number; from: number; body: number; end: number }
/** A path and sibling occurrence distinguish repeated headings without writing IDs to Markdown. */
export function headingKeys() {
  const path: { level: number; key: string }[] = [], counts = new Map<string, number>();
  return (level: number, title: string) => {
    while (path.length && path[path.length - 1].level >= level) path.pop();
    const base = JSON.stringify([path.at(-1)?.key ?? '', level, title]);
    const count = (counts.get(base) ?? 0) + 1; counts.set(base, count);
    const key = JSON.stringify([base, count]); path.push({ level, key }); return key;
  };
}
export function headingSections(doc: PMNode, includeEmpty = false): HeadingSection[] {
  const sections: HeadingSection[] = [], stack: HeadingSection[] = [], key = headingKeys();
  doc.forEach((node, pos) => {
    if (node.type.name !== 'heading') return;
    const level = node.attrs.level as number;
    while (stack.length && stack.at(-1)!.level >= level) stack.pop()!.end = pos;
    const section = { key: key(level, node.textContent), title: node.textContent, level, from: pos, body: pos + node.nodeSize, end: doc.content.size };
    sections.push(section); stack.push(section);
  });
  return includeEmpty ? sections : sections.filter(s => s.body < s.end);
}
export function insideSection(section: HeadingSection, position: number, size: number): boolean {
  return position >= section.body && (position < section.end || (section.end === size && position === size));
}
export function foldButton(title: string, collapsed: boolean, count: number, toggle: () => void): HTMLButtonElement {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'section-toggle'; button.contentEditable = 'false';
  button.setAttribute('aria-expanded', String(!collapsed));
  button.setAttribute('aria-label', `「${title || '見出し'}」を${collapsed ? '展開' : '折りたたむ'}`);
  button.title = `${button.getAttribute('aria-label')}${count ? `（変更 ${count}件）` : ''}`;
  button.innerHTML = icon(collapsed ? 'right' : 'down');
  if (collapsed) {
    const badge = document.createElement('span'); badge.className = 'section-fold-count'; badge.textContent = count ? `${count}件` : '…'; button.append(badge);
  }
  button.addEventListener('mousedown', e => e.preventDefault());
  button.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); toggle(); });
  return button;
}
export function sectionDecorations(doc: PMNode, sections: HeadingSection[], folded: Set<string>, changes: { position: number }[], toggle: (key: string) => void): Decoration[] {
  const hidden = (position: number) => sections.some(s => folded.has(s.key) && insideSection(s, position, doc.content.size));
  const decorations: Decoration[] = [];
  doc.forEach((node, pos) => { if (hidden(pos)) decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'section-hidden' })); });
  for (const s of sections) {
    if (hidden(s.from)) continue;
    const collapsed = folded.has(s.key), count = changes.filter(c => insideSection(s, c.position, doc.content.size)).length;
    decorations.push(Decoration.widget(s.from + 1, () => foldButton(s.title, collapsed, count, () => toggle(s.key)), {
      side: -1, key: `section:${s.key}:${collapsed}:${count}`, stopEvent: () => true, ignoreSelection: true,
    }));
  }
  return decorations;
}
