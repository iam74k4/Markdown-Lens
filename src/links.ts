import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { markdownSyntax, headingSlug, type RawMeta } from './markdown-syntax';

/** Link targets and heading anchors of a document. Shared by validation and navigation. */
const md = new MarkdownIt({ html: true, linkify: false }).use(markdownSyntax);
export interface DocumentLink { href: string; kind: 'link' | 'image' | 'wiki'; line: number; column: number; length: number }

export function documentLinks(source: string): DocumentLink[] {
  const lines = source.split(/\r\n|\r|\n/);
  const links: DocumentLink[] = [];
  const locate = (href: string, map: [number, number] | null | undefined, kind: DocumentLink['kind'], literal = href) => {
    const [from, to] = map ?? [0, lines.length];
    for (let line = from; line < to; line++) {
      const column = lines[line]?.indexOf(literal) ?? -1;
      if (column >= 0) { links.push({ href, kind, line, column, length: literal.length }); return; }
    }
    links.push({ href, kind, line: from, column: 0, length: 0 });
  };
  const walk = (tokens: Token[], map: [number, number] | null) => {
    for (const token of tokens) {
      const here = (token.map as [number, number] | null) ?? map;
      if (token.type === 'link_open' && token.markup !== 'autolink') { const href = token.attrGet('href'); if (href) locate(href, here, 'link', rawHref(href, lines, here)); }
      else if (token.type === 'image') { const src = token.attrGet('src'); if (src) locate(src, here, 'image', rawHref(src, lines, here)); }
      else if (token.type === 'md_raw' && (token.meta as RawMeta).kind === 'wiki') locate((token.meta as RawMeta).target ?? '', here, 'wiki', token.content);
      if (token.children) walk(token.children, here);
    }
  };
  walk(md.parse(source, {}), null);
  return links;
}
/** markdown-it normalizes destinations (percent-encoding); find the spelling used in the source. */
function rawHref(href: string, lines: string[], map: [number, number] | null): string {
  let decoded = href; try { decoded = decodeURI(href); } catch { /* keep encoded */ }
  const text = lines.slice(map?.[0] ?? 0, map?.[1] ?? lines.length).join('\n');
  return [href, decoded].find(candidate => text.includes(candidate)) ?? href;
}

/** GitHub anchors, numbering repeated headings as -1, -2. */
export function headingAnchors(source: string): Set<string> {
  const anchors = new Set<string>(), counts = new Map<string, number>();
  const tokens = md.parse(source, {});
  tokens.forEach((token, i) => {
    if (token.type !== 'heading_open') return;
    const text = (tokens[i + 1]?.children ?? []).filter(c => c.type === 'text' || c.type === 'code_inline').map(c => c.content).join('');
    const slug = headingSlug(text), count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    anchors.add(count ? `${slug}-${count}` : slug);
  });
  // Explicit HTML anchors such as <a id="x"> or <a name="x">.
  for (const match of source.matchAll(/<a\s+(?:id|name)=["']([^"']+)["']/gi)) anchors.add(match[1]);
  return anchors;
}

export interface LinkTarget { path?: string; fragment?: string; external?: string; unsupported?: boolean }
/** Classify a link destination without resolving it against any filesystem. */
export function linkTarget(href: string): LinkTarget {
  const trimmed = href.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return { external: trimmed };
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) return { unsupported: true };
  const hash = trimmed.indexOf('#');
  const rawPath = hash >= 0 ? trimmed.slice(0, hash) : trimmed, fragment = hash >= 0 ? trimmed.slice(hash + 1) : undefined;
  let path = rawPath.replace(/\?.*$/, '');
  try { path = decodeURIComponent(path); } catch { /* keep as written */ }
  let decodedFragment = fragment;
  try { if (fragment !== undefined) decodedFragment = decodeURIComponent(fragment); } catch { /* keep as written */ }
  return { path: path || undefined, fragment: decodedFragment };
}
