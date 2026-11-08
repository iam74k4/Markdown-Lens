import * as vscode from 'vscode';
import { posix } from 'node:path';
import { documentLinks, headingAnchors, linkTarget } from './links';
import { documentText } from './document-source';
import { config, excludeGlob } from './config';
import { t } from './i18n';

const markdown = /\.(md|markdown|mdown)$/i;
function resolvePath(document: vscode.Uri, path: string): vscode.Uri {
  if (path.startsWith('/')) {
    const root = vscode.workspace.getWorkspaceFolder(document)?.uri ?? document.with({ path: posix.dirname(document.path) });
    return vscode.Uri.joinPath(root, path);
  }
  return document.with({ path: posix.normalize(posix.join(posix.dirname(document.path), path)) });
}
async function exists(uri: vscode.Uri): Promise<boolean> {
  try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; }
}
/** `[[Page]]` and `[[folder/Page#Heading]]`: beside the document first, then anywhere in the workspace. */
export async function resolveWiki(document: vscode.Uri, target: string): Promise<{ uri?: vscode.Uri; fragment?: string }> {
  const [page, fragment] = target.split('#');
  const name = page.trim();
  if (!name) return { uri: document, fragment };
  for (const candidate of [name, name + '.md', name + '.markdown']) {
    const uri = resolvePath(document, candidate);
    if (markdown.test(uri.path) && await exists(uri)) return { uri, fragment };
  }
  const escaped = name.replace(/[[\]{}*?!]/g, '\\$&');
  const found = await vscode.workspace.findFiles(`**/${escaped}.{md,markdown,mdown}`, excludeGlob(config(document).excludeFolders), 1);
  return { uri: found[0], fragment };
}

/** Relative links, images, anchors and wiki links whose targets are missing. External URLs are never fetched. */
export async function checkLinks(document: vscode.Uri, text: string): Promise<{ broken: Record<string, string>; diagnostics: vscode.Diagnostic[] }> {
  const broken: Record<string, string> = {}, diagnostics: vscode.Diagnostic[] = [];
  const anchors = new Map<string, Set<string> | null>(), stats = new Map<string, boolean>();
  const anchorsOf = async (uri: vscode.Uri) => {
    const key = uri.toString();
    if (!anchors.has(key)) anchors.set(key, key === document.toString() ? headingAnchors(text) : await documentText(uri).then(headingAnchors, () => null));
    return anchors.get(key);
  };
  const statOf = async (uri: vscode.Uri) => { const key = uri.toString(); if (!stats.has(key)) stats.set(key, await exists(uri)); return stats.get(key)!; };
  for (const link of documentLinks(text).slice(0, 500)) {
    let reason: string | undefined;
    if (link.kind === 'wiki') {
      const { uri, fragment } = await resolveWiki(document, link.href);
      if (!uri) reason = t('リンク先のページが見つかりません');
      else if (fragment && !(await anchorsOf(uri))?.has(fragment.trim().toLowerCase().replace(/\s+/g, '-'))) reason = t('リンク先の見出しが見つかりません');
    } else {
      const target = linkTarget(link.href);
      if (target.external || target.unsupported) continue;
      const uri = target.path ? resolvePath(document, target.path) : document;
      if (target.path && !await statOf(uri)) reason = link.kind === 'image' ? t('画像ファイルが見つかりません') : t('リンク先のファイルが見つかりません');
      else if (target.fragment && markdown.test(uri.path)) {
        const set = await anchorsOf(uri);
        if (set && !set.has(target.fragment) && !set.has(target.fragment.toLowerCase())) reason = t('リンク先の見出しが見つかりません');
      }
    }
    if (!reason) continue;
    broken[link.href] = reason;
    const range = new vscode.Range(link.line, link.column, link.line, link.column + link.length);
    const diagnostic = new vscode.Diagnostic(range, `${reason}: ${link.href}`, vscode.DiagnosticSeverity.Warning);
    diagnostic.source = 'Markdown Lens';
    diagnostics.push(diagnostic);
  }
  return { broken, diagnostics };
}

/** Open a link the user explicitly clicked: Markdown in Markdown Lens, other files in VS Code, web links after confirmation. */
export async function openLink(document: vscode.Uri, link: { href?: string; wiki?: string }, openMarkdown: (uri: vscode.Uri, fragment?: string) => Promise<void>): Promise<void> {
  if (link.wiki !== undefined) {
    const { uri, fragment } = await resolveWiki(document, link.wiki);
    if (!uri) { void vscode.window.showWarningMessage(t('リンク先のページが見つかりません: {0}', link.wiki)); return; }
    await openMarkdown(uri, fragment); return;
  }
  const target = linkTarget(link.href ?? '');
  if (target.unsupported) { void vscode.window.showWarningMessage(t('このリンクは開けません: {0}', link.href ?? '')); return; }
  if (target.external) {
    const open = t('開く');
    const choice = await vscode.window.showInformationMessage(t('外部のリンクを開きますか？'), { modal: true, detail: target.external }, open);
    if (choice === open) await vscode.env.openExternal(vscode.Uri.parse(target.external, true));
    return;
  }
  const uri = target.path ? resolvePath(document, target.path) : document;
  if (!await exists(uri)) { void vscode.window.showWarningMessage(t('リンク先のファイルが見つかりません: {0}', link.href ?? '')); return; }
  if (markdown.test(uri.path)) await openMarkdown(uri, target.fragment);
  else await vscode.commands.executeCommand('vscode.open', uri);
}
