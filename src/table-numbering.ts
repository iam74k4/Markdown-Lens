import { Fragment, Node as PMNode } from 'prosemirror-model';
import { Plugin, type Transaction } from 'prosemirror-state';

export interface NumberingRule { header: string; column: number }
const signature = (table: PMNode) => JSON.stringify(Array.from({ length: table.firstChild!.childCount }, (_, i) => table.firstChild!.child(i).textContent));

/** In-memory editor setting: no hidden syntax or attributes are written to Markdown. */
export function withoutNumbering(node: PMNode): PMNode {
  const children: PMNode[] = []; let changed = false;
  node.forEach(child => { const next = withoutNumbering(child); children.push(next); changed ||= next !== child; });
  if (node.type.spec.tableRole === 'table' && node.attrs.numberColumn !== null)
    return node.type.create({ ...node.attrs, numberColumn: null }, changed ? Fragment.from(children) : node.content, node.marks);
  return changed ? node.copy(Fragment.from(children)) : node;
}
export function numberingRules(doc: PMNode): NumberingRule[] {
  const rules: NumberingRule[] = [];
  doc.descendants(node => {
    if (node.type.spec.tableRole === 'table' && Number.isInteger(node.attrs.numberColumn)) rules.push({ header: signature(node), column: node.attrs.numberColumn });
  }); return rules;
}
export function restoreNumbering(doc: PMNode, rules: NumberingRule[]): PMNode {
  const counts = new Map<string, number>();
  doc.descendants(node => { if (node.type.spec.tableRole === 'table') { const key = signature(node); counts.set(key, (counts.get(key) ?? 0) + 1); } });
  const visit = (node: PMNode): PMNode => {
    if (node.type.spec.tableRole === 'table') {
      const key = signature(node), matches = rules.filter(rule => rule.header === key && Number.isInteger(rule.column) && rule.column >= 0 && rule.column < node.firstChild!.childCount);
      // Ambiguous tables never inherit another table's setting after an external edit.
      if (counts.get(key) === 1 && matches.length === 1) return node.type.create({ ...node.attrs, numberColumn: matches[0].column }, node.content, node.marks);
    }
    const children: PMNode[] = []; node.forEach(child => children.push(visit(child)));
    return node.isLeaf ? node : node.copy(Fragment.from(children));
  }; return visit(doc);
}
export function renumberTables(tr: Transaction): Transaction {
  const replacements: { from: number; to: number; text: string }[] = [];
  tr.doc.descendants((table, pos) => {
    if (table.type.spec.tableRole !== 'table') return;
    const col = table.attrs.numberColumn;
    if (!Number.isInteger(col) || col < 0 || col >= table.firstChild!.childCount) return;
    let simple = true; table.forEach(row => row.forEach(cell => { if (cell.attrs.colspan !== 1 || cell.attrs.rowspan !== 1) simple = false; }));
    if (!simple) return;
    table.forEach((row, rowOffset, rowIndex) => {
      if (!rowIndex) return;
      row.forEach((cell, cellOffset, column) => {
        if (column !== col) return;
        const text = String(rowIndex);
        if (cell.childCount === 1 && cell.firstChild!.type.name === 'paragraph' && cell.firstChild!.textContent === text && !cell.firstChild!.firstChild?.marks.length) return;
        replacements.push({ from: pos + rowOffset + cellOffset + 4, to: pos + rowOffset + cellOffset + 4 + cell.firstChild!.content.size, text });
      });
    }); return false;
  });
  for (const replacement of replacements.sort((a,b) => b.from - a.from))
    tr.replaceWith(replacement.from, replacement.to, tr.doc.type.schema.text(replacement.text));
  return tr;
}
export const autoNumbering = new Plugin({
  appendTransaction(transactions, _old, state) {
    if (!transactions.some(tr => tr.docChanged)) return null;
    const tr = renumberTables(state.tr);
    return tr.docChanged ? tr : null;
  },
});
