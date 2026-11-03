import type { Command } from 'prosemirror-state';
import { isInTable, selectedRect } from 'prosemirror-tables';

/** Markdown alignment belongs to the column separator, so update the entire column. */
export function alignTableColumns(align: 'left' | 'center' | 'right'): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    const rect = selectedRect(state);
    if (dispatch) {
      const tr = state.tr, seen = new Set<number>();
      for (let row = 0; row < rect.map.height; row++) for (let column = rect.left; column < rect.right; column++) {
        const offset = rect.map.map[row * rect.map.width + column]; if (seen.has(offset)) continue; seen.add(offset);
        const cell = rect.table.nodeAt(offset)!;
        tr.setNodeMarkup(rect.tableStart + offset, undefined, { ...cell.attrs, align });
      }
      dispatch(tr);
    }
    return true;
  };
}

import { TextSelection } from 'prosemirror-state';
import { addRow, addColumn, TableMap, moveTableRow, moveTableColumn, deleteRow, deleteColumn } from 'prosemirror-tables';

export type QuickTableAction = 'addRow' | 'addColumn' | 'rowUp' | 'rowDown' | 'columnLeft' | 'columnRight' | 'appendRow' | 'appendColumn' | 'deleteRow' | 'deleteColumn' | 'numberColumn' | 'addRowBefore' | 'addColumnBefore';

/** Single transaction, including caret placement. The first Markdown row remains the header. */
export function quickTableCommand(action: QuickTableAction, tablePos?: number): Command {
  return (state, dispatch) => {
    const selected = isInTable(state) ? selectedRect(state) : undefined;
    const pos = tablePos ?? (selected ? selected.tableStart - 1 : undefined);
    if (pos === undefined) return false;
    const table = state.doc.nodeAt(pos);
    if (!table || table.type.spec.tableRole !== 'table') return false;
    const map = TableMap.get(table), tableStart = pos + 1;
    let rectangular = true;
    table.forEach(row => row.forEach(cell => { if (cell.attrs.colspan !== 1 || cell.attrs.rowspan !== 1) rectangular = false; }));
    if (!rectangular || map.problems?.length) return false;
    const active = selected?.tableStart === tableStart ? selected : undefined;
    if (!active && !action.startsWith('append')) return false;
    const rect = active ?? { table, map, tableStart, top: 0, bottom: 1, left: 0, right: 1 };
    let row = rect.top, column = rect.left;
    if (action === 'numberColumn') {
      if (rect.right - rect.left !== 1) return false;
      if (dispatch) dispatch(state.tr.setNodeMarkup(pos, undefined, { ...table.attrs, numberColumn: table.attrs.numberColumn === column ? null : column }));
      return true;
    }
    if (action === 'deleteRow' || action === 'deleteColumn') {
      if (action === 'deleteRow' && (rect.top === 0 || rect.bottom - rect.top !== 1)) return false;
      if (action === 'deleteColumn' && rect.right - rect.left !== 1) return false;
      return (action === 'deleteRow' ? deleteRow : deleteColumn)(state, dispatch ? tr => {
        if (action === 'deleteColumn' && Number.isInteger(table.attrs.numberColumn)) {
          const numberColumn = table.attrs.numberColumn === column ? null : table.attrs.numberColumn > column ? table.attrs.numberColumn - 1 : table.attrs.numberColumn;
          const node = tr.doc.nodeAt(pos);
          if (node?.type.spec.tableRole === 'table') tr.setNodeMarkup(pos, undefined, { ...node.attrs, numberColumn });
        }
        const remaining = tr.doc.nodeAt(pos);
        if (remaining?.type.spec.tableRole === 'table') {
          const nextMap = TableMap.get(remaining);
          const nextRow = Math.min(row, nextMap.height - 1), nextColumn = Math.min(column, nextMap.width - 1);
          tr.setSelection(TextSelection.near(tr.doc.resolve(tableStart + nextMap.map[nextRow * nextMap.width + nextColumn] + 1)));
        }
        dispatch(tr.scrollIntoView());
      } : undefined);
    }

    if (action === 'rowUp' || action === 'rowDown') {
      const target = row + (action === 'rowUp' ? -1 : 1);
      if (rect.bottom - rect.top !== 1 || row === 0 || target < 1 || target >= map.height) return false;
      if (!dispatch) return true;
      return moveTableRow({ from: row, to: target, pos: tableStart + map.map[row * map.width + column] + 1, select: false })(state, dispatch ? tr => {
        const moved = TableMap.get(tr.doc.nodeAt(pos)!);
        tr.setSelection(TextSelection.near(tr.doc.resolve(tableStart + moved.map[target * moved.width + column] + 1)));
        dispatch(tr.scrollIntoView());
      } : undefined);
    }
    if (action === 'columnLeft' || action === 'columnRight') {
      const target = column + (action === 'columnLeft' ? -1 : 1);
      if (rect.right - rect.left !== 1 || target < 0 || target >= map.width) return false;
      if (!dispatch) return true;
      return moveTableColumn({ from: column, to: target, pos: tableStart + map.map[row * map.width + column] + 1, select: false })(state, dispatch ? tr => {
        if (Number.isInteger(table.attrs.numberColumn)) {
          const numberColumn = table.attrs.numberColumn === column ? target : table.attrs.numberColumn === target ? column : table.attrs.numberColumn;
          const node = tr.doc.nodeAt(pos)!; tr.setNodeMarkup(pos, undefined, { ...node.attrs, numberColumn });
        }
        const moved = TableMap.get(tr.doc.nodeAt(pos)!);
        tr.setSelection(TextSelection.near(tr.doc.resolve(tableStart + moved.map[row * moved.width + target] + 1)));
        dispatch(tr.scrollIntoView());
      } : undefined);
    }
    if (action === 'addRowBefore' && rect.top === 0) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    if (action === 'addRow' || action === 'appendRow' || action === 'addRowBefore') {
      row = action === 'appendRow' ? map.height : action === 'addRowBefore' ? rect.top : rect.bottom;
      addRow(tr, rect, row);
    } else {
      column = action === 'appendColumn' ? map.width : action === 'addColumnBefore' ? rect.left : rect.right;
      addColumn(tr, rect, column);
      if (Number.isInteger(table.attrs.numberColumn) && column <= table.attrs.numberColumn) {
        const node = tr.doc.nodeAt(pos)!; tr.setNodeMarkup(pos, undefined, { ...node.attrs, numberColumn: table.attrs.numberColumn + 1 });
      }
    }
    const next = tr.doc.nodeAt(pos)!, nextMap = TableMap.get(next);
    // Table commands create default cells: restore column alignment and Markdown header roles.
    next.forEach((r, rowOffset, rIndex) => r.forEach((cell, cellOffset, colIndex) => {
      const type = state.schema.nodes[rIndex === 0 ? 'table_header' : 'table_cell'];
      const align = next.firstChild!.child(colIndex).attrs.align;
      if (cell.type !== type || cell.attrs.align !== align)
        tr.setNodeMarkup(tableStart + rowOffset + 1 + cellOffset, type, { ...cell.attrs, align });
    }));
    if (['addRow', 'appendRow', 'addRowBefore'].includes(action) && next.attrs.numberColumn === column && nextMap.width > 1)
      column = column + 1 < nextMap.width ? column + 1 : 0;
    tr.setSelection(TextSelection.near(tr.doc.resolve(tableStart + nextMap.map[row * nextMap.width + column] + 1)));
    dispatch(tr.scrollIntoView()); return true;
  };
}
