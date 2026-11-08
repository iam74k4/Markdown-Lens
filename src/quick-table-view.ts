import type { Node as PMNode } from 'prosemirror-model';
import { Decoration, DecorationSet, type EditorView, type NodeView, type ViewMutationRecord } from 'prosemirror-view';
import { Plugin } from 'prosemirror-state';
import { TableView, isInTable, selectedRect } from 'prosemirror-tables';
import { closeHistory } from 'prosemirror-history';
import { quickTableCommand, QuickTableAction } from './rich-table';
import { icon } from './icons';
import { t } from './i18n';

export const quickTableSelection = new Plugin({
  props: { decorations(state) {
    if (!isInTable(state)) return null;
    const rect = selectedRect(state), pos = rect.tableStart + rect.map.map[rect.top * rect.map.width + rect.left];
    const cell = state.doc.nodeAt(pos);
    return cell ? DecorationSet.create(state.doc, [Decoration.node(pos, pos + cell.nodeSize, { class: 'quick-cell-target' })]) : null;
  } },
});

/** Controls are outside contentDOM; they cannot enter the Markdown or disrupt cell editing. */
export class QuickTableView implements NodeView {
  readonly dom = document.createElement('div');
  readonly contentDOM: HTMLElement;
  private inner: TableView;
  private tools = document.createElement('div');
  private label = document.createElement('span');
  private buttons = new Map<QuickTableAction, HTMLButtonElement>();
  private disposed = false;
  constructor(node: PMNode, private view: EditorView, private getPos: () => number | undefined) {
    this.inner = new TableView(node, 120); this.contentDOM = this.inner.contentDOM;
    this.dom.className = 'quick-table'; this.tools.className = 'quick-table-tools'; this.tools.contentEditable = 'false';
    this.tools.setAttribute('role', 'toolbar'); this.tools.setAttribute('aria-label', t('行と列のクイック操作'));
    this.label.className = 'quick-table-position'; this.label.setAttribute('aria-live', 'polite'); this.tools.append(this.label);
    const row = document.createElement('div'); row.className = 'quick-table-group';
    const rowLabel = document.createElement('span'); rowLabel.textContent = t('行'); row.append(rowLabel);
    const col = document.createElement('div'); col.className = 'quick-table-group';
    const colLabel = document.createElement('span'); colLabel.textContent = t('列'); col.append(colLabel);
    row.append(this.button('addRow', t('下に行を追加'), 'plus'), this.button('rowUp', t('行を上へ移動'), 'up'), this.button('rowDown', t('行を下へ移動'), 'down'), this.button('deleteRow', t('選択した行を削除'), 'trash'));
    col.append(this.button('addColumn', t('右に列を追加'), 'plus'), this.button('columnLeft', t('列を左へ移動'), 'left'), this.button('columnRight', t('列を右へ移動'), 'right'), this.button('deleteColumn', t('選択した列を削除'), 'trash'));
    this.tools.append(row, col, this.button('numberColumn', t('この列の自動採番を切り替え（1から連番）'), 'number', t('連番')));
    const edges = document.createElement('div'); edges.className = 'quick-table-edges'; edges.contentEditable = 'false';
    edges.append(this.button('appendRow', t('末尾に行を追加'), 'plus', t('行を追加')), this.button('appendColumn', t('末尾に列を追加'), 'plus', t('列を追加')));
    this.dom.append(this.tools, this.inner.dom, edges);
    this.view.dom.addEventListener('table-tools-update', this.refresh);
    queueMicrotask(this.refresh);
  }
  private button(action: QuickTableAction, label: string, glyph: Parameters<typeof icon>[0], text?: string) {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.tableQuick = action;
    button.className = 'quick-table-button' + (action.startsWith('delete') ? ' quick-table-delete' : ''); button.title = label; button.setAttribute('aria-label', label);
    button.innerHTML = icon(glyph);
    if (text) { const span = document.createElement('span'); span.textContent = text; button.append(span); }
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => {
      if (!this.view.editable || this.view.composing || button.disabled) return;
      const pos = this.getPos(); if (pos === undefined) return;
      quickTableCommand(action, pos)(this.view.state, tr => this.view.dispatch(closeHistory(tr)), this.view);
      this.view.focus();
    });
    this.buttons.set(action, button); return button;
  }
  private refresh = () => {
    if (this.disposed) return;
    const pos = this.getPos();
    if (pos === undefined) return;
    const rect = isInTable(this.view.state) ? selectedRect(this.view.state) : undefined;
    const active = rect?.tableStart === pos + 1;
    const label = active ? (rect.top === 0 ? t('見出し · {0}列目', rect.left + 1) : t('{0}行目 · {1}列目', rect.top, rect.left + 1)) : t('セルを選択して操作');
    if (this.label.textContent !== label) this.label.textContent = label;
    this.dom.classList.toggle('quick-table-active', active);
    const numbering = this.buttons.get('numberColumn')!;
    const table = this.view.state.doc.nodeAt(pos);
    const numbered = active && table?.attrs.numberColumn === rect.left;
    numbering.setAttribute('aria-pressed', String(!!numbered));
    numbering.title = numbered ? t('この列の自動採番を解除（番号は保持）') : t('この列を1から連番にする。追加・削除・移動時も更新。このタブで有効');
    for (const [action, button] of this.buttons) button.disabled = !this.view.editable || this.view.composing || !quickTableCommand(action, pos)(this.view.state);
  };
  update(node: PMNode): boolean { const accepted = this.inner.update(node); if (accepted) queueMicrotask(this.refresh); return accepted; }
  stopEvent(event: Event): boolean { return this.tools.contains(event.target as globalThis.Node) || !!(event.target as Element).closest?.('.quick-table-edges'); }
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (mutation.type === 'selection') return false;
    if (this.tools.contains(mutation.target) || (mutation.target as Element).closest?.('.quick-table-edges')) return true;
    if (mutation.type === 'attributes' && mutation.target === this.dom) return true;
    return this.inner.ignoreMutation(mutation);
  }
  destroy() { this.disposed = true; this.view.dom.removeEventListener('table-tools-update', this.refresh); }
}
