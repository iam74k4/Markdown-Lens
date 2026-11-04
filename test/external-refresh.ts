import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encode } from 'iconv-lite';
import type { ReviewPanel } from '../src/extension';
import type { PendingFiles } from '../src/pending-files';

export async function externalRefreshChecks(api: { open(uri: vscode.Uri): Promise<ReviewPanel>; pendingFiles: PendingFiles }, root: string): Promise<string[]> {
  const config = vscode.workspace.getConfiguration('files');
  const previous = config.inspect<Record<string, boolean>>('watcherExclude')?.workspaceValue;
  await config.update('watcherExclude', { ...previous, '**/external-refresh/**': true }, vscode.ConfigurationTarget.Workspace);
  const folder = join(root, 'external-refresh');
  await mkdir(folder, { recursive: true });
  const panels: ReviewPanel[] = [];
  const open = async (uri: vscode.Uri) => { const panel = await api.open(uri); panels.push(panel); return panel; };
  const until = async (test: () => boolean, label: string) => {
    const deadline = Date.now() + 10000;
    while (!test()) { assert.ok(Date.now() < deadline, label); await new Promise(resolve => setTimeout(resolve, 80)); }
  };
  try {
    const uri = vscode.Uri.file(join(folder, 'preview-only.md'));
    const before = '# External edit\n\nOld first.\n\nOld second.\n';
    const after = before.replace('Old first.', 'A much longer first paragraph from the AI.').replace('Old second.', 'New second.');
    await writeFile(uri.fsPath, before);
    const panel = await open(uri);
    await api.pendingFiles.refresh();
    await writeFile(uri.fsPath, after);
    await until(() => panel.inspect()?.markdown === after, 'preview-only file must update despite an excluded/stale text model');
    assert.equal(vscode.window.visibleTextEditors.some(e => e.document.uri.toString() === uri.toString()), false);
    assert.equal(panel.inspect()!.count, 2);
    await api.pendingFiles.refresh();
    assert.equal(api.pendingFiles.getChildren().find(e => e.uri.toString() === uri.toString())?.count, 2);
    const first = panel.inspect()!;
    await panel.receive({ type: 'reviewHunk', revision: first.revision, id: first.hunks[0].id });
    const second = panel.inspect()!;
    assert.equal(second.count, 1);
    await panel.receive({ type: 'revert', revision: second.revision, id: second.hunks[0].id });
    const reverted = after.replace('New second.', 'Old second.');
    assert.equal(panel.inspect()!.markdown, reverted, 'revert uses buffer coordinates while retaining the other external edit');
    assert.equal(panel.inspect()!.dirty, true);
    assert.equal(await readFile(uri.fsPath, 'utf8'), after);
    await panel.receive({ type: 'save', revision: panel.inspect()!.revision });
    assert.equal(panel.inspect()!.dirty, false);
    assert.equal(await readFile(uri.fsPath, 'utf8'), reverted);

    const next = reverted + '\nAtomic replacement.\n';
    await writeFile(uri.fsPath + '.tmp', next); await rename(uri.fsPath + '.tmp', uri.fsPath);
    await until(() => panel.inspect()?.markdown === next, 'atomic replacement updates without opening Markdown');
    const stale = panel.inspect()!;
    const concurrent = next + '\nConcurrent AI edit.\n';
    await writeFile(uri.fsPath, concurrent);
    await panel.receive({ type: 'edit', id: 'stale-draft', revision: stale.revision, text: next + 'overwrite', save: false });
    assert.equal(panel.inspect()!.editResult?.accepted, false);
    assert.equal(await readFile(uri.fsPath, 'utf8'), concurrent);
    await until(() => panel.inspect()?.markdown === concurrent, 'concurrent disk change replaces the stale preview');
    await panel.receive({ type: 'draft', text: concurrent + 'my draft', baseText: concurrent });
    const newer = concurrent + '\nAnother AI edit.\n';
    await writeFile(uri.fsPath, newer);
    await until(() => panel.inspect()?.markdown === newer, 'external edit arrives while a rich draft exists');
    assert.equal(panel.inspect()!.draft?.text, concurrent + 'my draft');
    await panel.receive({ type: 'edit', id: 'new-draft', revision: panel.inspect()!.revision, text: newer + 'saved edit\n', save: true });
    assert.equal(panel.inspect()!.editResult?.accepted, true);
    assert.equal(await readFile(uri.fsPath, 'utf8'), newer + 'saved edit\n');
    assert.equal(vscode.window.visibleTextEditors.some(e => e.document.uri.toString() === uri.toString()), false);
    assert.equal(vscode.window.tabGroups.all.flatMap(g => g.tabs).some(t => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString()), false, 'temporary synchronization tab is closed');

    // A native unsaved buffer must win over a competing filesystem write.
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit(); edit.insert(uri, new vscode.Position(0, 0), 'Unsaved native edit.\n\n');
    assert.ok(await vscode.workspace.applyEdit(edit));
    const unsaved = doc.getText();
    await writeFile(uri.fsPath, 'External replacement while dirty.\n');
    await panel.receive({ type: 'ready' });
    assert.equal(panel.inspect()!.markdown, unsaved);
    assert.equal(doc.isDirty, true);

    const encoded = vscode.Uri.file(join(folder, 'bom.md'));
    await writeFile(encoded.fsPath, encode('# 日本語\n\n変更前\n', 'utf16le', { addBOM: true }));
    const encodingPanel = await open(encoded);
    await writeFile(encoded.fsPath, encode('# 日本語\n\n変更後\n', 'utf16le', { addBOM: true }));
    await until(() => encodingPanel.inspect()?.markdown === '# 日本語\n\n変更後\n', 'BOM-encoded external edit is decoded correctly');
    return [
      'preview-only external writes and atomic replacements update with watcherExclude, without showing the Markdown editor',
      'stale hidden buffers support confirmation, selective revert, save and WYSIWYG save without losing other AI edits',
      'fresh disk checks reject stale actions and retain rich drafts and native unsaved buffers',
      'pending file counts use disk for clean buffers; external UTF-16 BOM edits preserve Japanese text',
    ];
  } finally {
    panels.forEach(panel => panel.panel.dispose());
    await config.update('watcherExclude', previous, vscode.ConfigurationTarget.Workspace);
  }
}
