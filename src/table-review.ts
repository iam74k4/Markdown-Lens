import { icon } from './icons';

const numeric = (value: string) => /^[-+]?\d[\d,.]*(?:\s*(?:%|％|円|秒|分|時間|日|回|台|件|MB|GB|ms))?$/.test(value.trim());
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag); el.className = className; if (text !== undefined) el.textContent = text; return el;
};
const button = (label: string, glyph: Parameters<typeof icon>[0]) => {
  const el = node('button', 'table-tool'); el.type = 'button'; el.innerHTML = icon(glyph); el.append(document.createTextNode(label)); return el;
};
function cellText(element: HTMLElement) {
  const copy = element.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[hidden]').forEach(n => n.remove());
  copy.querySelectorAll('img').forEach(img => img.replaceWith(document.createTextNode(`画像: ${img.alt}`)));
  return copy.textContent ?? '';
}
function version(cell: HTMLElement, remove: string) {
  const copy = cell.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(remove).forEach(n => n.remove());
  return copy;
}

/** All table transforms are presentation-only. No webview message or Markdown edit is emitted. */
export function enhanceTables(container: HTMLElement): () => void {
  const cleanup: (() => void)[] = [];
  container.querySelectorAll<HTMLTableElement>('table').forEach((table, tableIndex) => {
    if (table.closest('.review-table') || !table.tHead?.rows[0] || !table.tBodies[0]) return;
    const head = table.tHead.rows[0], rows = [...table.tBodies[0].rows], columns = head.cells.length;
    if (!columns || rows.some(row => row.cells.length !== columns)) return;
    if (columns * (rows.length + 1) > 2500) {
      const wrapper = node('section', 'review-table'); const scroll = node('div', 'table-scroll');
      scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', '大きな表。縦横にスクロールできます');
      table.before(wrapper); scroll.append(table); wrapper.append(scroll, node('div', 'table-hint', '大きな表のため通常表示です。変更前後のマーカーをそのまま表示します。'));
      table.style.minWidth = `${Math.min(columns * 120, 24000)}px`; return;
    }
    const headerChanged = !!head.querySelector('ins, del, .changed-cell');
    const added = !!table.closest('.added-block, .after-block'), removed = !!table.closest('.removed-block, .before-block');
    const tableStatus = table.closest('.removed-block') ? '削除された表 · ' : table.closest('.before-block') ? '変更前の表 · ' : table.closest('.added-block') ? '追加された表 · ' : table.closest('.after-block') ? '変更後の表 · ' : '';
    const headers = [...head.cells].map(cell => cell.textContent?.trim() || '列');
    const original = new Map<HTMLTableCellElement, { before: string; after: string; changed: boolean }>();
    const changedRows = new Set<HTMLTableRowElement>();
    const controls: HTMLButtonElement[][] = [];
    const wrapper = node('section', 'review-table'); wrapper.setAttribute('aria-label', `表 ${tableIndex + 1}`);
    const toolbar = node('div', 'table-toolbar');
    const count = node('span', 'table-count'); count.setAttribute('aria-live', 'polite');
    const filter = button('変更行', 'filter'); filter.setAttribute('aria-pressed', 'false');
    const expand = button('広く表示', 'expand'); expand.setAttribute('aria-expanded', 'false');
    const reset = button('列幅を戻す', 'undo');
    const actions = node('div', 'table-tools'); actions.append(filter, reset, expand); toolbar.append(count, actions);
    const scroll = node('div', 'table-scroll'); scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', '表。縦横にスクロールできます');
    const details = node('div', 'table-details'); details.hidden = true;
    const hint = node('div', 'table-hint', '見出し・先頭列を固定 · セルを選ぶと詳細 · 列境界で幅を調整');
    table.before(wrapper); scroll.append(table); wrapper.append(toolbar, scroll, details, hint);
    const placeholder = document.createComment('table location'); wrapper.before(placeholder);
    let selected: HTMLButtonElement | undefined, filtered = false;
    const clearSelection = (focus = false) => {
      rows.forEach(row => row.classList.remove('table-selected'));
      controls.flat().forEach(b => b.setAttribute('aria-expanded', 'false'));
      details.hidden = true; details.replaceChildren();
      if (focus && selected?.isConnected) selected.focus({ preventScroll: true });
      selected = undefined;
    };
    const selectCell = (cell: HTMLTableCellElement, control: HTMLButtonElement, row: HTMLTableRowElement, column: number) => {
      clearSelection(); selected = control;
      controls.flat().forEach(b => { b.tabIndex = b === control ? 0 : -1; });
      row.classList.add('table-selected'); control.setAttribute('aria-expanded', 'true');
      const value = original.get(cell)!;
      const title = node('div', 'table-detail-title');
      const rowName = original.get(row.cells[0])?.after || original.get(row.cells[0])?.before || String(rows.indexOf(row) + 1);
      title.append(node('strong', '', `${rowName} · ${headers[column]}`));
      const close = button('閉じる', 'close'); close.addEventListener('click', () => clearSelection(true)); title.append(close);
      details.append(title);
      const values = node('div', 'table-detail-values');
      for (const [label, text] of value.changed ? [['変更前', value.before], ['変更後', value.after]] : [['全文', value.after]]) {
        const section = node('div', 'table-detail-version');
        section.append(node('span', 'table-detail-label', label), node('p', '', text || '（空欄）')); values.append(section);
      }
      details.append(values); details.hidden = false;
    };
    rows.forEach((row, r) => {
      controls[r] = [];
      [...row.cells].forEach((cell, c) => {
        const before = removed ? cellText(cell) : added ? '' : cellText(version(cell, 'ins'));
        const afterNode = version(cell, 'del');
        const after = removed ? '' : cellText(afterNode);
        const changed = added || removed || !!cell.querySelector('ins, del') || cell.classList.contains('changed-cell');
        original.set(cell, { before, after, changed }); if (changed) changedRows.add(row);
        const control = node('button', 'table-cell'); control.type = 'button'; control.tabIndex = r === 0 && c === 0 ? 0 : -1;
        control.setAttribute('aria-expanded', 'false');
        const text = node('span', 'table-cell-summary');
        if (removed) text.textContent = before || '（削除）';
        else if (!after.trim()) text.textContent = changed ? '（削除）' : '—';
        else text.append(...Array.from(afterNode.childNodes));
        control.append(text);
        if (changed) { cell.classList.add('changed-cell'); if (removed || !after.trim()) cell.classList.add('table-removed-cell'); control.setAttribute('aria-label', `${headers[c]}: ${after || '削除'}。変更あり。選択して前後を比較`); }
        else control.setAttribute('aria-label', `${headers[c]}: ${after || '空欄'}。選択して全文を表示`);
        cell.replaceChildren(control); controls[r][c] = control;
        control.addEventListener('click', () => selectCell(cell, control, row, c));
        control.addEventListener('keydown', e => {
          if (e.key === 'Escape') { e.stopPropagation(); clearSelection(true); return; }
          const direction: Record<string, [number, number]> = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] };
          if (!direction[e.key]) return; e.preventDefault();
          const visible = [...table.tBodies[0].rows].filter(r => !r.hidden && rows.includes(r));
          const [dr, dc] = direction[e.key], targetRow = visible[Math.max(0, Math.min(visible.length - 1, visible.indexOf(row) + dr))];
          const target = controls[rows.indexOf(targetRow)][Math.max(0, Math.min(columns - 1, c + dc))];
          controls.flat().forEach(b => { b.tabIndex = b === target ? 0 : -1; }); target.focus();
        });
      });
    });
    const colgroup = document.createElement('colgroup'); table.prepend(colgroup);
    const widths = headers.map((_, c) => {
      const values = rows.map(row => original.get(row.cells[c])!.after || original.get(row.cells[c])!.before).filter(Boolean);
      const numbers = values.length > 0 && values.every(numeric);
      if (numbers) rows.forEach(row => row.cells[c].classList.add('table-numeric'));
      const length = Math.max(headers[c].length, ...values.slice(0, 100).map(v => Math.min(v.length, 40)));
      return numbers ? 130 : Math.max(120, Math.min(c === 0 ? 200 : 320, length * 10 + 36));
    });
    const defaults = [...widths];
    widths.forEach(() => colgroup.append(document.createElement('col')));
    const layout = () => { [...colgroup.children].forEach((col, i) => (col as HTMLElement).style.width = `${widths[i]}px`); table.style.width = `${widths.reduce((a, b) => a + b, 0)}px`; };
    layout();
    [...head.cells].forEach((cell, c) => {
      cell.scope = 'col';
      const grip = node('button', 'table-resize'); grip.type = 'button'; grip.setAttribute('aria-label', `${headers[c]}の列幅を調整。左右キーまたはドラッグ`);
      grip.innerHTML = icon('grip'); cell.append(grip);
      const resize = (n: number) => { widths[c] = Math.round(Math.max(90, Math.min(700, n))); layout(); };
      grip.addEventListener('keydown', e => { if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return; e.preventDefault(); resize(widths[c] + (e.key === 'ArrowRight' ? 20 : -20)); });
      grip.addEventListener('pointerdown', e => {
        if (e.button !== 0) return; e.preventDefault(); grip.setPointerCapture(e.pointerId);
        const start = e.clientX, width = widths[c];
        const move = (event: PointerEvent) => resize(width + event.clientX - start);
        const end = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', end); grip.removeEventListener('pointercancel', end); };
        grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end); cleanup.push(end);
      });
    });
    reset.addEventListener('click', () => { widths.splice(0, widths.length, ...defaults); layout(); });
    const group = node('select', 'table-group-select'); group.setAttribute('aria-label', '行をまとめる列'); group.add(new Option('グループなし', ''));
    headers.forEach((name, c) => {
      const values = rows.map(row => original.get(row.cells[c])!.after);
      const unique = new Set(values);
      if (unique.size > 1 && unique.size <= 12 && unique.size < rows.length && values.every(v => v.length <= 40 && !!v.trim())) group.add(new Option(`${name}でまとめる`, String(c)));
    });
    if (group.options.length > 1) toolbar.insertBefore(group, actions);
    const renderRows = () => {
      clearSelection(); const body = table.tBodies[0]; body.replaceChildren();
      const visible = rows.filter(row => !filtered || changedRows.has(row));
      if (group.value === '') body.append(...rows);
      else {
        const groups = new Map<string, HTMLTableRowElement[]>();
        for (const row of rows) { const name = original.get(row.cells[Number(group.value)])!.after; const list = groups.get(name) ?? []; list.push(row); groups.set(name, list); }
        for (const [name, members] of groups) {
          const label = node('tr', 'table-group-row'); const cell = node('th', '', name); cell.colSpan = columns; cell.scope = 'rowgroup'; label.append(cell); label.hidden = !members.some(r => visible.includes(r)); body.append(label, ...members);
        }
      }
      rows.forEach(row => { row.hidden = !visible.includes(row); });
      controls.flat().forEach(b => { b.tabIndex = -1; }); if (visible.length) controls[rows.indexOf(visible[0])][0].tabIndex = 0;
      count.textContent = tableStatus + (filtered ? `変更 ${visible.length}行` : `${rows.length}行 · 変更 ${changedRows.size}行${headerChanged ? ' · 見出し変更' : ''}`);
      filter.disabled = !changedRows.size; filter.setAttribute('aria-pressed', String(filtered)); scroll.scrollTop = 0;
    };
    filter.addEventListener('click', () => { filtered = !filtered; renderRows(); }); group.addEventListener('change', renderRows); renderRows();
    const dialog = node('dialog', 'table-dialog'); dialog.setAttribute('aria-label', '表を広く表示'); document.body.append(dialog);
    const close = () => { if (dialog.open) dialog.close(); if (placeholder.isConnected) placeholder.after(wrapper); expand.innerHTML = icon('expand') + '広く表示'; expand.setAttribute('aria-expanded', 'false'); };
    dialog.addEventListener('close', () => { if (dialog.open) return; close(); if (expand.isConnected) expand.focus({ preventScroll: true }); });
    expand.addEventListener('click', () => {
      if (dialog.open) { close(); return; }
      dialog.append(wrapper); expand.innerHTML = icon('close') + '本文に戻す'; expand.setAttribute('aria-expanded', 'true'); dialog.showModal(); expand.focus();
    });
    cleanup.push(() => { close(); dialog.remove(); placeholder.remove(); });
  });
  return () => cleanup.forEach(fn => fn());
}
