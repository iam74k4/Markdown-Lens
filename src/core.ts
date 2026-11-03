import MarkdownIt from 'markdown-it';
import Token from 'markdown-it/lib/token.mjs';
import { diffArrays } from 'diff';
import { createHash } from 'node:crypto';
import { icon } from './icons';

// Bound synchronous diff work so a generated document cannot hang the extension host.
export const MAX_BYTES = 512 * 1024;
const MAX_BLOCKS = 4000;
const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false });
export const escapeHtml = (s: string) => md.utils.escapeHtml(s);

// Document content never creates navigable URLs or makes remote image requests.
md.renderer.rules.link_open = (tokens, i) => `<span class="md-link" title="${escapeHtml(tokens[i].attrGet('href') ?? '')}">`;
md.renderer.rules.link_close = () => '</span>';
md.renderer.rules.image = (tokens, i) => `<span class="image-placeholder">画像: ${escapeHtml(tokens[i].content)} <small>${escapeHtml(tokens[i].attrGet('src') ?? '')}</small></span>`;

export interface Block { raw: string; start: number; end: number; kind: string }
export interface Hunk { id: string; start: number; end: number; oldStart: number; oldEnd: number; before: string; after: string; eol?: 'LF' | 'CRLF' }
export interface Review { revision: string; html: string; hunks: Hunk[] }
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export function validateSize(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('このファイルは512KBを超えています。小さなMarkdownファイルに分割して開いてください。');
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
  if (unique.length > MAX_BLOCKS) throw new Error('段落が多すぎるため比較できません。ファイルを分割してください。');
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
      const ac = a[i].children ?? [], bc = b[i].children ?? [];
      if (ac.length !== bc.length || ac.some((t, j) => shape(t) !== shape(bc[j]))) return;
      for (let j = 0; j < ac.length; j++) {
        if (ac[j].content === bc[j].content) continue;
        if (bc[j].type !== 'text' && bc[j].type !== 'code_inline') return;
        const code = bc[j].type === 'code_inline';
        const t = new Token('html_inline', '', 0);
        t.content = (code ? '<code>' : '') + textDifference(ac[j].content, bc[j].content) + (code ? '</code>' : '');
        bc[j] = t;
        visibleChange = true;
      }
    } else if (b[i].type === 'fence' || b[i].type === 'code_block') {
      if (a[i].content !== b[i].content) {
        const t = new Token('html_block', '', 0);
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
  if (!before.trim() && after.trim()) return `<div class="added-block"><span class="change-label">追加</span>${renderMarkdown(after, newEnv)}</div>`;
  if (!after.trim() && before.trim()) return `<div class="removed-block"><span class="change-label">削除</span>${renderMarkdown(before, oldEnv)}</div>`;
  const merged = mergedRender(before, after, oldEnv, newEnv);
  if (merged) return merged;
  // Structure/URL/formatting changes are always explicit, including invisible source edits.
  const oldHtml = renderMarkdown(before, oldEnv), newHtml = renderMarkdown(after, newEnv);
  const rendered = oldHtml === newHtml ? newHtml : `<div class="before-block"><span class="change-label">変更前</span>${oldHtml}</div><div class="after-block"><span class="change-label">変更後</span>${newHtml}</div>`;
  return `${rendered}<details class="source-diff"${oldHtml === newHtml || /\]\(/.test(before + after) ? ' open' : ''}><summary>Markdownの差分</summary><pre>${textDifference(before, after)}</pre></details>`;
}

function changeActions(id: string, index: number): string {
  return `<div class="change-actions"><button class="revert has-tooltip" data-revert="${id}" data-tooltip="この変更を戻す" aria-label="変更 ${index} を戻す">${icon('undo')}</button><button class="confirm-change has-tooltip" data-review="${id}" data-tooltip="この変更を確認済みにする" aria-label="変更 ${index} を確認済みにする">${icon('check')}</button></div>`;
}

export function buildReview(before: string, after: string): Review {
  const oldBlocks = splitBlocks(before), newBlocks = splitBlocks(after);
  const oldEnv = {}, newEnv = {};
  md.parse(before, oldEnv); md.parse(after, newEnv);
  const parts = diffArrays(oldBlocks, newBlocks, { comparator: (a, b) => a.raw === b.raw, timeout: 250 });
  const revision = hash(JSON.stringify([before, after]));
  const eol = (text: string) => /\r?\n/.exec(text)?.[0];
  if (eol(before) && eol(after) && eol(before) !== eol(after)) {
    const previousEol = eol(before) === '\r\n' ? 'CRLF' : 'LF';
    const nextEol = eol(after) === '\r\n' ? 'CRLF' : 'LF';
    const id = revision.slice(0, 20);
    const hunk: Hunk = { id, start: 0, end: after.length, oldStart: 0, oldEnd: before.length, before, after, eol: previousEol };
    return { revision, hunks: [hunk], html: `<section class="change" data-hunk="${id}" tabindex="-1" aria-label="変更 1"><p class="change-label">改行コード ${previousEol} → ${nextEol}（ファイル全体を1件として確認・復元）</p><div class="change-content">${changedRender(before, after, oldEnv, newEnv)}</div>${changeActions(id, 1)}</section>` };
  }
  if (!parts) throw new Error('変更が大きいため比較に時間がかかっています。ファイルを分割してください。');
  const hunks: Hunk[] = [];
  const chunks: string[] = [];
  let currentOffset = 0, oldOffset = 0;
  const add = (old: string, next: string) => {
    const id = hash(JSON.stringify([hunks.length, currentOffset, old, next])).slice(0, 20);
    const hunk = { id, start: currentOffset, end: currentOffset + next.length, oldStart: oldOffset, oldEnd: oldOffset + old.length, before: old, after: next };
    hunks.push(hunk);
    chunks.push(`<section class="change" data-hunk="${id}" tabindex="-1" aria-label="変更 ${hunks.length}"><div class="change-content">${changedRender(old, next, oldEnv, newEnv)}</div>${changeActions(id, hunks.length)}</section>`);
    currentOffset += next.length;
    oldOffset += old.length;
  };
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      chunks.push(renderMarkdown(part.value.map(b => b.raw).join(''), newEnv));
      currentOffset += part.value.reduce((n, b) => n + b.raw.length, 0);
      oldOffset += part.value.reduce((n, b) => n + b.raw.length, 0);
      continue;
    }
    let olds: Block[] = [], news: Block[] = [];
    // Consume the whole edit run, regardless of library insertion/removal ordering.
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      if (parts[i].removed) olds.push(...parts[i].value); else news.push(...parts[i].value);
      i++;
    }
    i--;
    if (olds.length === news.length && olds.length > 0 && olds.every((b, j) => b.kind === news[j].kind)) {
      olds.forEach((b, j) => add(b.raw, news[j].raw));
    } else if (!olds.length) news.forEach(b => add('', b.raw));
    else if (!news.length) olds.forEach(b => add(b.raw, ''));
    else add(olds.map(b => b.raw).join(''), news.map(b => b.raw).join(''));
  }
  return { revision, html: chunks.join(''), hunks };
}

export function revertHunk(current: string, hunk: Hunk): string {
  if (current.slice(hunk.start, hunk.end) !== hunk.after) throw new Error('ファイルが更新されました。最新の差分でもう一度お試しください。');
  return current.slice(0, hunk.start) + hunk.before + current.slice(hunk.end);
}

/** Adopt only this displayed change into the confirmed baseline; never edit the document. */
export function confirmHunk(baseline: string, hunk: Hunk): string {
  if (baseline.slice(hunk.oldStart, hunk.oldEnd) !== hunk.before) throw new Error('比較元が更新されました。最新の差分でもう一度お試しください。');
  const next = baseline.slice(0, hunk.oldStart) + hunk.after + baseline.slice(hunk.oldEnd);
  validateSize(next);
  return next;
}
