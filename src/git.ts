import * as vscode from 'vscode';
import { t } from './i18n';

/** The subset of VS Code's built-in Git extension API that Markdown Lens reads. */
interface Ref { type: number; name?: string; commit?: string; remote?: string }
interface Commit { hash: string; message: string; authorDate?: Date }
interface Repository {
  rootUri: vscode.Uri;
  state: { HEAD?: Ref; refs?: Ref[] };
  show(ref: string, path: string): Promise<string>;
  getRefs?(query?: { pattern?: string; count?: number; sort?: 'alphabetically' | 'committerdate' }): Promise<Ref[]>;
  log?(options?: { maxEntries?: number; path?: string }): Promise<Commit[]>;
}
interface GitAPI { state: 'uninitialized' | 'initialized'; onDidChangeState(listener: (state: string) => void): vscode.Disposable; getRepository(uri: vscode.Uri): Repository | null; openRepository?(root: vscode.Uri): Promise<Repository | null> }

let api: Promise<GitAPI | undefined> | undefined;
async function git(): Promise<GitAPI | undefined> {
  api ??= (async () => {
    const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitAPI }>('vscode.git');
    if (!extension) return;
    const exports = extension.isActive ? extension.exports : await extension.activate().then(e => e, () => undefined);
    const gitApi = exports?.getAPI(1);
    if (gitApi && gitApi.state !== 'initialized') {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { listener.dispose(); resolve(); }, 5000);
        const listener = gitApi.onDidChangeState(state => { if (state === 'initialized') { clearTimeout(timer); listener.dispose(); resolve(); } });
      });
    }
    return gitApi;
  })();
  return api;
}
async function repository(uri: vscode.Uri): Promise<Repository | undefined> {
  if (uri.scheme !== 'file') return;
  const gitApi = await git();
  if (!gitApi) return;
  const known = gitApi.getRepository(uri);
  if (known || !gitApi.openRepository) return known ?? undefined;
  // A repository created or cloned after VS Code scanned the workspace is opened on demand,
  // but only inside a workspace folder: parent repositories stay the user's choice.
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return;
  for (let dir = vscode.Uri.joinPath(uri, '..'); dir.path.length >= folder.uri.path.length; dir = vscode.Uri.joinPath(dir, '..')) {
    try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, '.git')); return await gitApi.openRepository(dir) ?? undefined; }
    catch { /* keep looking upwards */ }
    if (dir.path === folder.uri.path) break;
  }
  return;
}

/** File content at a Git revision: a string, `null` when the file is not in that revision, `undefined` without Git. */
export async function gitText(uri: vscode.Uri, ref = 'HEAD'): Promise<string | null | undefined> {
  const repo = await repository(uri);
  if (!repo) return;
  try { return await repo.show(ref, uri.fsPath); }
  catch { return null; }
}

export interface GitChoice { ref: string; label: string }
/** HEAD, local branches and the file's recent commits. */
export async function chooseGitRevision(uri: vscode.Uri): Promise<GitChoice | undefined> {
  const repo = await repository(uri);
  if (!repo) { void vscode.window.showWarningMessage(t('このファイルはGitリポジトリにありません。Git拡張機能が有効か確認してください。')); return; }
  const refs = (await repo.getRefs?.({ sort: 'committerdate', count: 50 }).catch(() => undefined)) ?? repo.state.refs ?? [];
  const commits = (await repo.log?.({ maxEntries: 20, path: uri.fsPath }).catch(() => [])) ?? [];
  const items: (vscode.QuickPickItem & { ref?: string })[] = [
    { label: '$(git-commit) HEAD', description: t('最後のコミット'), ref: 'HEAD' },
    { label: t('ブランチ'), kind: vscode.QuickPickItemKind.Separator },
    ...refs.filter(r => r.name && r.type !== 2).slice(0, 30).map(r => ({ label: `$(git-branch) ${r.name}`, description: r.commit?.slice(0, 8), ref: r.name! })),
    { label: t('このファイルのコミット'), kind: vscode.QuickPickItemKind.Separator },
    ...commits.map(c => ({ label: `$(history) ${c.hash.slice(0, 8)}`, description: c.message.split('\n')[0], detail: c.authorDate?.toLocaleString(), ref: c.hash })),
  ];
  const picked = await vscode.window.showQuickPick(items, { title: t('Gitの比較元を選択'), placeHolder: t('ブランチまたはコミットを選択') });
  if (!picked?.ref) return;
  return { ref: picked.ref, label: picked.ref.length === 40 ? picked.ref.slice(0, 8) : picked.ref };
}
