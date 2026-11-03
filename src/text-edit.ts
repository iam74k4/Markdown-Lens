/** One minimal source replacement, avoiding surrogate-pair and CRLF boundaries. */
export function minimalEdit(before: string, after: string): { start: number; end: number; text: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  const unsafe = (s: string, p: number) => p > 0 && p < s.length && (/^[\uDC00-\uDFFF]$/.test(s[p]) || s[p - 1] === '\r' && s[p] === '\n');
  if (unsafe(before, start) || unsafe(after, start)) start--;
  let end = before.length, nextEnd = after.length;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
  if (unsafe(before, end) || unsafe(after, nextEnd)) { end++; nextEnd++; }
  return { start, end, text: after.slice(start, nextEnd) };
}
