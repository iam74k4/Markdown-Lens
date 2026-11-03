import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PendingFiles } from '../src/pending-files';
import type { ReviewPanel } from '../src/extension';

async function until(predicate: () => boolean, label: string, timeout = 10000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error(`Timeout: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 80));
  }
}

export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const evidence: string[] = [];
  const ext = vscode.extensions.getExtension('local-markdown-review.markdown-review');
  assert.ok(ext, 'extension is discovered by host');
  const api = await ext.activate() as { open(uri: vscode.Uri): Promise<ReviewPanel>; pendingFiles: PendingFiles };
  const uri = vscode.Uri.file(join(root, '設計書.md'));
  const before = '# 認証設計書\n\n## セッション\n\n期限は30分です。\n\n## 用語\n\nユーザーと表記する。\n';
  const after = before.replace('30分', '24時間').replace('ユーザー', '利用者');
  await writeFile(uri.fsPath, before);
  const editor = await vscode.window.showTextDocument(uri);
  let panel = await api.open(uri);
  assert.equal(panel.inspect()?.count, 0);
  evidence.push('first open captures baseline');

  // Same path as an external CLI/AI tool writing a local Markdown file.
  await writeFile(uri.fsPath, after);
  await until(() => panel.inspect()?.count === 2, 'external edits update preview');
  assert.match(panel.inspect()!.html, /<del>30分<\/del><ins>24時間<\/ins>/);
  evidence.push('external filesystem edits automatically update rendered diff');

  const state = panel.inspect()!;
  const id = /data-hunk="([^"]+)"/.exec(state.html)![1];
  await panel.receive({ type: 'revert', revision: state.revision, id });
  await until(() => panel.inspect()?.count === 1, 'partial revert');
  assert.equal(editor.document.getText(), after.replace('24時間', '30分'));
  assert.equal(editor.document.isDirty, true);
  assert.equal(await readFile(uri.fsPath, 'utf8'), after, 'revert does not silently save');
  evidence.push('revert changes only the selected block and preserves unsaved edit semantics');

  const skipped: string[] = [];
  if (process.env.MARKDOWN_REVIEW_SKIP_FOCUS_TESTS === '1') {
    skipped.push('native editor Undo: interactive desktop unavailable');
    const restore = new vscode.WorkspaceEdit();
    restore.replace(uri, new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length)), after);
    assert.equal(await vscode.workspace.applyEdit(restore), true);
    await until(() => panel.inspect()?.count === 2, 'reset fixture after partial revert');
  } else {
    // Remove Webview's competing Undo handler before testing the native document.
    panel.panel.dispose();
    await vscode.window.showTextDocument(editor.document, { preview: false, preserveFocus: false });
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await until(() => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(), 'text editor focus before Undo');
    await vscode.commands.executeCommand('undo');
    await until(() => editor.document.getText() === after, 'native Undo restores reverted edit');
    panel = await api.open(uri);
    assert.equal(panel.inspect()?.count, 2);
    assert.equal(editor.document.getText(), after);
    evidence.push('native editor Undo restores reverted content');
  }

  const stale = panel.inspect()!;
  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, new vscode.Position(0, 0), '新しい追記\n\n');
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  await panel.receive({ type: 'revert', revision: stale.revision, id });
  assert.equal(editor.document.getText(), '新しい追記\n\n' + after);
  assert.match(panel.inspect()?.notice ?? '', /更新/);
  evidence.push('stale UI action is rejected after a concurrent document edit');

  await panel.receive({ type: 'save', revision: panel.inspect()!.revision });
  assert.equal(editor.document.isDirty, false);
  assert.equal(await readFile(uri.fsPath, 'utf8'), editor.document.getText());
  evidence.push('explicit save writes the edited document');

  await panel.receive({ type: 'reviewed', revision: panel.inspect()!.revision });
  assert.equal(panel.inspect()?.count, 0);
  const reviewedText = editor.document.getText();
  panel.panel.dispose();
  panel = await api.open(uri);
  assert.equal(panel.inspect()?.count, 0);
  await writeFile(uri.fsPath, reviewedText.replace('24時間', '48時間'));
  await until(() => panel.inspect()?.count === 1, 'reopened baseline tracks only next edits');
  assert.match(panel.inspect()!.html, /<del>24<\/del><ins>48<\/ins>/);
  evidence.push('reviewed baseline persists across closing and reopening preview');

  await unlink(uri.fsPath);
  await until(() => !!panel.inspect()?.error, 'deletion is surfaced');
  assert.match(panel.inspect()!.error!, /見つかりません/);
  evidence.push('deleted files disable stale review actions');
  panel.panel.dispose();

  const second = vscode.Uri.file(join(root, '別の設計書.md'));
  await writeFile(second.fsPath, '# 別のファイル\n');
  const independent = await api.open(second);
  assert.equal(independent.inspect()?.count, 0);
  independent.panel.dispose();
  evidence.push('baselines remain isolated per file');

  const eolUri = vscode.Uri.file(join(root, '改行.md'));
  await writeFile(eolUri.fsPath, '# 改行\n\n本文\n');
  const eolEditor = await vscode.window.showTextDocument(eolUri);
  const eolPanel = await api.open(eolUri);
  const eolEdit = new vscode.WorkspaceEdit();
  eolEdit.set(eolUri, [vscode.TextEdit.setEndOfLine(vscode.EndOfLine.CRLF)]);
  await vscode.workspace.applyEdit(eolEdit);
  await until(() => eolPanel.inspect()?.count === 1, 'line ending change');
  assert.match(eolPanel.inspect()!.html, /LF → CRLF/);
  const eolState = eolPanel.inspect()!;
  await eolPanel.receive({ type: 'revert', revision: eolState.revision, id: /data-hunk="([^"]+)"/.exec(eolState.html)![1] });
  assert.equal(eolEditor.document.eol, vscode.EndOfLine.LF);
  assert.equal(eolEditor.document.getText(), '# 改行\n\n本文\n');
  assert.equal(eolPanel.inspect()?.count, 0);
  eolPanel.panel.dispose();
  evidence.push('line ending conversion is restored as a single whole-file edit');

  const partialUri = vscode.Uri.file(join(root, '個別確認.md'));
  const partialBefore = '# 個別確認\n\n期限は30分です。\n\n名称は旧称です。\n\n上限は3回です。\n';
  const partialAfter = partialBefore.replace('30分', '24時間').replace('旧称', '新称').replace('3回', '5回');
  await writeFile(partialUri.fsPath, partialBefore);
  let partial = await api.open(partialUri);
  const partialDoc = await vscode.workspace.openTextDocument(partialUri);
  const partialEdit = new vscode.WorkspaceEdit();
  partialEdit.replace(partialUri, new vscode.Range(partialDoc.positionAt(0), partialDoc.positionAt(partialBefore.length)), partialAfter);
  assert.ok(await vscode.workspace.applyEdit(partialEdit));
  await until(() => partial.inspect()?.count === 3, 'three individual changes');
  const partialState = partial.inspect()!;
  const partialId = /data-review="([^"]+)"/.exec(partialState.html)![1];
  await partial.receive({ type: 'reviewHunk', revision: partialState.revision, id: partialId });
  assert.equal(partial.inspect()?.count, 2);
  assert.equal(partialDoc.getText(), partialAfter);
  assert.equal(partialDoc.isDirty, true);
  assert.equal(await readFile(partialUri.fsPath, 'utf8'), partialBefore);
  evidence.push('individual confirmation updates only the baseline, preserving the document and unsaved state');

  // A duplicate click from the old screen must not confirm the next change.
  await partial.receive({ type: 'reviewHunk', revision: partialState.revision, id: partialId });
  assert.equal(partial.inspect()?.count, 2);
  assert.match(partial.inspect()?.notice ?? '', /更新/);
  await partial.receive({ type: 'reviewHunk', revision: partial.inspect()!.revision, id: 'unknown' });
  assert.equal(partial.inspect()?.count, 2);
  evidence.push('stale or unknown individual confirmation cannot approve other changes');

  const undoId = partial.inspect()!.undoId;
  await partial.receive({ type: 'undoReview', id: 'stale-token' });
  assert.equal(partial.inspect()?.count, 2);
  await partial.receive({ type: 'undoReview', id: undoId });
  assert.equal(partial.inspect()?.count, 3);
  assert.equal(partialDoc.getText(), partialAfter);
  assert.equal(partialDoc.isDirty, true);
  await partial.receive({ type: 'undoReview', id: undoId });
  assert.equal(partial.inspect()?.count, 3);
  await partial.receive({ type: 'reviewHunk', revision: partial.inspect()!.revision, id: /data-review="([^"]+)"/.exec(partial.inspect()!.html)![1] });
  assert.equal(partial.inspect()?.count, 2);
  evidence.push('confirmation undo is token-guarded, one-shot, and preserves unsaved text');
  partial.panel.dispose(); partial = await api.open(partialUri);
  assert.equal(partial.inspect()?.count, 2);
  assert.doesNotMatch(partial.inspect()!.html, /<del>30分<\/del>/);
  const beforeConcurrent = partial.inspect()!;
  const remainingId = /data-review="([^"]+)"/.exec(beforeConcurrent.html)![1];
  const again = new vscode.WorkspaceEdit();
  again.replace(partialUri, new vscode.Range(partialDoc.positionAt(0), partialDoc.positionAt(partialDoc.getText().length)), partialAfter.replace('24時間', '48時間'));
  await vscode.workspace.applyEdit(again);
  await partial.receive({ type: 'reviewHunk', revision: beforeConcurrent.revision, id: remainingId });
  assert.equal(partial.inspect()?.count, 3);
  assert.match(partial.inspect()?.notice ?? '', /更新/);
  assert.match(partial.inspect()!.html, /<del>24<\/del><ins>48<\/ins>/);
  evidence.push('individual confirmation persists and re-edited content becomes unreviewed against its approved baseline');
  await partial.receive({ type: 'reviewed', revision: partial.inspect()!.revision });
  assert.equal(partial.inspect()?.count, 0);
  partial.panel.dispose();

  const richUri = vscode.Uri.file(join(root, '編集.md'));
  const original = '# 設計\n\n最初の本文\n';
  await writeFile(richUri.fsPath, original);
  let rich = await api.open(richUri);
  const draft = '# 設計\n\n**編集した本文**\n';
  await rich.receive({ type: 'draft', text: draft, baseText: original });
  rich.panel.dispose(); rich = await api.open(richUri);
  assert.deepEqual(rich.inspect()?.draft, { text: draft, baseText: original });
  evidence.push('WYSIWYG draft survives closing and reopening the tab');
  await rich.receive({ type: 'edit', id: 'apply-1', revision: rich.inspect()!.revision, text: draft });
  assert.equal(rich.inspect()?.markdown, draft);
  assert.equal(rich.inspect()?.dirty, true);
  assert.equal(rich.inspect()?.editResult?.accepted, true);
  assert.equal(rich.inspect()?.draft, undefined);
  assert.equal(await readFile(richUri.fsPath, 'utf8'), original);
  evidence.push('WYSIWYG edit updates document and diff without silently saving');
  await rich.receive({ type: 'edit', id: 'save-1', revision: rich.inspect()!.revision, text: draft + '\n追記\n', save: true });
  assert.equal(await readFile(richUri.fsPath, 'utf8'), draft + '\n追記\n');
  evidence.push('WYSIWYG save writes Markdown to the same file');
  const oldRevision = rich.inspect()!.revision;
  const concurrent = new vscode.WorkspaceEdit();
  concurrent.insert(richUri, new vscode.Position(0, 0), '外部更新\n\n');
  await vscode.workspace.applyEdit(concurrent);
  await rich.receive({ type: 'draft', text: '自分の下書き\n', baseText: draft + '\n追記\n' });
  await assert.rejects(rich.receive({ type: 'draft', text: 'x'.repeat(512 * 1024 + 1), baseText: original }), /512KB/);
  await rich.receive({ type: 'edit', id: 'conflict', revision: oldRevision, text: '自分の下書き\n', save: true });
  assert.equal(rich.inspect()?.editResult?.accepted, false);
  assert.ok(rich.inspect()?.markdown.startsWith('外部更新'));
  rich.panel.dispose(); rich = await api.open(richUri);
  assert.equal(rich.inspect()?.draft?.text, '自分の下書き\n');
  evidence.push('concurrent external edits reject WYSIWYG overwrite and preserve the draft');
  const unchanged = rich.inspect()!.markdown;
  await rich.receive({ type: 'edit', id: 'oversize', revision: rich.inspect()!.revision, text: 'x'.repeat(512 * 1024 + 1) });
  assert.equal(rich.inspect()?.editResult?.accepted, false);
  assert.equal(rich.inspect()?.markdown, unchanged);
  assert.equal(rich.inspect()?.error, undefined);
  evidence.push('oversized drafts are rejected without disabling editing or changing the file');
  await rich.receive({ type: 'discardDraft' });
  assert.equal(rich.inspect()?.draft, undefined);
  rich.panel.dispose();

  const trackedUri = vscode.Uri.file(join(root, '一覧.md'));
  await writeFile(trackedUri.fsPath, '# 一覧\n\n旧文\n');
  const tracked = await api.open(trackedUri);
  await tracked.receive({ type: 'snapshot', revision: tracked.inspect()!.revision });
  assert.match(tracked.inspect()?.notice ?? '', /スナップショットを保存/);
  assert.equal(tracked.inspect()?.count, 0);
  for (let i = 0; i < 20; i++) await tracked.receive({ type: 'snapshot', revision: tracked.inspect()!.revision });
  assert.match(tracked.inspect()?.notice ?? '', /20件まで/);
  assert.equal(tracked.inspect()?.error, undefined);
  await tracked.receive({ type: 'reviewed', revision: tracked.inspect()!.revision });
  assert.equal(tracked.inspect()?.count, 0);
  assert.ok(tracked.inspect()?.undoId);
  evidence.push('snapshot limit preserves existing checkpoints and leaves review actions usable');
  tracked.panel.dispose();
  await writeFile(trackedUri.fsPath, '# 一覧\n\n新文\n');
  await api.pendingFiles.refresh();
  await until(() => api.pendingFiles.getChildren().some(e => e.uri.toString() === trackedUri.toString() && e.count === 1), 'closed tab remains in pending file index');
  const reopenedTracked = await api.open(trackedUri);
  await reopenedTracked.receive({ type: 'reviewed', revision: reopenedTracked.inspect()!.revision });
  await api.pendingFiles.refresh();
  await until(() => !api.pendingFiles.getChildren().some(e => e.uri.toString() === trackedUri.toString()), 'confirmation removes pending file');
  const undoAll = reopenedTracked.inspect()!.undoId;
  await writeFile(trackedUri.fsPath, '# 一覧\n\nさらに新文\n');
  await until(() => reopenedTracked.inspect()?.markdown.includes('さらに新文') ?? false, 'external edit is loaded before confirmation undo');
  await reopenedTracked.receive({ type: 'undoReview', id: undoAll });
  assert.match(reopenedTracked.inspect()?.markdown ?? '', /さらに新文/);
  assert.match(reopenedTracked.inspect()?.html ?? '', /<del>旧/);
  reopenedTracked.panel.dispose();
  evidence.push('snapshot preserves baseline; closed files are monitored; undo after external edits preserves newest text');

  const movedUri = vscode.Uri.file(join(root, '移動.md'));
  const movedBefore = 'Alpha\n\nBravo\n\nCharlie\n\nDelta\n\n', movedAfter = 'Alpha\n\nCharlie\n\nDelta\n\nBravo\n\n';
  await writeFile(movedUri.fsPath, movedBefore);
  const moved = await api.open(movedUri);
  await writeFile(movedUri.fsPath, movedAfter);
  await until(() => moved.inspect()?.count === 1, 'paragraph move detected');
  await moved.receive({ type: 'revert', revision: moved.inspect()!.revision, id: /data-hunk="([^"]+)"/.exec(moved.inspect()!.html)![1] });
  assert.equal(moved.inspect()?.markdown, movedBefore);
  assert.equal(moved.inspect()?.dirty, true);
  assert.equal(await readFile(movedUri.fsPath, 'utf8'), movedAfter);
  moved.panel.dispose();
  evidence.push('paragraph move restores both positions as one native unsaved edit');

  const report = { host: vscode.env.appName, version: vscode.version, checks: evidence, passed: evidence.length, skipped };
  await mkdir(join(root, 'results'), { recursive: true });
  await writeFile(join(root, 'results', 'host.json'), JSON.stringify(report, null, 2));
  console.log('MARKDOWN_REVIEW_HOST_RESULT ' + JSON.stringify(report));
}
