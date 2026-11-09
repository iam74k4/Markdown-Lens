import MarkdownIt from 'markdown-it';
import Token from 'markdown-it/lib/token.mjs';
import { diffArrays } from 'diff';
import { createHash } from 'node:crypto';
import { icon } from './icons';
import { changedCells, CellChange } from './cell-review';
import { colorMarkdown } from './text-colors';
import { markdownBreaks } from './markdown-breaks';
import { markdownSyntax, frontMatterRows, type RawMeta } from './markdown-syntax';
import { limits } from './limits';
import { t } from './i18n';

// Bound synchronous diff work so a generated document cannot hang the extension host.
/** @deprecated Use limits.maxBytes; kept for callers that read the default. */
export const MAX_BYTES = 512 * 1024;
const md = new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: false });
md.use(colorMarkdown).use(markdownBreaks).use(markdownSyntax);
export const escapeHtml = (s: string) => md.utils.escapeHtml(s);

// Document content never creates navigable URLs or makes remote image requests.
md.renderer.rules.link_open = (tokens, i) => `<span class="md-link" data-href="${escapeHtml(tokens[i].attrGet('href') ?? '')}" title="${escapeHtml(tokens[i].attrGet('href') ?? '')}">`;
md.renderer.rules.link_close = () => '</span>';
md.renderer.rules.image = (tokens, i, _options, env) => {
  const src = tokens[i].attrGet('src') ?? '';
  const resolved = (env as RenderOptions).imageUri?.(src);
  return resolved ? `<img class="markdown-image" data-source="${escapeHtml(src)}" src="${escapeHtml(resolved)}" alt="${escapeHtml(tokens[i].content)}" loading="lazy"><span class="image-fallback" hidden>${t('画像を読み込めません')}: ${escapeHtml(tokens[i].content)}</span>` : `<span class="image-placeholder">${t('画像')}: ${escapeHtml(tokens[i].content)} <small>${escapeHtml(src)}</small><small>${t('ワークスペース内のローカル画像をプレビューできます')}</small></span>`;
};
// HTML in documents is shown as source. Only attribute-free presentational tags render.
const SAFE_TAG = /^<\/?(kbd|sub|sup|small|u|b|i|em|strong)>$/i;
md.renderer.rules.html_block = (tokens, i) => `<pre class="raw-block raw-${/^\s*<!--/.test(tokens[i].content) ? 'comment' : 'html'}"><code>${escapeHtml(tokens[i].content.replace(/\r?\n$/, ''))}</code></pre>`;
// Host-generated diff markup, never document content.
md.renderer.rules.review_inline = md.renderer.rules.review_block = (tokens, i) => tokens[i].content;
md.renderer.rules.html_inline = (tokens, i) => `<code class="raw-html">${escapeHtml(tokens[i].content)}</code>`;
export const alertLabel = (kind: string) => ({ note: t('注記'), tip: t('ヒント'), important: t('重要'), warning: t('警告'), caution: t('注意') } as Record<string, string>)[kind] ?? kind;
md.renderer.rules.md_raw = (tokens, i) => {
  const token = tokens[i], meta = token.meta as RawMeta, source = escapeHtml(token.content);
  switch (meta.kind) {
    case 'html': return SAFE_TAG.test(token.content) ? token.content.toLowerCase() : `<code class="raw-html">${source}</code>`;
    case 'comment': return `<span class="raw-comment" title="${t('HTMLコメント')}">${source}</span>`;
    case 'footnote': return `<sup class="footnote-ref" title="${source}">${escapeHtml(meta.label ?? '')}</sup>`;
    case 'footnoteDef': return `<span class="footnote-def">${escapeHtml(meta.label ?? '')}</span>`;
    case 'wiki': return `<span class="md-link wiki-link" data-wiki="${escapeHtml(meta.target ?? '')}" title="${escapeHtml(meta.target ?? '')}">${escapeHtml(meta.label ?? '')}</span>`;
    case 'math': return `<span class="math-inline${meta.display ? ' math-display' : ''}" data-math="${escapeHtml(meta.math ?? '')}"${meta.display ? ' data-display="true"' : ''}>${source}</span>`;
    case 'alert': return `<span class="alert-label alert-${meta.alert}">${alertLabel(meta.alert ?? '')}</span>`;
    default: return escapeHtml(meta.text ?? token.content);
  }
};
md.renderer.rules.front_matter = (tokens, i) => frontMatterHtml(tokens[i].content);
md.renderer.rules.math_block = (tokens, i) => `<div class="math-block" data-math="${escapeHtml(tokens[i].content)}" data-display="true"><code>${escapeHtml(tokens[i].content)}</code></div>`;
md.renderer.rules.blockquote_open = (tokens, i, options, _env, self) => tokens[i].meta?.alert ? `<blockquote class="markdown-alert markdown-alert-${tokens[i].meta.alert}">` : self.renderToken(tokens, i, options);
export function frontMatterHtml(source: string): string {
  const rows = frontMatterRows(source);
  const body = rows ? `<table><tbody>${rows.map(row => `<tr><th>${escapeHtml(row.key)}</th><td>${escapeHtml(row.value)}</td></tr>`).join('')}</tbody></table>` : `<pre><code>${escapeHtml(source)}</code></pre>`;
  return `<div class="frontmatter"><span class="frontmatter-label">${t('メタデータ')}</span>${body}</div>`;
}
export interface RenderOptions { imageUri?: (src: string) => string | undefined }
const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, i, options, env, self) => tokens[i].info.trim() === 'mermaid'
  ? diagramMarkup('', tokens[i].content) : defaultFence(tokens, i, options, env, self);
function diagramMarkup(before: string, after: string) {
  const changed = before && after && before !== after;
  return `<div class="diagram-review" data-before="${escapeHtml(before)}" data-after="${escapeHtml(after)}"><div class="diagram-tools"><span>Mermaid</span>${changed ? `<div class="diagram-modes"><button data-diagram-mode="before">${t('変更前')}</button><button data-diagram-mode="diff" aria-pressed="true">${t('差分')}</button><button data-diagram-mode="after">${t('変更後')}</button></div>` : ''}</div><div class="diagram-canvas" role="img" aria-label="${t('Mermaidの図')}"></div><details class="diagram-source"><summary>${changed ? t('Mermaidソースの差分') : t('Mermaidソース')}</summary><pre><code>${changed ? textDifference(before, after) : escapeHtml(after || before)}</code></pre></details></div>`;
}
function mermaidSource(source: string): string | undefined {
  const tokens = md.parse(source, {});
  return tokens.length === 1 && tokens[0].type === 'fence' && tokens[0].info.trim() === 'mermaid' ? tokens[0].content : undefined;
}

export interface Block { raw: string; start: number; end: number; kind: string }
export interface Hunk { id: string; start: number; end: number; oldStart: number; oldEnd: number; before: string; after: string; eol?: 'LF' | 'CRLF'; moveParts?: Hunk[]; cells?: CellChange[] }
export interface Review { revision: string; html: string; hunks: Hunk[] }
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export function validateSize(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > limits.maxBytes) throw new Error(t('このファイルは{0}を超えています。小さなMarkdownファイルに分割して開いてください。', limits.label));
}

/** Retain every source byte, including CRLFs and trailing blank lines, for exact reverts. */
export function splitBlocks(source: string): Block[] {
  validateSize(source);
  if (!source) return [];
  const lines = [0];
  const re = /\r\n|\r|\n/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) lines.push(match.index + match[0].length);
  const tokens = md.parse(source, {});
  const starts = tokens.filter(t => t.level === 0 && t.map && t.nesting !== -1)
    .map(t => ({ start: lines[t.map![0]] ?? source.length, kind: t.type }));
  if (!starts.length || starts[0].start !== 0) starts.unshift({ start: 0, kind: 'blank' });
  const unique = starts.filter((t, i) => i === 0 || t.start !== starts[i - 1].start);
  if (unique.length > limits.maxBlocks) throw new Error(t('段落が多すぎるため比較できません。ファイルを分割してください。'));
  return unique.map((t, i) => {
    const end = unique[i + 1]?.start ?? source.length;
    return { ...t, end, raw: source.slice(t.start, end) };
  });
}

const inlineMark = (tag: 'ins' | 'del', text: string) => `<${tag}>${escapeHtml(text)}</${tag}>`;
const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
function textDifference(before: string, after: string): string {
  const words = (s: string) => Array.from(segmenter.segment(s), item => item.segment);
  const parts = diffArrays(words(before), words(after), { timeout: 60 });
  if (!parts) return inlineMark('del', before) + inlineMark('ins', after);
  return parts.map(p => p.added ? inlineMark('ins', p.value.join('')) : p.removed ? inlineMark('del', p.value.join('')) : escapeHtml(p.value.join(''))).join('');
}

function shape(t: Token): string {
  return JSON.stringify([t.type, t.tag, t.nesting, t.attrs, t.markup, t.info, t.hidden,
    t.type === 'text' || t.type === 'inline' || t.type === 'fence' || t.type === 'code_block' || t.type === 'code_inline' ? null : t.content]);
}

/** Inline emphasis only when the Markdown structure matches; never produce crossed tags. */
function mergedRender(before: string, after: string, oldEnv: object, newEnv: object): string | undefined {
  const a = md.parse(before, oldEnv), b = md.parse(after, newEnv);
  let visibleChange = false;
  if (a.length !== b.length) return;
  for (let i = 0; i < a.length; i++) {
    if (shape(a[i]) !== shape(b[i])) return;
    if (b[i].type === 'inline') {
      if (a[i].content !== b[i].content && ['td_open', 'th_open'].includes(b[i - 1]?.type)) b[i - 1].attrJoin('class', 'changed-cell');
      const ac = a[i].children ?? [], bc = b[i].children ?? [];
      if (ac.length !== bc.length || ac.some((t, j) => shape(t) !== shape(bc[j]))) return;
      for (let j = 0; j < ac.length; j++) {
        if (ac[j].content === bc[j].content) continue;
        if (bc[j].type !== 'text' && bc[j].type !== 'code_inline') return;
        const code = bc[j].type === 'code_inline';
        const t = new Token('review_inline', '', 0);
        t.content = (code ? '<code>' : '') + textDifference(ac[j].content, bc[j].content) + (code ? '</code>' : '');
        bc[j] = t;
        visibleChange = true;
      }
    } else if (b[i].type === 'fence' || b[i].type === 'code_block') {
      if (a[i].content !== b[i].content) {
        const t = new Token('review_block', '', 0);
        t.content = `<pre><code>${textDifference(a[i].content, b[i].content)}</code></pre>`;
        b[i] = t;
        visibleChange = true;
      }
    } else if (a[i].content !== b[i].content) return;
  }
  if (!visibleChange) return; // e.g. whitespace, URL target or formatting-only changes need source evidence.
  return md.renderer.render(b, md.options, newEnv);
}

export function renderMarkdown(source: string, env: object = {}): string { return md.render(source, env); }

function changedRender(before: string, after: string, oldEnv: object, newEnv: object): string {
  const oldDiagram = mermaidSource(before), newDiagram = mermaidSource(after);
  if (oldDiagram !== undefined && newDiagram !== undefined && oldDiagram !== newDiagram) return diagramMarkup(oldDiagram, newDiagram);
  if (!before.trim() && after.trim()) return `<div class="added-block"><span class="change-label">${t('追加')}</span>${renderMarkdown(after, newEnv)}</div>`;
  if (!after.trim() && before.trim()) return `<div class="removed-block"><span class="change-label">${t('削除')}</span>${renderMarkdown(before, oldEnv)}</div>`;
  const merged = mergedRender(before, after, oldEnv, newEnv);
  if (merged) return merged;
  // Structure/URL/formatting changes are always explicit, including invisible source edits.
  const oldHtml = renderMarkdown(before, oldEnv), newHtml = renderMarkdown(after, newEnv);
  const rendered = oldHtml === newHtml ? newHtml : `<div class="before-block"><span class="change-label">${t('変更前')}</span>${oldHtml}</div><div class="after-block"><span class="change-label">${t('変更後')}</span>${newHtml}</div>`;
  return `${rendered}<details class="source-diff"${oldHtml === newHtml || /\]\(/.test(before + after) ? ' open' : ''}><summary>${t('Markdownの差分')}</summary><pre>${textDifference(before, after)}</pre></details>`;
}

function changeActions(id: string, index: number): string {
  return `<div class="change-actions"><button class="revert has-tooltip" data-revert="${id}" data-tooltip="${t('この変更を戻す')}" aria-label="${t('変更 {0} を戻す', index)}">${icon('undo')}</button><button class="confirm-change has-tooltip" data-review="${id}" data-tooltip="${t('この変更を確認済みにする')}" aria-label="${t('変更 {0} を確認済みにする', index)}">${icon('check')}</button></div>`;
}

type Segment = { kind: 'same'; blocks: Block[] } | { kind: 'change'; hunk: Hunk };
export interface ReviewPlan { revision: string; hunks: Hunk[]; segments: Segment[]; hidden: Set<string>; oldBlocks: Block[]; newBlocks: Block[]; eol?: { previous: 'LF' | 'CRLF'; next: 'LF' | 'CRLF' } }

/** Which blocks changed, without rendering. Shared by the review, counters and summaries. */
export function planReview(before: string, after: string, { cells = true } = {}): ReviewPlan {
  const oldBlocks = splitBlocks(before), newBlocks = splitBlocks(after);
  const revision = hash(JSON.stringify([before, after]));
  const eol = (text: string) => /\r?\n/.exec(text)?.[0];
  if (eol(before) && eol(after) && eol(before) !== eol(after)) {
    const previous = eol(before) === '\r\n' ? 'CRLF' : 'LF', next = eol(after) === '\r\n' ? 'CRLF' : 'LF';
    const hunk: Hunk = { id: revision.slice(0, 20), start: 0, end: after.length, oldStart: 0, oldEnd: before.length, before, after, eol: previous };
    return { revision, hunks: [hunk], segments: [{ kind: 'change', hunk }], hidden: new Set(), oldBlocks, newBlocks, eol: { previous, next } };
  }
  // Blank lines that only separate blocks are not content: appending a section must not
  // flag the previous last paragraph because it gained a separating newline.
  const content = (block: Block) => block.raw.replace(/(?:\r?\n|\r)+$/, '');
  const parts = diffArrays(oldBlocks, newBlocks, { comparator: (a, b) => content(a) === content(b), timeout: 250 });
  if (!parts) throw new Error(t('変更が大きいため比較に時間がかかっています。ファイルを分割してください。'));
  const hunks: Hunk[] = [], segments: Segment[] = [];
  let currentOffset = 0, oldOffset = 0, oldIndex = 0, newIndex = 0;
  let carry: { old: string; next: string } | undefined;
  const add = (old: string, next: string) => {
    const id = hash(JSON.stringify([hunks.length, currentOffset, old, next])).slice(0, 20);
    const hunk: Hunk = { id, start: currentOffset, end: currentOffset + next.length, oldStart: oldOffset, oldEnd: oldOffset + old.length, before: old, after: next, cells: cells ? changedCells(old, next) : undefined };
    hunks.push(hunk); segments.push({ kind: 'change', hunk });
    currentOffset += next.length;
    oldOffset += old.length;
  };
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      let run: Block[] = [];
      const flush = () => { if (run.length) segments.push({ kind: 'same', blocks: run }); run = []; };
      for (let k = 0; k < part.value.length; k++) {
        const o = oldBlocks[oldIndex + k], n = newBlocks[newIndex + k];
        if (o.raw === n.raw) { run.push(n); currentOffset += n.raw.length; oldOffset += o.raw.length; continue; }
        const common = Math.min(o.raw.length, n.raw.length);
        if (o.raw.slice(0, common) !== n.raw.slice(0, common)) { flush(); add(o.raw, n.raw); continue; }
        // Same content, different separating newlines: keep the block unchanged and review
        // only the newline, together with an insertion or deletion that follows it.
        run.push({ ...n, raw: n.raw.slice(0, common), end: n.start + common });
        currentOffset += common; oldOffset += common;
        const extra = { old: o.raw.slice(common), next: n.raw.slice(common) };
        if (k === part.value.length - 1 && i + 1 < parts.length) carry = extra;
        else { flush(); add(extra.old, extra.next); }
      }
      flush();
      oldIndex += part.value.length; newIndex += part.value.length;
      continue;
    }
    const olds: Block[] = [], news: Block[] = [];
    // Consume the whole edit run, regardless of library insertion/removal ordering.
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      if (parts[i].removed) { olds.push(...oldBlocks.slice(oldIndex, oldIndex + parts[i].value.length)); oldIndex += parts[i].value.length; }
      else { news.push(...newBlocks.slice(newIndex, newIndex + parts[i].value.length)); newIndex += parts[i].value.length; }
      i++;
    }
    i--;
    const pending = carry; carry = undefined;
    if (pending && (olds.length && news.length)) add(pending.old, pending.next);
    const withCarry = (old: string, next: string, first: boolean) => first && pending && !(olds.length && news.length) ? add(pending.old + old, pending.next + next) : add(old, next);
    if (olds.length === news.length && olds.length > 0 && olds.every((b, j) => b.kind === news[j].kind)) {
      olds.forEach((b, j) => add(b.raw, news[j].raw));
    } else if (!olds.length) news.forEach((b, j) => withCarry('', b.raw, j === 0));
    else if (!news.length) olds.forEach((b, j) => withCarry(b.raw, '', j === 0));
    else add(olds.map(b => b.raw).join(''), news.map(b => b.raw).join(''));
  }
  // Only unique, byte-identical whole blocks are moves. Ambiguous duplicates stay explicit.
  const removed = hunks.filter(h => h.before.trim() && !h.after);
  const hidden = new Set<string>();
  for (const added of hunks.filter(h => !h.before && h.after.trim())) {
    const matches = removed.filter(h => h.before === added.after);
    if (matches.length !== 1 || oldBlocks.filter(b => b.raw === added.after).length !== 1 || newBlocks.filter(b => b.raw === added.after).length !== 1) continue;
    const removal = matches[0];
    added.moveParts = [{ ...removal }, { ...added }];
    hidden.add(removal.id);
  }
  return { revision, hunks: hunks.filter(h => !hidden.has(h.id)), segments, hidden, oldBlocks, newBlocks };
}

/** The number of unreviewed changes, without rendering any HTML. */
export const countChanges = (before: string, after: string): number => planReview(before, after, { cells: false }).hunks.length;

export function buildReview(before: string, after: string, options: RenderOptions = {}): Review {
  const plan = planReview(before, after);
  const oldEnv = { ...options }, newEnv = { ...options };
  md.parse(before, oldEnv); md.parse(after, newEnv);
  const { revision, hunks: visible, hidden } = plan;
  if (plan.eol) {
    const hunk = visible[0];
    return { revision, hunks: [hunk], html: `<section class="change" data-hunk="${hunk.id}" tabindex="-1" aria-label="${t('変更 {0}', 1)}"><p class="change-label">${t('改行コード {0} → {1}（ファイル全体を1件として確認・復元）', plan.eol.previous, plan.eol.next)}</p><div class="change-content">${changedRender(before, after, oldEnv, newEnv)}</div>${changeActions(hunk.id, 1)}</section>` };
  }
  const html = plan.segments.map(segment => {
    if (segment.kind === 'same') return `<details class="unchanged" open><summary>${t('変更のない {0} ブロック', segment.blocks.length)}</summary><div>${renderMarkdown(segment.blocks.map(b => b.raw).join(''), newEnv)}</div></details>`;
    const hunk = segment.hunk;
    if (hidden.has(hunk.id)) return `<div class="move-origin">${t('↕ この段落は移動しました')}</div>`;
    const index = visible.indexOf(hunk) + 1;
    if (!hunk.moveParts) return `<section class="change" data-hunk="${hunk.id}" tabindex="-1" aria-label="${t('変更 {0}', index)}"><div class="change-content">${changedRender(hunk.before, hunk.after, oldEnv, newEnv)}</div>${changeActions(hunk.id, index)}${cellActions(hunk)}</section>`;
    const fromLine = before.slice(0, hunk.moveParts[0].oldStart).split('\n').length;
    const toLine = after.slice(0, hunk.start).split('\n').length;
    return `<section class="change moved-block" data-hunk="${hunk.id}" tabindex="-1" aria-label="${t('変更 {0}', index)}"><span class="move-label">${t('↕ 移動 · 元の {0} 行 → 現在の {1} 行', fromLine, toLine)}</span><div class="change-content">${renderMarkdown(hunk.after, newEnv)}</div>${changeActions(hunk.id, index)}</section>`;
  }).join('');
  return { revision, html, hunks: visible };
}

export function revertHunk(current: string, hunk: Hunk): string {
  if (hunk.moveParts) return applyParts(current, hunk.moveParts, false);
  if (current.slice(hunk.start, hunk.end) !== hunk.after) throw new Error(t('ファイルが更新されました。最新の差分でもう一度お試しください。'));
  return current.slice(0, hunk.start) + hunk.before + current.slice(hunk.end);
}

/** Adopt only this displayed change into the confirmed baseline; never edit the document. */
export function confirmHunk(baseline: string, hunk: Hunk): string {
  if (hunk.moveParts) return applyParts(baseline, hunk.moveParts, true);
  if (baseline.slice(hunk.oldStart, hunk.oldEnd) !== hunk.before) throw new Error(t('比較元が更新されました。最新の差分でもう一度お試しください。'));
  const next = baseline.slice(0, hunk.oldStart) + hunk.after + baseline.slice(hunk.oldEnd);
  validateSize(next);
  return next;
}

function applyParts(text: string, parts: Hunk[], confirming: boolean): string {
  const edits = parts.map(h => ({ start: confirming ? h.oldStart : h.start, end: confirming ? h.oldEnd : h.end, expected: confirming ? h.before : h.after, replacement: confirming ? h.after : h.before }));
  for (const e of edits) if (text.slice(e.start, e.end) !== e.expected) throw new Error(t('ファイルまたは比較元が更新されました。'));
  for (const e of edits.sort((a, b) => b.start - a.start || b.end - a.end)) text = text.slice(0, e.start) + e.replacement + text.slice(e.end);
  validateSize(text);
  return text;
}

export const cellPosition = (row: number, column: number) => row === 0 ? t('見出し · {0}列目', column + 1) : t('{0}行目 · {1}列目', row, column + 1);
function cellActions(hunk: Hunk): string {
  if (!hunk.cells?.length) return '';
  return `<details class="cell-review-list"><summary>${t('セルごとに確認 · {0}件', hunk.cells.length)}</summary>${hunk.cells.map(cell => `<div class="cell-review-item"><span>${cellPosition(cell.row, cell.column)}</span><code>${escapeHtml(cell.before.text)} → ${escapeHtml(cell.after.text)}</code><button data-cell-action="revertCell" data-cell-hunk="${hunk.id}" data-row="${cell.row}" data-column="${cell.column}" aria-label="${t('このセルを戻す')}">${icon('undo')}</button><button data-cell-action="reviewCell" data-cell-hunk="${hunk.id}" data-row="${cell.row}" data-column="${cell.column}" aria-label="${t('このセルを確認済みにする')}">${icon('check')}</button></div>`).join('')}</details>`;
}
