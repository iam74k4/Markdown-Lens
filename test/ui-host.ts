import * as vscode from 'vscode';
import { access, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReviewPanel } from '../src/extension';

export async function run() {
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const uri = vscode.Uri.file(join(root, 'design.md'));
  const before = '# 認証設計書\n\nアカウント認証に関する仕様をまとめます。\n\n## 1. セッション\n\nセッションの有効期限は30分とする。\n期限を過ぎた場合は再認証を要求する。\n\n## 2. 用語\n\n本設計書ではユーザーと表記する。\n\n## 3. エラー\n\n| コード | 説明 |\n| --- | --- |\n| 401 | 認証が必要です |\n| 429 | リクエストが多すぎます |\n';
  const after = before.replace('30分', '24時間').replace('ユーザー', '利用者').replace('リクエストが多すぎます', 'リクエスト数の上限超過');
  await writeFile(uri.fsPath, before);
  await vscode.window.showTextDocument(uri);
  for (const command of ['workbench.action.closeSidebar', 'workbench.action.closeAuxiliaryBar', 'workbench.action.closePanel']) {
    try { await vscode.commands.executeCommand(command); } catch {}
  }
  const api = await vscode.extensions.getExtension('local-markdown-review.markdown-review')!.activate() as { open(uri: vscode.Uri): Promise<ReviewPanel> };
  const panel = await api.open(uri);
  await writeFile(uri.fsPath, after);
  const start = Date.now();
  while (panel.inspect()?.count !== 3) {
    if (Date.now() - start > 15000) throw new Error('UI preview failed to update');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await writeFile(join(root, 'ready'), 'ready');
  await vscode.commands.executeCommand('notifications.clearAll');
  let lastTheme = '';
  let visualFixture = false;
  let lastNotificationClear = 0;
  while (Date.now() - start < 240000) {
    if (Date.now() - lastNotificationClear > 1000) {
      await vscode.commands.executeCommand('notifications.clearAll');
      lastNotificationClear = Date.now();
    }
    try { await access(join(root, 'done')); return; } catch {}
    if (!visualFixture) {
      const requested = await readFile(join(root, 'visual-fixture'), 'utf8').catch(() => '');
      if (requested) {
        visualFixture = true;
        const visualUri = vscode.Uri.file(join(root, 'visual.md'));
        const fixture = '# リクエスト処理\n\n認証後、データを取得する。\n\n```mermaid\nflowchart LR\nA[認証] --> D[(DB)]\n```\n\n| 設定 | 値 |\n| --- | --- |\n| 保持期間 | 30秒 |\n| 再試行 | 3回 |\n\n![構成図](./local.svg)\n';
        await writeFile(join(root, 'local.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="280" height="64"><rect width="280" height="64" rx="8" fill="#c9f4a3"/><text x="20" y="39" font-size="18" fill="#173b12">Local image preview</text></svg>');
        await writeFile(visualUri.fsPath, fixture);
        await api.open(visualUri);
        await writeFile(visualUri.fsPath, fixture.replace('認証後、', '認証後、キャッシュを経由して').replace('A[認証] --> D[(DB)]', 'A[認証] --> C[キャッシュ]\nC --> D[(DB)]').replace('30秒', '60秒'));
        await writeFile(join(root, 'visual-ready'), 'ready');
      }
    }
    const theme = await readFile(join(root, 'theme'), 'utf8').catch(() => '');
    if (theme && theme !== lastTheme) {
      lastTheme = theme;
      await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('UI test timed out');
}
