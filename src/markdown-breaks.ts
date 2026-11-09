import type MarkdownIt from 'markdown-it';

/** Allow only an attribute-free line break; arbitrary HTML remains inert. */
export function markdownBreaks(md: MarkdownIt): void {
  md.inline.ruler.before('html_inline', 'safe_break', (state, silent) => {
    const match = /^<br\s*\/?\s*>/i.exec(state.src.slice(state.pos, state.posMax));
    if (!match) return false;
    if (!silent) state.push('hardbreak', 'br', 0).markup = match[0];
    state.pos += match[0].length;
    return true;
  });
}
