import type { RichEditor } from './rich-editor';

/** Presentation only: all commands still use the editor's existing draft/review guards. */
export function contextualUI(getEditor: () => RichEditor | undefined) {
  const $ = (id: string) => document.getElementById(id)!;
  const menu = $('tools-panel'), trigger = $('more-tools'), toolbar = $('formatting');
  const insertion = $('insert-tools');
  let source = false, pinned = false, dismissed = '', frame = 0;
  document.body.classList.add('contextual-ui');
  const core = new Set(['block-type', 'color-controls', 'close-formatting']);
  for (const item of [...toolbar.children] as HTMLElement[]) {
    if (core.has(item.id) || ['bold', 'italic', 'link'].includes(item.dataset.format ?? '')) continue;
    if (item instanceof HTMLButtonElement) {
      const label = document.createElement('span'); label.textContent = item.getAttribute('aria-label');
      item.append(label);
    }
    insertion.append(item);
  }
  const tools = document.querySelector<HTMLElement>('.review-tools')!;
  for (const button of tools.querySelectorAll('button')) {
    const label = document.createElement('span'); label.textContent = button.getAttribute('aria-label');
    button.append(label); button.classList.remove('has-tooltip'); button.title = button.dataset.tooltip ?? '';
  }
  $('document-tools').append(tools, document.querySelector('.subbar')!);

  function closeMenu(restore = false) {
    menu.hidden = true; trigger.setAttribute('aria-expanded', 'false');
    if (restore) trigger.focus();
  }
  function selectionKey() {
    const selection = getEditor()?.view.state.selection;
    return selection ? `${selection.from}:${selection.to}` : '';
  }
  function hideFormatting(restore = false, remember = true) {
    pinned = false; dismissed = remember ? selectionKey() : ''; toolbar.hidden = true;
    getEditor()?.closeColors();
    if (restore) getEditor()?.view.focus();
  }
  function update() {
    frame = 0;
    const editor = getEditor(), view = editor?.view;
    if (!view) { toolbar.hidden = true; return; }
    const selection = view.state.selection;
    const focused = view.hasFocus() || toolbar.contains(document.activeElement);
    const key = selectionKey();
    if (dismissed && key !== dismissed) dismissed = '';
    const selected = !selection.empty && focused && key !== dismissed;
    const canShow = !source && !view.dom.closest('[hidden]') && view.editable && !editor.composing && menu.hidden;
    toolbar.hidden = !canShow || !(pinned || selected);
    if (!toolbar.hidden) {
      const headerBottom = document.querySelector('.toolbar')!.getBoundingClientRect().bottom;
      const anchor = view.coordsAtPos(selection.from);
      const end = view.coordsAtPos(selection.to);
      const minTop = Math.max(8, headerBottom + 8);
      // A selection outside the viewport should not leave a detached floating toolbar.
      if (!pinned && (end.bottom < minTop || anchor.top > innerHeight - 70)) toolbar.hidden = true;
      else {
        const height = toolbar.offsetHeight, width = toolbar.offsetWidth;
        const above = anchor.top - height - 8;
        const top = pinned ? minTop : above >= minTop ? above : end.bottom + 8;
        toolbar.style.top = `${Math.max(minTop, Math.min(top, innerHeight - height - 65))}px`;
        toolbar.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - width - 8))}px`;
      }
    }
    const current = editor.selectedChange;
    for (const card of document.querySelectorAll<HTMLElement>('.inline-review')) card.classList.toggle('current-change', focused && card.dataset.hunk === current);
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(update); }
  function showFormatting() {
    if (source) return;
    pinned = true; dismissed = ''; closeMenu(); update();
    toolbar.querySelector<HTMLElement>('select, button:not(:disabled)')?.focus();
  }
  trigger.addEventListener('click', () => {
    if (!menu.hidden) { closeMenu(true); return; }
    hideFormatting(false, false); menu.hidden = false; trigger.setAttribute('aria-expanded', 'true');
    menu.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  });
  $('show-formatting').addEventListener('click', showFormatting);
  $('close-formatting').addEventListener('click', () => hideFormatting(true));
  // Leave focus with dialogs/search/outline opened by the command. Commands that
  // keep focus inside the dismissed menu return it to the menu trigger.
  menu.addEventListener('click', event => {
    const button = (event.target as Element).closest('button');
    if (!button || button.disabled || button.id === 'show-formatting') return;
    closeMenu(menu.contains(document.activeElement)); schedule();
  });
  menu.addEventListener('change', event => {
    if (event.target instanceof HTMLSelectElement) { closeMenu(menu.contains(document.activeElement)); schedule(); }
  });
  document.addEventListener('pointerdown', event => {
    const target = event.target as Node;
    if (!menu.contains(target) && !trigger.contains(target)) closeMenu();
    if (!toolbar.contains(target)) {
      pinned = false;
      if (getEditor()?.view.dom.contains(target)) dismissed = '';
      schedule();
    }
  });
  document.addEventListener('focusin', event => {
    const target = event.target as Node;
    if (!menu.contains(target) && !trigger.contains(target)) closeMenu();
    schedule();
  });
  document.addEventListener('keydown', event => {
    if (event.isComposing || getEditor()?.composing) return;
    if (event.altKey && event.key === 'F10' && !source) { event.preventDefault(); showFormatting(); }
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (!menu.hidden) { event.preventDefault(); closeMenu(true); }
    else if (!toolbar.hidden) { event.preventDefault(); hideFormatting(true); }
  });
  document.addEventListener('editor-selection-change', schedule);
  document.addEventListener('selectionchange', schedule);
  document.addEventListener('compositionstart', () => { toolbar.hidden = true; });
  document.addEventListener('focusout', schedule);
  window.addEventListener('scroll', schedule, { passive: true, capture: true });
  window.addEventListener('resize', schedule);
  return { update(isSource: boolean) {
    if (source !== isSource) { closeMenu(); hideFormatting(false, false); }
    source = isSource;
    // Editing tools target Preview. Never let a stale selection modify hidden text in MD.
    $('show-formatting').hidden = insertion.hidden = source;
    menu.querySelector<HTMLElement>('.tools-heading')!.hidden = source;
    schedule();
  } };
}
