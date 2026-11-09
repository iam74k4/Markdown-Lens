
import { t } from './i18n';/** Semantic flowchart comparison; unsupported shapes/styles fall back to exact previews. */
export interface FlowNode { id: string; text?: string; type?: string; labelType?: string; styles?: string[]; classes?: string[]; props?: unknown; link?: string; img?: string; icon?: string }
export interface FlowEdge { start: string; end: string; text?: string; type?: string; stroke?: string; style?: string[]; classes?: string[]; length?: number }
export interface FlowGraph { direction: string; nodes: FlowNode[]; edges: FlowEdge[]; subgraphs: number; styled: boolean }
export interface FlowDiff { source: string; nodes: Record<string, string>; edges: string[]; summary: string }
const shapes: Record<string, [string, string]> = { square: ['[', ']'], rect: ['[', ']'], round: ['(', ')'], circle: ['((', '))'], doublecircle: ['(((', ')))'], diamond: ['{', '}'], hexagon: ['{{', '}}'], stadium: ['([', '])'], cylinder: ['[(', ')]'], subroutine: ['[[', ']]'] };
const plain = (text: string) => !/[<>\r\n]|&(?:#|[a-z])/i.test(text);
const quote = (text: string) => '"' + text.replace(/&/g, '&amp;').replace(/"/g, '#quot;') + '"';
export function flowDifference(before: FlowGraph, after: FlowGraph): FlowDiff | undefined {
  const supported = (g: FlowGraph) => !g.subgraphs && !g.styled && g.nodes.length <= 80 && g.edges.length <= 120 && /^(LR|RL|TB|TD|BT)$/.test(g.direction) &&
    g.nodes.every(n => shapes[n.type ?? 'square'] && n.labelType !== 'markdown' && !n.styles?.length && !n.classes?.length && (!n.props || Object.keys(n.props as object).length === 0) && !n.link && !n.img && !n.icon && plain(n.text ?? n.id)) &&
    g.edges.every(e => (!e.type || ['arrow_point', 'arrow_open'].includes(e.type)) && (!e.stroke || e.stroke === 'normal') && !e.style?.length && !e.classes?.length && (e.length ?? 1) === 1 && plain(e.text ?? ''));
  if (!supported(before) || !supported(after) || before.direction !== after.direction) return;
  const old = new Map(before.nodes.map(n => [n.id, n])), next = new Map(after.nodes.map(n => [n.id, n]));
  const ids = [...new Set([...after.nodes.map(n => n.id), ...before.nodes.map(n => n.id)])];
  const aliases = new Map(ids.map((id, i) => [id, `n${i}`]));
  const statuses: Record<string, string> = {};
  const lines = [`flowchart ${after.direction}`];
  let added = 0, removed = 0, changed = 0;
  for (const id of ids) {
    const a = old.get(id), b = next.get(id), n = b ?? a!;
    const status = !a ? 'added' : !b ? 'removed' : (a.text ?? id) !== (b.text ?? id) || (a.type ?? 'square') !== (b.type ?? 'square') ? 'changed' : '';
    if (status === 'added') added++; if (status === 'removed') removed++; if (status === 'changed') changed++;
    const label = status === 'changed' && a?.text !== b?.text ? `${a?.text ?? id} → ${b?.text ?? id}` : n.text ?? id;
    const shape = shapes[n.type ?? 'square'];
    statuses[aliases.get(id)!] = status;
    lines.push(`${aliases.get(id)}${shape[0]}${quote((status === 'added' ? '＋ ' : status === 'removed' ? '− ' : '') + label)}${shape[1]}`);
  }
  const key = (e: FlowEdge) => JSON.stringify([e.start, e.end, e.type ?? 'arrow_point']);
  // Parallel edges without stable identities must not be guessed.
  if ([before, after].some(g => new Set(g.edges.map(key)).size !== g.edges.length)) return;
  const oldEdges = new Map(before.edges.map(e => [key(e), e]));
  const nextEdges = new Map(after.edges.map(e => [key(e), e]));
  const edges: string[] = [];
  for (const k of new Set([...nextEdges.keys(), ...oldEdges.keys()])) {
    const a = oldEdges.get(k), b = nextEdges.get(k), e = b ?? a!;
    if (!aliases.has(e.start) || !aliases.has(e.end)) return;
    const status = !a ? 'added' : !b ? 'removed' : a.text !== b.text ? 'changed' : '';
    if (status === 'added') added++; if (status === 'removed') removed++; if (status === 'changed') changed++;
    const label = status === 'changed' ? `${a?.text || t('ラベルなし')} → ${b?.text || t('ラベルなし')}` : e.text;
    const arrow = e.type === 'arrow_open' ? '---' : '-->';
    lines.push(`${aliases.get(e.start)} ${arrow}${label ? `|${quote(label)}|` : ''} ${aliases.get(e.end)}`);
    edges.push(status);
  }
  return { source: lines.join('\n'), nodes: statuses, edges, summary: t('追加 {0} · 削除 {1} · 変更 {2}', added, removed, changed) };
}
