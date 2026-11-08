import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PendingFiles } from '../src/pending-files';
import type { ReviewPanel } from '../src/extension';
import type { BaselineStore } from '../src/store';

export interface FeatureApi { open(uri: vscode.Uri): Promise<ReviewPanel>; pendingFiles: PendingFiles; store: BaselineStore; get(uri: vscode.Uri): ReviewPanel | undefined }
async function until(predicate: () => boolean | Promise<boolean>, label: string, timeout = 10000) {
  const start = Date.now();
  while (!await predicate()) {
    if (Date.now() - start > timeout) throw new Error(`Timeout: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 80));
  }
}

/** Features of 0.14.0 exercised through the real extension host and its commands. */
export async function featureChecks(api: FeatureApi, root: string): Promise<string[]> {
  const evidence: string[] = [];
  const settings = vscode.workspace.getConfiguration('markdownLens');

  // A file created after monitoring started is entirely unreviewed.
  await settings.update('newFiles', 'unreviewed', vscode.ConfigurationTarget.Global);
  try {
    await api.pendingFiles.refresh();
    const created = vscode.Uri.file(join(root, 'AIが作成.md'));
    await writeFile(created.fsPath, '# New\n\nWritten by an agent.\n');
    await until(() => api.pendingFiles.getChildren().some(e => e.uri.toString() === created.toString() && e.count === 2), 'new file listed as unreviewed', 15000);
    const panel = await api.open(created);
    assert.equal(panel.inspect()?.count, 2);
    assert.equal(panel.inspect()?.confirmedMarkdown, '');
    panel.panel.dispose();
    evidence.push('files created after monitoring started are shown as added and unreviewed');
  } finally { await settings.update('newFiles', undefined, vscode.ConfigurationTarget.Global); }

  // Renaming inside VS Code keeps the baseline, so pending changes stay visible.
  const original = vscode.Uri.file(join(root, '改名前.md')), renamed = vscode.Uri.file(join(root, '改名後.md'));
  await writeFile(original.fsPath, '# Rename\n\nold text\n');
  let panel = await api.open(original);
  await writeFile(original.fsPath, '# Rename\n\nnew text\n');
  await until(() => panel.inspect()?.count === 1, 'change before rename');
  panel.panel.dispose();
  const edit = new vscode.WorkspaceEdit(); edit.renameFile(original, renamed);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  await until(async () => !!await api.store.load(renamed.toString()), 'baseline moved with the file');
  panel = await api.open(renamed);
  assert.equal(panel.inspect()?.count, 1);
  assert.match(panel.inspect()!.confirmedMarkdown, /old text/);
  evidence.push('renaming a file carries its baseline and keeps unreviewed changes');

  // Commands: native text diff, change summary, text editor navigation.
  await vscode.commands.executeCommand('markdownReview.textDiff', renamed);
  await until(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff, 'text diff opened');
  const diff = vscode.window.tabGroups.activeTabGroup.activeTab!.input as vscode.TabInputTextDiff;
  assert.equal(diff.original.scheme, 'markdown-lens-baseline');
  assert.equal((await vscode.workspace.openTextDocument(diff.original)).getText(), '# Rename\n\nold text\n');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  evidence.push("the reviewed baseline opens in VS Code's diff editor");
  await vscode.commands.executeCommand('markdownReview.exportSummary', renamed);
  await until(() => vscode.window.activeTextEditor?.document.isUntitled === true, 'summary document opened');
  const summary = vscode.window.activeTextEditor!.document.getText();
  assert.match(summary, /^# /); assert.match(summary, /- old text\n\+ new text/);
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  evidence.push('the change summary lists unreviewed hunks as Markdown diffs');
  const editor = await vscode.window.showTextDocument(renamed, { preview: false });
  editor.selection = new vscode.Selection(0, 0, 0, 0);
  await vscode.commands.executeCommand('markdownReview.nextChange');
  await until(() => editor.selection.active.line === 2, 'cursor moved to the change');
  evidence.push('next-change navigation works in the text editor');
  panel.panel.dispose();

  // Broken relative links become diagnostics while the preview is open.
  const linked = vscode.Uri.file(join(root, 'リンク.md'));
  await writeFile(linked.fsPath, '# Links\n\nSee [missing](./missing.md), [ok](./改名後.md) and [anchor](#links), [bad](#nowhere).\n');
  const linkPanel = await api.open(linked);
  await until(() => vscode.languages.getDiagnostics(linked).length === 2, 'broken link diagnostics');
  assert.deepEqual(vscode.languages.getDiagnostics(linked).map(d => d.range.start.line), [2, 2]);
  linkPanel.panel.dispose();
  await until(() => vscode.languages.getDiagnostics(linked).length === 0, 'diagnostics cleared with the preview');
  evidence.push('missing link targets and anchors are reported as diagnostics');

  // "Open With… → Markdown Lens" hosts the same review in a custom editor.
  await vscode.commands.executeCommand('vscode.openWith', renamed, 'markdownReview.editor');
  await until(() => !!api.get(renamed)?.inspect(), 'custom editor review');
  assert.equal(api.get(renamed)!.inspect()!.count, 1);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  evidence.push('Markdown Lens opens as a custom editor via Open With');

  // Editing a block keeps hard wraps and HTML through the save path.
  const preserved = vscode.Uri.file(join(root, '保持.md'));
  const source = 'Wrapped line one\nline two <kbd>K</kbd>\n\n---\ntitle: not front matter here\n';
  await writeFile(preserved.fsPath, source);
  const keep = await api.open(preserved);
  await keep.receive({ type: 'edit', id: 'keep', text: source.replace('one', 'ONE'), revision: keep.inspect()!.revision, save: true });
  await until(async () => (await readFile(preserved.fsPath, 'utf8')).includes('ONE'), 'edit saved');
  assert.equal(await readFile(preserved.fsPath, 'utf8'), source.replace('one', 'ONE'));
  keep.panel.dispose();
  evidence.push('saving an edit writes exactly the edited Markdown');
  return evidence;
}
