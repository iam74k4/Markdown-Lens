import type MarkdownIt from 'markdown-it';
import type { StateBlock, StateInline, StateCore } from 'markdown-it';
import Token from 'markdown-it/lib/token.mjs';

/**
 * Syntax that CommonMark does not define but that real documents use: front matter,
 * GitHub alerts, footnotes, math, wiki links, HTML, entities and meaningful escapes.
 * Each construct becomes a token that carries its exact source, so the editor can
 * keep it verbatim instead of escaping or reflowing it.
 */
export type RawKind = 'html' | 'comment' | 'footnote' | 'footnoteDef' | 'wiki' | 'math' | 'alert' | 'entity' | 'escape';
export const ALERT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export type AlertKind = typeof ALERT_KINDS[number];
export interface RawMeta { kind: RawKind; text?: string; math?: string; display?: boolean; target?: string; label?: string; alert?: AlertKind }

// Escapes whose meaning the Markdown serializer would not restore by itself.
const KEEP_ESCAPES = new Set('$&)+-#=.>'.split(''));

function line(state: StateBlock, n: number): string {
  return state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
}

function frontMatter(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (startLine !== 0 || state.parentType !== 'root' || state.sCount[startLine] !== 0 || state.bMarks[0] !== 0) return false;
  const open = line(state, startLine).trimEnd();
  if (open !== '---' && open !== '+++') return false;
  const closers = open === '---' ? ['---', '...'] : ['+++'];
  let next = startLine + 1;
  for (; next < endLine; next++) if (state.sCount[next] === 0 && closers.includes(line(state, next).trimEnd())) break;
  if (next >= endLine) return false;
  const body = state.getLines(startLine + 1, next, 0, true);
  // Require recognisable metadata so a leading horizontal rule keeps its meaning.
  const first = body.split(/\r?\n/).find(l => l.trim());
  if (first !== undefined && !(open === '---' ? /^(#|[\w"'][^:]*:(\s|$)|-\s)/ : /^(#|[\w"'.-]+\s*=|\[)/).test(first)) return false;
  if (silent) return true;
  const token = state.push('front_matter', '', 0);
  token.block = true; token.markup = open; token.info = line(state, next).trimEnd();
  token.content = body.replace(/\r?\n$/, ''); token.map = [startLine, next + 1];
  state.line = next + 1;
  return true;
}

function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const first = line(state, startLine);
  if (!first.startsWith('$$')) return false;
  const rest = first.slice(2).trimEnd();
  let next = startLine, content: string, single = false;
  if (rest.endsWith('$$') && rest.length >= 2) {
    content = rest.slice(0, -2); single = true;
    if (content.includes('$$')) return false;
  } else {
    const lines = rest.trim() ? [rest] : [];
    for (next = startLine + 1; next < endLine; next++) {
      if (state.isEmpty(next) || state.sCount[next] < state.blkIndent) return false;
      const text = line(state, next).trimEnd();
      if (text.endsWith('$$')) { const body = text.slice(0, -2); if (body.trim()) lines.push(body); break; }
      lines.push(text);
    }
    if (next >= endLine) return false;
    content = lines.join('\n');
  }
  if (silent) return true;
  const token = state.push('math_block', 'div', 0);
  token.block = true; token.markup = '$$'; token.content = content; token.map = [startLine, next + 1];
  token.meta = { single };
  state.line = next + 1;
  return true;
}

function push(state: StateInline, source: string, meta: RawMeta): void {
  const token = state.push('md_raw', '', 0);
  token.content = source; token.meta = meta;
}

function bracketSyntax(state: StateInline, silent: boolean): boolean {
  const src = state.src, pos = state.pos;
  if (src.charCodeAt(pos) !== 0x5B) return false;
  if (src[pos + 1] === '[') {
    const end = src.indexOf(']]', pos + 2);
    if (end < 0 || end > state.posMax - 2) return false;
    const inner = src.slice(pos + 2, end);
    if (!inner.trim() || /[[\]\n]/.test(inner) || src[end + 2] === '(') return false;
    if (!silent) {
      const [target, label] = inner.split('|');
      push(state, src.slice(pos, end + 2), { kind: 'wiki', target: target.trim(), label: (label ?? target).trim() });
    }
    state.pos = end + 2; return true;
  }
  if (src[pos + 1] !== '^') return false;
  const match = /^\[\^([^\]\s]+)\](:?)/.exec(src.slice(pos, state.posMax));
  if (!match || src[pos + match[0].length] === '(' || (!match[2] && src[pos + match[0].length] === '[')) return false;
  const definition = match[2] === ':' && pos === 0;
  const source = definition ? match[0] : match[0].replace(/:$/, '');
  if (!silent) push(state, source, { kind: definition ? 'footnoteDef' : 'footnote', label: match[1] });
  state.pos = pos + source.length; return true;
}

function inlineMath(state: StateInline, silent: boolean): boolean {
  const src = state.src, pos = state.pos, max = state.posMax;
  if (src.charCodeAt(pos) !== 0x24) return false;
  if (src[pos + 1] === '$') {
    const end = src.indexOf('$$', pos + 2);
    if (end < 0 || end + 2 > max || !src.slice(pos + 2, end).trim()) return false;
    if (!silent) push(state, src.slice(pos, end + 2), { kind: 'math', math: src.slice(pos + 2, end), display: true });
    state.pos = end + 2; return true;
  }
  if (!src[pos + 1] || /\s/.test(src[pos + 1])) return false;
  let end = pos + 1;
  for (;;) {
    end = src.indexOf('$', end);
    if (end < 0 || end >= max) return false;
    // A closing dollar follows a non-space and is not the start of an amount.
    if (src[end - 1] !== '\\' && !/\s/.test(src[end - 1]) && !/\d/.test(src[end + 1] ?? '')) break;
    end++;
  }
  const math = src.slice(pos + 1, end);
  if (math.includes('\n\n')) return false;
  if (!silent) push(state, src.slice(pos, end + 1), { kind: 'math', math, display: false });
  state.pos = end + 1; return true;
}

function rawTokens(state: StateCore): void {
  const blocks = state.tokens;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === 'blockquote_open' && blocks[i + 1]?.type === 'paragraph_open' && blocks[i + 2]?.type === 'inline') {
      const inline = blocks[i + 2], first = inline.children?.[0], next = inline.children?.[1];
      const match = first?.type === 'text' ? /^\[!(note|tip|important|warning|caution)\][ \t]*$/i.exec(first.content) : null;
      if (match && (!next || next.type === 'softbreak' || next.type === 'hardbreak')) {
        const alert = match[1].toLowerCase() as AlertKind;
        const raw = new Token('md_raw', '', 0);
        raw.content = first!.content; raw.meta = { kind: 'alert', alert } satisfies RawMeta;
        inline.children![0] = raw;
        block.meta = { ...block.meta, alert };
      }
    }
    if (block.type !== 'inline' || !block.children) continue;
    block.children = block.children.map(child => {
      if (child.type === 'html_inline') {
        const raw = new Token('md_raw', '', 0);
        raw.content = child.content; raw.meta = { kind: /^<!--/.test(child.content) ? 'comment' : 'html' } satisfies RawMeta;
        return raw;
      }
      if (child.type !== 'text_special') return child;
      const kind = child.info === 'entity' ? 'entity' : child.info === 'escape' && KEEP_ESCAPES.has(child.content) ? 'escape' : undefined;
      if (!kind) return child;
      const raw = new Token('md_raw', '', 0);
      raw.content = child.markup; raw.meta = { kind, text: child.content } satisfies RawMeta;
      return raw;
    });
    breakStyles(block);
  }
}

/** Record whether each line break was written as a backslash, trailing spaces or `<br>`. */
function breakStyles(inline: Token): void {
  const breaks = inline.children!.filter(t => (t.type === 'hardbreak' && !t.markup) || t.type === 'softbreak');
  if (!breaks.length) return;
  const endings = [...inline.content.matchAll(/(\\|[ ]{2,}|\t)?\r?\n([ \t]*)/g)].map(m => ({ style: m[1] === '\\' ? '\\' : m[1] ? '  ' : '', indent: m[2] }));
  if (endings.length !== breaks.length) return;
  breaks.forEach((token, i) => {
    if (token.type === 'hardbreak') token.markup = endings[i].style || '\\';
    // Continuation-line indentation is insignificant to Markdown but part of the author's layout.
    if (endings[i].indent) token.meta = { ...token.meta, indent: endings[i].indent };
  });
}

/** Keep the source spelling of setext underlines and thematic breaks. */
function sourceMarkup(state: StateCore): void {
  const lines = state.src.split(/\r\n|\r|\n/);
  for (const token of state.tokens) {
    if (!token.map) continue;
    if (token.type === 'heading_open' && (token.markup === '=' || token.markup === '-')) {
      const underline = /[=-]+[ \t]*$/.exec(lines[token.map[1] - 1] ?? '')?.[0].trimEnd();
      if (underline) token.meta = { ...token.meta, underline };
    } else if (token.type === 'hr') {
      const rule = /[-*_](?:[ \t]*[-*_]){2,}[ \t]*$/.exec(lines[token.map[0]] ?? '')?.[0].trimEnd();
      if (rule) token.meta = { ...token.meta, rule };
    }
  }
}

export function markdownSyntax(md: MarkdownIt): void {
  md.block.ruler.before('table', 'front_matter', frontMatter);
  md.block.ruler.before('fence', 'math_block', mathBlock, { alt: [] });
  md.inline.ruler.before('link', 'bracket_syntax', bracketSyntax);
  md.inline.ruler.before('escape', 'inline_math', inlineMath);
  md.core.ruler.after('block', 'source_markup', sourceMarkup);
  md.core.ruler.after('inline', 'raw_tokens', rawTokens);
}

export function frontMatterRows(source: string): { key: string; value: string }[] | undefined {
  const rows: { key: string; value: string }[] = [];
  for (const text of source.split(/\r?\n/)) {
    const match = /^([^\s#:=][^:=]*?)\s*[:=]\s?(.*)$/.exec(text);
    if (match && !/^\s/.test(text)) rows.push({ key: match[1].replace(/^["']|["']$/g, ''), value: match[2] });
    else if (rows.length && text.trim()) rows[rows.length - 1].value += (rows[rows.length - 1].value ? '\n' : '') + text.trim();
    else if (text.trim() && !text.trim().startsWith('#')) return;
  }
  return rows.length ? rows : undefined;
}

/** GitHub-compatible heading anchors, keeping letters from every script. */
export function headingSlug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '').replace(/ /g, '-');
}
