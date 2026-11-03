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
