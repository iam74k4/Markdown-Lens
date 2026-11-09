import MarkdownIt from 'markdown-it';
import { t } from './i18n';
const md = new MarkdownIt({ html: false });
export interface CellSpan { start: number; end: number; text: string }
export interface CellChange { row: number; column: number; before: CellSpan; after: CellSpan }
export interface RowCell extends CellSpan { rawStart: number; rawEnd: number }
/** Cells of one table row line: text without padding, and the raw span between pipes. */
export function splitRow(line: string): RowCell[] {
  const separators: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '|') continue;
    let slashes = 0; for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) slashes++;
    if (slashes % 2 === 0) separators.push(i);
  }
  const boundaries = [-1, ...separators, line.length];
  const cells: RowCell[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const rawStart = boundaries[i] + 1, rawEnd = boundaries[i + 1], raw = line.slice(rawStart, rawEnd);
    if ((i === 0 || i === boundaries.length - 2) && !raw.trim() && separators.length) continue;
    const left = raw.match(/^\s*/)?.[0].length ?? 0, right = raw.trimEnd().length;
    const start = rawStart + left, end = Math.max(start, rawStart + right);
    cells.push({ start, end, rawStart, rawEnd, text: line.slice(start, end) });
  }
  return cells;
}
/** Exact source spans, including escaped pipes. Ambiguous/irregular tables remain block reviews. */
export function tableCells(source: string): CellSpan[][] | undefined {
  const tokens = md.parse(source, {});
  if (tokens[0]?.type !== 'table_open' || tokens.at(-1)?.type !== 'table_close') return;
  const lines = [...source.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)].filter(m => m[0]);
  const map = tokens[0].map!;
  if (map[0] !== 0 || lines.slice(map[1]).some(m => m[0].trim())) return;
  const rows: CellSpan[][] = [];
  for (let r = 0; r < map[1]; r++) {
    if (r === 1) continue;
    const base = lines[r].index!;
    rows.push(splitRow(lines[r][0].replace(/[\r\n]+$/, '')).map(cell => ({ start: base + cell.start, end: base + cell.end, text: cell.text })));
  }
  const expected = tokens.filter(t => t.type === 'th_open').length;
  if (!expected || rows.some(row => row.length !== expected)) return;
  return rows;
}
export function changedCells(before: string, after: string): CellChange[] | undefined {
  const a = tableCells(before), b = tableCells(after);
  if (!a || !b || a.length !== b.length || a[0].length !== b[0].length) return;
  // Alignment and delimiter edits cannot be represented by a single cell action.
  const skeleton = (source: string, rows: CellSpan[][]) => {
    for (const cell of rows.flat().reverse()) source = source.slice(0, cell.start) + '\uFFFC' + source.slice(cell.end);
    return source.replace(/[ \t]*\|[ \t]*/g, '|');
  };
  if (skeleton(before, a) !== skeleton(after, b)) return;
  return a.flatMap((row, r) => row.flatMap((cell, c) => cell.text !== b[r][c].text ? [{ row: r, column: c, before: cell, after: b[r][c] }] : []));
}
export function applyCell(source: string, start: number, end: number, expected: string, replacement: string): string {
  if (source.slice(start, end) !== expected) throw new Error(t('セルが更新されました。最新の差分でもう一度お試しください。'));
  return source.slice(0, start) + replacement + source.slice(end);
}
