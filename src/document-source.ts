import * as vscode from 'vscode';
import { decode, encodingExists } from 'iconv-lite';
import { validateSize } from './core';
import { limits } from './limits';
import { t } from './i18n';

/** A clean, hidden TextDocument can lag behind disk (notably with watcherExclude).
 * Keep unsaved editor text authoritative, but read saved files from their provider. */
export async function documentText(uri: vscode.Uri, document?: vscode.TextDocument): Promise<string> {
  const live = () => document && !document.isClosed ? document : vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  const current = live();
  if (current?.isDirty) { const text = current.getText(); validateSize(text); return text; }
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.size > limits.maxBytes) throw new Error(t('このファイルは{0}を超えています。小さなMarkdownファイルに分割して開いてください。', limits.label));
  const bytes = await vscode.workspace.fs.readFile(uri);
  // An editor edit may have arrived during the filesystem read. Never replace it.
  const updated = live();
  if (updated?.isDirty) { const text = updated.getText(); validateSize(text); return text; }
  const configured = (updated as (vscode.TextDocument & { encoding?: string }) | undefined)?.encoding
    ?? vscode.workspace.getConfiguration('files', uri).get<string>('encoding', 'utf8');
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf16be'
    : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 'utf8'
    : configured === 'utf8bom' ? 'utf8' : configured;
  if (!encodingExists(encoding)) throw new Error(t('文字コード {0} を読み込めません。ファイルの文字コード設定を確認してください。', configured));
  const text = decode(Buffer.from(bytes), encoding);
  validateSize(text);
  return text;
}
