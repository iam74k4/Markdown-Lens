import * as vscode from 'vscode';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { BaselineStore, Baseline, Draft, Snapshot } from './store';
import { buildReview, confirmHunk, revertHunk, Review, Hunk, validateSize } from './core';
import { minimalEdit } from './text-edit';
import { icon } from './icons';
import { colorToolbar } from './color-toolbar';
import { applyCell } from './cell-review';
import type { ReviewView } from './review-view';
import { savePastedImage } from './pasted-image';
import { PendingFiles } from './pending-files';

type Action = { type: 'view' | 'pasteImage' | 'reviewCell' | 'revertCell' | 'ready' | 'revert' | 'reviewHunk' | 'reviewed' | 'save' | 'edit' | 'draft' | 'discardDraft' | 'exportDraft' | 'undoReview' | 'snapshot' | 'chooseSnapshot'; revision?: string; id?: string; text?: string; baseText?: string; save?: boolean; composing?: boolean; view?: ReviewView; row?: number; column?: number; data?: string };
interface EditResult { id: string; accepted: boolean }
export interface State {
  view?: ReviewView; uri: string; name: string; html: string; revision: string; count: number;
  hunks: Hunk[]; baselineMarkdown: string; confirmedMarkdown: string;
  updatedAt: string; dirty: boolean; markdown: string; draft?: Draft; undoId?: string; comparison?: string; editResult?: EditResult; error?: string; notice?: string;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export class ReviewPanel implements vscode.Disposable {
  private baseline!: Baseline;
  private undo?: { id: string; text: string };
  private snapshotBase?: Snapshot;
  private review?: Review;
  private current = '';
  private draft?: Draft;
  private latestDraft?: Action;
  private latestView?: Action;
  private savedView?: ReviewView;
  private state?: State;
  private timer?: ReturnType<typeof setTimeout>;
  private previewTimer?: ReturnType<typeof setTimeout>;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private disposables: vscode.Disposable[] = [];

  constructor(readonly uri: vscode.Uri, readonly panel: vscode.WebviewPanel,
    private readonly store: BaselineStore, extensionUri: vscode.Uri, private readonly onClose: () => void) {
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media'), ...(vscode.workspace.workspaceFolders?.map(f => f.uri) ?? [vscode.Uri.file(dirname(uri.fsPath))])] };
    panel.webview.html = shell(panel.webview, extensionUri);
    this.disposables.push(panel.onDidDispose(() => this.dispose()));
    this.disposables.push(panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.receive(message).catch(error => this.sendError(error));
    }));
    this.disposables.push(vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() === uri.toString()) this.schedule();
    }));
    this.disposables.push(vscode.workspace.onDidSaveTextDocument(d => {
      if (d.uri.toString() === uri.toString()) this.schedule();
    }));
    const parent = uri.with({ path: uri.path.slice(0, uri.path.lastIndexOf('/')) || '/' });
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(parent, '*'));
    const changed = (file: vscode.Uri) => { if (file.toString() === uri.toString()) this.schedule(); };
    this.disposables.push(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed));
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(work, work);
    this.queue = pending.catch(() => {});
    return pending;
  }
  async initialize(): Promise<void> {
    return this.serial(async () => {
      const doc = await this.document();
      validateSize(doc.getText());
      this.baseline = await this.store.ensure(this.uri.toString(), doc.getText());
      this.savedView = await this.store.loadView(this.uri.toString());
      this.draft = await this.store.loadDraft(this.uri.toString());
      await this.refresh();
    });
  }
  private async document(): Promise<vscode.TextDocument> {
    try { await vscode.workspace.fs.stat(this.uri); }
    catch { throw new Error('ファイルが見つかりません。移動・削除された場合は、対象ファイルからプレビューを開き直してください。'); }
    return vscode.workspace.openTextDocument(this.uri);
  }
  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.serial(() => this.refresh()).catch(error => this.sendError(error));
    }, 180);
  }
  private imageUri = (src: string): string | undefined => {
    if (this.uri.scheme !== 'file' || /^[a-z][a-z0-9+.-]*:|^[/\\]/i.test(src)) return;
    try {
      const target = realpathSync(join(dirname(this.uri.fsPath), decodeURIComponent(src)));
      if (!/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(target)) return;
      const roots = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [dirname(this.uri.fsPath)];
      if (!roots.some(root => { const rel = relative(realpathSync(root), target); return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); })) return;
      return this.panel.webview.asWebviewUri(vscode.Uri.file(target)).toString();
    } catch { return; }
  };
  private async refresh(notice?: string, editResult?: EditResult): Promise<void> {
    if (this.disposed || !this.baseline) return;
    const doc = await this.document();
    const text = doc.getText();
    const feedback = notice ?? (text === this.current ? this.state?.notice : undefined);
    if (!this.review || text !== this.current) this.review = buildReview(this.snapshotBase?.text ?? this.baseline.text, text, { imageUri: this.imageUri });
    this.current = text;
    this.state = {
      view: this.savedView, uri: this.uri.toString(), name: basename(this.uri.path), html: this.review.html,
      revision: this.review.revision, count: this.review.hunks.length,
      updatedAt: this.baseline.updatedAt, dirty: doc.isDirty, notice: feedback,
      hunks: this.review.hunks, baselineMarkdown: this.snapshotBase?.text ?? this.baseline.text, confirmedMarkdown: this.baseline.text,
      markdown: text, draft: this.draft, editResult, undoId: this.undo?.id, comparison: this.snapshotBase?.createdAt,
    };
    // A restored webview does not mount until its serializer resolves. Waiting for
    // delivery here would deadlock restoration; the UI's ready handshake resends it.
    void this.panel.webview.postMessage({ type: 'update', state: this.state });
  }
  private async sendError(error: unknown): Promise<void> {
    if (this.disposed) return;
    this.review = undefined;
    if (this.state) this.state = { ...this.state, error: errorText(error) };
    void this.panel.webview.postMessage({ type: 'error', message: errorText(error) });
  }
  private scheduleDraftPreview(action: Action): void {
    clearTimeout(this.previewTimer);
    if (action.composing === true) return;
    this.previewTimer = setTimeout(() => {
      void this.serial(async () => {
        if (this.disposed || !this.baseline || action !== this.latestDraft || !this.draft || this.draft.text !== action.text || this.draft.baseText !== action.baseText) return;
        try {
          const review = buildReview(this.snapshotBase?.text ?? this.baseline.text, this.draft.text, { imageUri: this.imageUri });
          void this.panel.webview.postMessage({ type: 'draftPreview', text: this.draft.text, baseText: this.draft.baseText,
            baselineMarkdown: this.snapshotBase?.text ?? this.baseline.text, hunks: review.hunks, html: review.html });
        } catch (error) {
          void this.panel.webview.postMessage({ type: 'draftPreview', text: action.text, error: errorText(error) });
        }
      }).catch(error => this.sendError(error));
    }, 100);
  }
  // The UI and integration tests use exactly the same validated action path.
  async receive(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const action = message as Action;
    if (!['view', 'pasteImage', 'reviewCell', 'revertCell', 'ready', 'revert', 'reviewHunk', 'reviewed', 'save', 'edit', 'draft', 'discardDraft', 'exportDraft', 'undoReview', 'snapshot', 'chooseSnapshot'].includes(action.type)) return;
    if (action.type === 'view') this.latestView = action;
    if (action.type === 'draft') {
      if (typeof action.text !== 'string' || typeof action.baseText !== 'string') return;
      validateSize(action.text); validateSize(action.baseText);
      this.latestDraft = action;
    }
    return this.serial(async () => {
      if (action.type === 'view') {
        if (action === this.latestView) await this.store.saveView(this.uri.toString(), action.view);
        return;
      }
      // Persist already-received input even if the tab closes while the write is queued.
      if (action.type === 'draft') {
        if (action !== this.latestDraft) return;
        if (typeof action.text !== 'string' || typeof action.baseText !== 'string') return;
        validateSize(action.text); validateSize(action.baseText);
        this.draft = { text: action.text, baseText: action.baseText };
        await this.store.saveDraft(this.uri.toString(), this.draft);
        if (!this.disposed && action === this.latestDraft) this.scheduleDraftPreview(action);
        return;
      }
      if (this.disposed) return;
      if (action.type === 'pasteImage') {
        if (typeof action.id !== 'string') return;
        try {
          if (this.uri.scheme !== 'file') throw new Error('ローカルのMarkdownファイルで画像を貼り付けてください。');
          const src = await savePastedImage(this.uri.fsPath, vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [dirname(this.uri.fsPath)], action.data);
          void this.panel.webview.postMessage({ type: 'imageSaved', id: action.id, src });
        } catch (error) { void this.panel.webview.postMessage({ type: 'imageSaved', id: action.id, error: errorText(error) }); }
        return;
      }
      if (action.type === 'ready') { await this.refresh(); return; }
      if (action.type === 'discardDraft') {
        await this.store.clearDraft(this.uri.toString()); this.draft = undefined;
        await this.refresh(); return;
      }
      if (action.type === 'exportDraft') {
        if (typeof action.text !== 'string') return;
        validateSize(action.text);
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'markdown', content: action.text }));
        return;
      }
      if (action.type === 'undoReview') {
        if (!this.undo || action.id !== this.undo.id || this.snapshotBase) { await this.refresh(); return; }
        this.baseline = await this.store.save(this.uri.toString(), this.undo.text);
        this.undo = undefined; this.review = undefined;
        await this.refresh('確認を取り消しました。本文は変更していません。'); return;
      }
      if (action.type === 'chooseSnapshot') {
        try {
        const items = await this.store.snapshots(this.uri.toString());
        const picked = await vscode.window.showQuickPick([
          { label: '$(check-all) 確認済みの内容', description: '通常のレビューに戻る', id: '' },
          ...items.map(item => ({ label: '$(history) ' + new Date(item.createdAt).toLocaleString('ja-JP'), description: 'この時点と比較', id: item.id })),
          ...(items.length ? [{ label: '$(trash) スナップショットを削除…', description: '', id: 'delete' }] : []),
        ], { title: '比較元を選択', placeHolder: items.length ? 'スナップショット比較は確認済みの状態を変更しません' : 'カメラボタンで現在の状態を保存できます' });
        if (picked?.id === 'delete') {
          const target = await vscode.window.showQuickPick(items.map(item => ({ label: new Date(item.createdAt).toLocaleString('ja-JP'), id: item.id })), { title: '削除するスナップショット' });
          if (target) {
            await this.store.deleteSnapshot(this.uri.toString(), target.id);
            if (this.snapshotBase?.id === target.id) this.snapshotBase = undefined;
          }
        } else if (picked) this.snapshotBase = items.find(item => item.id === picked.id);
        this.review = undefined; await this.refresh();
        } catch (error) { await this.refresh(errorText(error)); }
        return;
      }
      const result = action.type === 'edit' && typeof action.id === 'string' ? { id: action.id, accepted: false } : undefined;
      if (!this.review || action.revision !== this.review.revision) {
        await this.refresh('ファイルが更新されました。最新の差分でもう一度お試しください。', result);
        return;
      }
      const doc = await this.document();
      if (doc.getText() !== this.current) {
        await this.refresh('ファイルが更新されました。最新の差分でもう一度お試しください。', result);
        return;
      }
      if (action.type === 'snapshot') {
        try {
          await this.store.snapshot(this.uri.toString(), this.current);
          await this.refresh('スナップショットを保存しました。履歴アイコンから比較できます。');
        } catch (error) { await this.refresh(errorText(error)); }
        return;
      }
      if (this.snapshotBase && ['reviewed', 'reviewHunk', 'reviewCell'].includes(action.type)) { await this.refresh('確認済みの内容に戻してから確認してください。'); return; }
      if (action.type === 'reviewCell' || action.type === 'revertCell') {
        const hunk = this.review.hunks.find(h => h.id === action.id);
        const cell = hunk?.cells?.find(c => c.row === action.row && c.column === action.column);
        if (!hunk || !cell) { await this.refresh('対象のセルが更新されました。もう一度選択してください。'); return; }
        if (action.type === 'reviewCell') {
          const previous = this.baseline.text;
          const next = applyCell(previous, hunk.oldStart + cell.before.start, hunk.oldStart + cell.before.end, cell.before.text, cell.after.text);
          buildReview(next, this.current);
          this.baseline = await this.store.save(this.uri.toString(), next);
          this.undo = { id: randomBytes(12).toString('hex'), text: previous }; this.review = undefined;
          await this.refresh('✓ セルを確認しました');
        } else {
          const next = applyCell(this.current, hunk.start + cell.after.start, hunk.start + cell.after.end, cell.after.text, cell.before.text);
          buildReview(this.baseline.text, next);
          const delta = minimalEdit(this.current, next), edit = new vscode.WorkspaceEdit();
          edit.replace(this.uri, new vscode.Range(doc.positionAt(delta.start), doc.positionAt(delta.end)), delta.text);
          const applied = await vscode.workspace.applyEdit(edit);
          await this.refresh(applied ? 'セルを戻しました。保存でファイルに反映します。' : 'セルを戻せませんでした。最新の内容を確認してください。');
        }
        return;
      }
      if (action.type === 'edit') {
        if (typeof action.text !== 'string' || !result) return;
        try {
          validateSize(action.text);
          buildReview(this.baseline.text, action.text); // Check limits before changing the actual document.
        } catch (error) {
          // Invalid drafts must remain editable instead of disabling the entire preview.
          await this.refresh(errorText(error), result); return;
        }
        const change = minimalEdit(this.current, action.text);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(this.uri, new vscode.Range(doc.positionAt(change.start), doc.positionAt(change.end)), change.text);
        const applied = action.text === this.current || await vscode.workspace.applyEdit(edit);
        if (applied) {
          this.draft = undefined;
          await this.store.clearDraft(this.uri.toString());
          const saved = action.save ? await doc.save() : false;
          await this.refresh(action.save ? (saved ? '保存しました。' : '編集は反映しました。ファイルの保存を確認してください。') : undefined, { ...result, accepted: true });
        } else await this.refresh('同時に編集されたため反映できませんでした。下書きは保持しています。', result);
      } else if (action.type === 'reviewHunk') {
        const hunk = this.review.hunks.find(h => h.id === action.id);
        if (!hunk) { await this.refresh(); return; }
        let next: string;
        try {
          next = confirmHunk(this.baseline.text, hunk);
          buildReview(next, this.current); // Check the mixed baseline before persisting it.
        } catch (error) { await this.refresh(errorText(error)); return; }
        // Keep every unreviewed change at its previous baseline. Concurrent edits
        // arriving during this write are compared against exactly what was approved.
        const previous = this.baseline.text;
        this.baseline = await this.store.save(this.uri.toString(), next);
        this.undo = { id: randomBytes(12).toString('hex'), text: previous };
        this.review = undefined;
        await this.refresh('✓ 確認しました');
      } else if (action.type === 'reviewed') {
        // Snapshot exactly what was displayed, even if another edit arrives while saving.
        const previous = this.baseline.text;
        this.baseline = await this.store.save(this.uri.toString(), this.current);
        this.undo = { id: randomBytes(12).toString('hex'), text: previous };
        this.review = undefined;
        await this.refresh('✓ 確認しました');
      } else if (action.type === 'revert') {
        const hunk = this.review.hunks.find(h => h.id === action.id);
        if (!hunk) { await this.refresh(); return; }
        const edit = new vscode.WorkspaceEdit();
        const delta = minimalEdit(this.current, revertHunk(this.current, hunk));
        const replacement = vscode.TextEdit.replace(new vscode.Range(doc.positionAt(delta.start), doc.positionAt(delta.end)), delta.text);
        edit.set(this.uri, hunk.eol
          ? [replacement, vscode.TextEdit.setEndOfLine(hunk.eol === 'CRLF' ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF)]
          : [replacement]);
        const applied = await vscode.workspace.applyEdit(edit);
        await this.refresh(applied ? '変更を戻しました。保存でファイルに反映します。エディタのUndoで取り消せます。' : 'ファイルが更新されたため戻せませんでした。もう一度お試しください。');
      } else if (action.type === 'save') {
        const saved = await doc.save();
        await this.refresh(saved ? '保存しました。' : '保存できませんでした。エディタでファイルを確認してください。');
      }
    });
  }
  inspect(): State | undefined { return this.state ? { ...this.state } : undefined; }
  settled(): Promise<void> { return this.queue.then(() => {}); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.previewTimer);
    this.disposables.splice(0).forEach(d => d.dispose());
    this.onClose();
  }
}

function shell(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(18).toString('base64');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'review.css'));
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.js'));
  const editorCss = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.css'));
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource}; font-src ${webview.cspSource};"><link rel="stylesheet" href="${editorCss}"><link rel="stylesheet" href="${css}"><title>Markdown Review</title></head><body>
  <header class="toolbar"><div class="identity"><span class="brand" aria-hidden="true">${icon('diff')}</span><span id="filename">Markdown Review</span></div><div class="mode-switch" role="tablist" aria-label="表示モード"><button id="mode-edit" role="tab" aria-selected="false">${icon('edit')}<span>本文</span></button><button id="mode-diff" role="tab" aria-selected="true">${icon('diff')}<span>詳細比較</span></button></div><button id="toggle-source" class="icon-button" aria-label="Markdownソースを開く" title="Markdownソース" aria-pressed="false">${icon('code')}</button><div class="actions" id="review-actions"><span id="counter" role="status" aria-live="polite">読み込み中</span><div id="change-navigation" class="navigation" aria-label="未確認の変更へ移動"><button id="previous" class="icon-button" aria-label="前の変更" title="前の変更（Alt+↑）" disabled>${icon('up')}</button><span id="position" aria-hidden="true"></span><button id="next" class="icon-button" aria-label="次の変更" title="次の変更（Alt+↓）" disabled>${icon('down')}</button></div><button id="reviewed" class="review-all has-tooltip" data-tooltip="すべて確認済みにする" aria-label="すべて確認済みにする" disabled>${icon('checkAll')}</button></div></header>
  <div id="formatting" class="formatting" role="toolbar" aria-label="書式" hidden>
    <select id="block-type" aria-label="段落の種類"><option value="paragraph">本文</option><option value="h1">見出し 1</option><option value="h2">見出し 2</option><option value="h3">見出し 3</option><option value="h4">見出し 4</option><option value="h5">見出し 5</option><option value="h6">見出し 6</option><option value="code">コードブロック</option></select>
    <button data-format="bold" aria-label="太字" aria-pressed="false" title="太字（⌘/Ctrl+B）"><strong>B</strong></button><button data-format="italic" aria-label="斜体" title="斜体" aria-pressed="false"><em>I</em></button>${colorToolbar()}<button data-format="link" aria-label="リンク" title="リンク">${icon('link')}</button><button data-format="bullet" aria-label="箇条書き" title="箇条書き">${icon('bullet')}</button><button data-format="number" aria-label="番号付きリスト" title="番号付きリスト">${icon('number')}</button><button data-format="inlineCode" aria-label="インラインコード" title="インラインコード" aria-pressed="false">${icon('code')}</button>
    <button data-format="task" aria-label="チェックリスト" title="チェックリスト">${icon('checklist')}</button><button data-format="strike" aria-label="取り消し線" title="取り消し線"><s>S</s></button><button data-format="quote" aria-label="引用" title="引用">${icon('quote')}</button><button data-format="rule" aria-label="区切り線" title="区切り線">${icon('rule')}</button><button data-format="image" aria-label="画像を挿入" title="画像を挿入">${icon('image')}</button><button data-format="mermaid" aria-label="Mermaidを挿入" title="Mermaidを挿入">${icon('diagram')}</button>
    <button id="editor-wide" aria-label="編集領域を広く表示" aria-pressed="false" title="編集領域を広く表示">${icon('expand')}</button><select id="table-action" aria-label="表の操作"><option value="">表</option><option value="table">表を挿入</option><option value="addRowBefore">上に行を追加</option><option value="addColumnBefore">左に列を追加</option><option value="alignLeft">左揃え</option><option value="alignCenter">中央揃え</option><option value="alignRight">右揃え</option><option value="addRow">下に行を追加</option><option value="addColumn">右に列を追加</option><option value="deleteRow">行を削除</option><option value="deleteColumn">列を削除</option><option value="deleteTable">表を削除</option></select>
    <button data-format="undo" aria-label="編集を元に戻す" title="編集を元に戻す">${icon('undo')}</button><button data-format="redo" aria-label="編集をやり直す" title="編集をやり直す">${icon('redo')}</button>
  </div>
  <form id="link-form" class="link-form" hidden><label for="link-url">リンク先</label><input id="link-url" type="text" placeholder="https://example.com" autocomplete="off"><button type="submit">適用</button><button type="button" id="link-cancel">キャンセル</button></form>
  <form id="image-form" class="link-form" hidden><label for="image-src">画像パス</label><input id="image-src" placeholder="./images/design.png" aria-label="画像パス"><input id="image-alt" placeholder="画像の説明" aria-label="画像の説明"><button type="submit">挿入</button><button type="button" id="image-cancel">キャンセル</button></form>
  <div class="review-tools"><button id="toggle-find" class="icon-button has-tooltip" aria-label="本文を検索・置換" aria-pressed="false" data-tooltip="検索・置換（⌘/Ctrl+F）">${icon('search')}</button><button id="toggle-outline" class="icon-button has-tooltip" aria-label="見出しナビゲーション" aria-pressed="false" data-tooltip="目次">${icon('outline')}</button><button id="fold-all" class="icon-button has-tooltip" aria-label="見出しをすべて折りたたむ" data-tooltip="見出しをすべて折りたたむ">${icon('fold')}</button><button id="unfold-all" class="icon-button has-tooltip" aria-label="見出しをすべて展開" data-tooltip="見出しをすべて展開">${icon('unfold')}</button><button id="changes-only" class="icon-button has-tooltip" aria-label="変更箇所だけ表示" aria-pressed="false" data-tooltip="変更箇所だけ表示">${icon('filter')}</button><button id="snapshot" class="icon-button has-tooltip" aria-label="スナップショットを保存" data-tooltip="現在の状態を保存">${icon('camera')}</button><button id="snapshots" class="icon-button has-tooltip" aria-label="スナップショットと比較" data-tooltip="スナップショットと比較">${icon('history')}</button></div><div class="subbar"><span id="baseline">比較元を読み込んでいます…</span><div class="legend" id="legend"><span class="legend-add">＋ 追加</span><span class="legend-remove">− 削除</span></div></div>
  <section id="find-panel" class="find-panel" aria-label="本文の検索と置換" hidden><div class="find-row"><input id="find-query" type="search" aria-label="検索する文字" placeholder="本文を検索" maxlength="1000"><span id="find-count" role="status"></span><button id="find-previous" aria-label="前の検索結果">${icon('up')}</button><button id="find-next" aria-label="次の検索結果">${icon('down')}</button><button id="find-close" aria-label="検索を閉じる">${icon('close')}</button></div><div class="find-row"><input id="replace-text" aria-label="置換する文字" placeholder="置換する文字" maxlength="10000"><button id="replace-one">置換</button><button id="replace-all">すべて置換</button></div><div class="find-options"><label><input id="find-case" type="checkbox">大文字・小文字を区別</label><label><input id="find-changes" type="checkbox">変更箇所だけ</label><span>本文の文字を検索 · 置換後は保存で反映</span></div></section>
  <nav id="outline-panel" class="outline-panel" aria-label="見出しナビゲーション" hidden><div class="outline-heading"><strong>目次</strong><button id="outline-close" aria-label="目次を閉じる">${icon('close')}</button></div><div id="outline-items"></div></nav>
  <div id="feedback" class="feedback" role="status" aria-live="polite" hidden><span id="feedback-text"></span><button id="undo-review" class="text-button" hidden>取り消す</button></div>
  <div id="conflict" class="conflict" role="alert" hidden><strong>編集中にファイルが更新されました。</strong><p>自分の下書きは保持しています。先に別のタブへ退避できます。</p><button id="export-draft">下書きを別タブに開く</button><button id="discard-draft">下書きを破棄して最新を読み込む</button></div>
  <div id="empty" class="empty-state" tabindex="-1" hidden><span class="empty-check" aria-hidden="true">${icon('check')}</span><div><strong>未確認の変更はありません</strong><p>AIや手動で編集すると、ここに差分が表示されます。</p></div></div>
  <div id="workspace" class="review-workspace"><div class="reading-pane">
  <main id="document" class="document" aria-label="Markdownの変更プレビュー"><p class="loading">プレビューを準備しています…</p></main>
  <main id="editor" class="document rich-document" aria-label="差分を見ながらMarkdownを編集" hidden></main></div>
  <aside id="source-pane" hidden aria-label="Markdownソース"><div class="source-heading"><select id="source-version" aria-label="ソースの種類"><option value="current">現在のMarkdown · 編集可</option><option value="confirmed">確認済みのMarkdown · 読み取り専用</option><option value="comparison">比較元のMarkdown · 読み取り専用</option></select><button id="close-source" aria-label="ソースを閉じる">${icon('close')}</button></div><textarea id="source-text" aria-label="Markdownソース" spellcheck="false"></textarea><p id="source-hint">本文と同じ下書きを編集します。</p></aside></div>
  <footer><span>Markdown Review <span class="footer-dot">·</span> ローカルで比較</span><span id="save-state">保存済み</span><button id="save" class="text-button" hidden>${icon('save')}<span>保存</span></button></footer>
  <script nonce="${nonce}" src="${script}"></script></body></html>`;
}

export function activate(context: vscode.ExtensionContext) {
  const controllers = new Map<string, ReviewPanel>();
  const opening = new Map<string, Promise<ReviewPanel>>();
  const closing = new Map<string, Promise<void>>();
  const store = new BaselineStore(join((context.storageUri ?? context.globalStorageUri).fsPath, 'baselines'));
  const pendingFiles = new PendingFiles(store);
  const pendingView = vscode.window.createTreeView('markdownReview.pending', { treeDataProvider: pendingFiles });
  pendingFiles.attach(pendingView);
  context.subscriptions.push(pendingFiles, pendingView, vscode.commands.registerCommand('markdownReview.refresh', () => pendingFiles.refresh()));
  const open = async (uri: vscode.Uri, existing?: vscode.WebviewPanel): Promise<ReviewPanel> => {
    if (uri.scheme === 'untitled' || !/\.(md|markdown|mdown)$/i.test(uri.path)) throw new Error('保存済みのMarkdownファイル（.md / .markdown / .mdown）を開いてください。');
    const key = uri.toString();
    if (opening.has(key)) return opening.get(key)!;
    const found = controllers.get(key);
    if (found) { found.panel.reveal(undefined, true); return found; }
    const operation = (async () => {
      // A just-closed tab may still be writing its last received draft. Never
      // restore the next tab from an older on-disk version of that draft.
      await closing.get(key);
      const panel = existing ?? vscode.window.createWebviewPanel('markdownReview.preview', `${basename(uri.path)} · 変更`, { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, { enableScripts: true, retainContextWhenHidden: true });
      const controller = new ReviewPanel(uri, panel, store, context.extensionUri, () => {
        controllers.delete(key);
        const pending = controller.settled(); closing.set(key, pending);
        void pending.finally(() => { if (closing.get(key) === pending) closing.delete(key); });
      });
      controllers.set(key, controller);
      try { await controller.initialize(); }
      catch (error) { panel.dispose(); throw error; }
      return controller;
    })();
    opening.set(key, operation);
    try { return await operation; } finally { opening.delete(key); }
  };
  context.subscriptions.push(vscode.commands.registerCommand('markdownReview.open', async (resource?: vscode.Uri) => {
    const uri = resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri;
    if (!uri) { void vscode.window.showInformationMessage('Markdownファイルを開いて、右上の差分アイコンを押してください。'); return; }
    try { await open(uri); } catch (error) { void vscode.window.showErrorMessage(errorText(error)); }
  }));
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('markdownReview.preview', {
    async deserializeWebviewPanel(panel, state) {
      try {
        const saved = state as { uri?: unknown } | undefined;
        if (!saved || typeof saved.uri !== 'string') { panel.dispose(); return; }
        await open(vscode.Uri.parse(saved.uri), panel);
      } catch (error) { panel.dispose(); void vscode.window.showErrorMessage(errorText(error)); }
    },
  }));
  context.subscriptions.push({ dispose: () => { for (const c of controllers.values()) c.panel.dispose(); } });
  return { open, pendingFiles, get: (uri: vscode.Uri) => controllers.get(uri.toString()) };
}
