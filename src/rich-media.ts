import { Node as PMNode } from 'prosemirror-model';
import { EditorView, NodeViewConstructor } from 'prosemirror-view';
import { renderDiagrams } from './diagrams';

/** Only host-approved local URLs are used. Node views never fetch a source URL directly. */
export function mediaNodeViews(images: () => Map<string, string>, before: () => Map<string, string>): Record<string, NodeViewConstructor> {
  return {
    image(node, view) {
      const dom = document.createElement('span'); dom.className = 'rich-image'; dom.contentEditable = 'false';
      let current = node, last = '';
      const paint = () => {
        const safe = images().get(current.attrs.src), key = `${safe}\0${current.attrs.alt}\0${current.attrs.src}`;
        if (key === last) return; last = key; dom.replaceChildren();
        const caption = document.createElement('span'); caption.textContent = current.attrs.alt || current.attrs.src; caption.className = 'image-caption';
        if (safe) {
          const img = document.createElement('img'); img.className = 'markdown-image'; img.src = safe; img.alt = current.attrs.alt ?? '';
          img.addEventListener('error', () => { img.hidden = true; caption.textContent = `画像を読み込めません: ${current.attrs.src}`; }); dom.append(img);
        } else { dom.classList.add('image-placeholder'); caption.textContent = `画像: ${current.attrs.alt || ''} (${current.attrs.src})`; }
        dom.classList.toggle('image-placeholder', !safe); dom.append(caption);
      };
      paint(); view.dom.addEventListener('media-refresh', paint);
      return { dom, update(next) { if (next.type !== current.type) return false; current = next; paint(); return true; },
        ignoreMutation: () => true, destroy() { view.dom.removeEventListener('media-refresh', paint); } };
    },
    code_block(node, view, getPos) {
      let current = node, timer: ReturnType<typeof setTimeout> | undefined, key = '';
      const dom = document.createElement('div'); dom.className = 'rich-code';
      const tools = document.createElement('div'); tools.className = 'code-tools'; tools.contentEditable = 'false';
      const label = document.createElement('label'); label.textContent = '言語 ';
      const language = document.createElement('input'); language.setAttribute('aria-label', 'コードブロックの言語'); language.placeholder = 'text / mermaid'; language.value = node.attrs.params || '';
      label.append(language); tools.append(label);
      const preview = document.createElement('div'); preview.contentEditable = 'false'; preview.className = 'rich-diagram-preview';
      const details = document.createElement('details'); details.className = 'rich-code-source';
      const summary = document.createElement('summary'); summary.contentEditable = 'false'; summary.textContent = 'Mermaidソースを編集';
      const pre = document.createElement('pre'), code = document.createElement('code'); pre.append(code); details.append(summary, pre); dom.append(tools, preview, details);
      const paint = () => {
        const mermaid = (current.attrs.params || '').trim() === 'mermaid';
        dom.classList.toggle('is-mermaid', mermaid); preview.hidden = !mermaid; summary.hidden = !mermaid;
        if (!mermaid) { details.open = true; return; }
        const source = current.textContent, previous = before().get(source + '\n') ?? before().get(source) ?? '';
        const nextKey = `${previous}\0${source}`; if (nextKey === key) return; key = nextKey;
        // Replace only the non-editable diagram, never the contentDOM or selection.
        preview.replaceChildren();
        const block = document.createElement('div'); block.className = 'diagram-review'; block.dataset.before = previous; block.dataset.after = source;
        const bar = document.createElement('div'); bar.className = 'diagram-tools'; bar.textContent = 'Mermaid';
        if (previous && previous.trim() !== source.trim()) {
          const modes = document.createElement('div'); modes.className = 'diagram-modes';
          for (const [mode, text] of [['before', '変更前'], ['diff', '差分'], ['after', '変更後']]) {
            const button = document.createElement('button'); button.dataset.diagramMode = mode; button.textContent = text; modes.append(button);
          } bar.append(modes);
        }
        const canvas = document.createElement('div'); canvas.className = 'diagram-canvas'; canvas.setAttribute('role', 'img');
        const fallback = document.createElement('details'); fallback.className = 'diagram-source';
        const hint = document.createElement('summary'); hint.textContent = '図のソース';
        const raw = document.createElement('pre'); raw.textContent = source; fallback.append(hint, raw);
        block.append(bar, canvas, fallback); preview.append(block); renderDiagrams(preview);
      };
      const schedule = () => { clearTimeout(timer); timer = setTimeout(paint, 220); };
      language.addEventListener('change', () => {
        const pos = getPos(); if (pos === undefined || !view.editable) return;
        const value = language.value.replace(/[\r\n]/g, '').slice(0, 80);
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, params: value }));
      });
      preview.addEventListener('dblclick', () => { details.open = true; code.focus(); });
      view.dom.addEventListener('media-refresh', schedule); schedule();
      return { dom, contentDOM: code,
        update(next: PMNode) { if (next.type !== current.type) return false; const changed = next.textContent !== current.textContent || next.attrs.params !== current.attrs.params; current = next;
          if (document.activeElement !== language) language.value = next.attrs.params || ''; if (changed) schedule(); return true; },
        stopEvent: event => tools.contains(event.target as globalThis.Node) || preview.contains(event.target as globalThis.Node) || event.target === summary,
        ignoreMutation: mutation => mutation.type !== 'selection' && (tools.contains(mutation.target) || preview.contains(mutation.target) || (mutation.type === 'attributes' && (mutation.target === details || mutation.target === dom))),
        destroy() { clearTimeout(timer); view.dom.removeEventListener('media-refresh', schedule); },
      };
    },
  };
}
