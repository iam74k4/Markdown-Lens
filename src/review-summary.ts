import { diffLines } from 'diff';
import { planReview } from './core';
import { t } from './i18n';

/** Share of lines two versions have in common, for matching a moved file to its old baseline. */
export function similarity(a: string, b: string): number {
  const lines = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const left = lines(a), right = new Map<string, number>();
  for (const line of lines(b)) right.set(line, (right.get(line) ?? 0) + 1);
  if (!left.length && !right.size) return 1;
  let shared = 0;
  for (const line of left) { const n = right.get(line) ?? 0; if (n) { shared++; right.set(line, n - 1); } }
  return shared / Math.max(left.length, lines(b).length);
}

export interface SummaryInput { name: string; baselineLabel: string; before: string; after: string }
const lineOf = (text: string, offset: number) => text.slice(0, offset).split(/\r\n|\r|\n/).length;
/** The heading path that contains an offset, e.g. "Design › Session". */
function headingPath(text: string, offset: number): string {
  const path: { level: number; title: string }[] = [];
  let fence = false;
  for (const line of text.slice(0, offset).split(/\r?\n/)) {
    if (/^\s{0,3}(```|~~~)/.test(line)) fence = !fence;
    const match = !fence && /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const level = match[1].length;
    while (path.length && path[path.length - 1].level >= level) path.pop();
    path.push({ level, title: match[2] });
  }
  return path.map(p => p.title).join(' › ');
}
function fenced(before: string, after: string): string {
  // Separator blank lines at the end of blocks are noise in a summary.
  const trim = (text: string) => text.replace(/\s+$/, '') + (text.trim() ? '\n' : '');
  const body = diffLines(trim(before), trim(after)).flatMap(part => part.value.replace(/\r?\n$/, '').split(/\r?\n/)
    .map(line => (part.added ? '+ ' : part.removed ? '- ' : '  ') + line)).join('\n');
  const fence = /```/.test(body) ? '~~~~' : '```';
  return `${fence}diff\n${body}\n${fence}`;
}

/** A Markdown report of unreviewed changes, for pull requests or hand-offs. */
export function reviewSummary(files: SummaryInput[]): string {
  const sections: string[] = [`# ${t('Markdown Lens 変更の要約')}`, ''];
  let total = 0;
  for (const file of files) {
    const plan = planReview(file.before, file.after, { cells: false });
    total += plan.hunks.length;
    sections.push(`## ${file.name}`, '', `- ${t('比較元')}: ${file.baselineLabel}`, `- ${t('未確認の変更')}: ${t('{0}件', plan.hunks.length)}`, '');
    plan.hunks.forEach((hunk, index) => {
      const kind = hunk.eol ? t('改行コードの変更') : hunk.moveParts ? t('移動') : !hunk.after ? t('削除') : !hunk.before ? t('追加') : t('変更');
      const where = hunk.after ? lineOf(file.after, hunk.start) : lineOf(file.before, hunk.oldStart);
      const path = headingPath(file.after, hunk.start);
      sections.push(`### ${index + 1}. ${kind} · ${t('{0}行目', where)}${path ? ` · ${path}` : ''}`, '');
      if (hunk.moveParts) sections.push(fenced('', hunk.after));
      else if (!hunk.eol) sections.push(fenced(hunk.before, hunk.after));
      sections.push('');
    });
  }
  sections.splice(2, 0, `${t('{0}ファイル · 未確認 {1}件', files.length, total)}`, '');
  return sections.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export interface ChangeLines { kind: 'added' | 'changed' | 'removed'; start: number; end: number; offset: number }
/** Zero-based line ranges of unreviewed changes in the current text, ignoring trailing blank lines. */
export function changeLines(after: string, hunks: { start: number; end: number; before: string; after: string; moveParts?: unknown[]; eol?: string }[]): ChangeLines[] {
  const line = (offset: number) => after.slice(0, offset).split(/\r\n|\r|\n/).length - 1;
  return hunks.map(hunk => {
    if (hunk.eol) return { kind: 'changed' as const, start: 0, end: Math.max(0, line(after.length)), offset: 0 };
    const visible = hunk.after.replace(/\s+$/, '');
    if (!visible) return { kind: 'removed' as const, start: line(Math.min(hunk.start, after.length)), end: line(Math.min(hunk.start, after.length)), offset: hunk.start };
    const lead = hunk.after.length - hunk.after.trimStart().length;
    return { kind: hunk.before && !hunk.moveParts ? 'changed' as const : 'added' as const, start: line(hunk.start + lead), end: line(hunk.start + visible.length), offset: hunk.start + lead };
  });
}
