import * as vscode from 'vscode';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { BaselineStore, Baseline, Draft } from './store';
import { buildReview, confirmHunk, Review, validateSize } from './core';
import { minimalEdit } from './text-edit';

type Action = { type: 'ready' | 'revert' | 'reviewHunk' | 'reviewed' | 'save' | 'edit' | 'draft' | 'discardDraft' | 'exportDraft'; revision?: string; id?: string; text?: string; baseText?: string; save?: boolean };
interface EditResult { id: string; accepted: boolean }
export interface State {
  uri: string; name: string; html: string; revision: string; count: number;
  updatedAt: string; dirty: boolean; markdown: string; draft?: Draft; editResult?: EditResult; error?: string; notice?: string;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export class ReviewPanel implements vscode.Disposable {
  private baseline!: Baseline;
  private review?: Review;
  private current = '';
  private draft?: Draft;
  private state?: State;
  private timer?: ReturnType<typeof setTimeout>;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private disposables: vscode.Disposable[] = [];

  constructor(readonly uri: vscode.Uri, readonly panel: vscode.WebviewPanel,
    private readonly store: BaselineStore, extensionUri: vscode.Uri, private readonly onClose: () => void) {
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] };
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
      this.baseline = await this.store.load(this.uri.toString()) ?? await this.store.save(this.uri.toString(), doc.getText());
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
  private async refresh(notice?: string, editResult?: EditResult): Promise<void> {
    if (this.disposed || !this.baseline) return;
    const doc = await this.document();
    const text = doc.getText();
    const feedback = notice ?? (text === this.current ? this.state?.notice : undefined);
    if (!this.review || text !== this.current) this.review = buildReview(this.baseline.text, text);
    this.current = text;
    this.state = {
      uri: this.uri.toString(), name: basename(this.uri.path), html: this.review.html,
      revision: this.review.revision, count: this.review.hunks.length,
      updatedAt: this.baseline.updatedAt, dirty: doc.isDirty, notice: feedback,
      markdown: text, draft: this.draft, editResult,
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
  // The UI and integration tests use exactly the same validated action path.
  async receive(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const action = message as Action;
    if (!['ready', 'revert', 'reviewHunk', 'reviewed', 'save', 'edit', 'draft', 'discardDraft', 'exportDraft'].includes(action.type)) return;
    return this.serial(async () => {
      // Persist already-received input even if the tab closes while the write is queued.
      if (action.type === 'draft') {
        if (typeof action.text !== 'string' || typeof action.baseText !== 'string') return;
        this.draft = { text: action.text, baseText: action.baseText };
        await this.store.saveDraft(this.uri.toString(), this.draft);
        return;
      }
      if (this.disposed) return;
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
        this.baseline = await this.store.save(this.uri.toString(), next);
        this.review = undefined;
        await this.refresh('この変更を確認済みにしました。');
      } else if (action.type === 'reviewed') {
        // Snapshot exactly what was displayed, even if another edit arrives while saving.
        this.baseline = await this.store.save(this.uri.toString(), this.current);
        this.review = undefined;
        await this.refresh('現在の内容を確認済みにしました。');
      } else if (action.type === 'revert') {
        const hunk = this.review.hunks.find(h => h.id === action.id);
        if (!hunk) { await this.refresh(); return; }
        const edit = new vscode.WorkspaceEdit();
        const replacement = vscode.TextEdit.replace(new vscode.Range(doc.positionAt(hunk.start), doc.positionAt(hunk.end)), hunk.before);
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
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.disposables.splice(0).forEach(d => d.dispose());
    this.onClose();
  }
}

function shell(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(18).toString('base64');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'review.css'));
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.js'));
  const editorCss = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.css'));
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src 'none'; font-src ${webview.cspSource};"><link rel="stylesheet" href="${editorCss}"><link rel="stylesheet" href="${css}"><title>Markdown Review</title></head><body>
  <header class="toolbar"><div class="identity"><span class="brand" aria-hidden="true">M<span>±</span></span><span id="filename">Markdown Review</span></div><div class="mode-switch" role="tablist" aria-label="表示モード"><button id="mode-edit" role="tab" aria-selected="false">編集</button><button id="mode-diff" role="tab" aria-selected="true">差分</button></div><div class="actions" id="review-actions"><span id="counter" role="status" aria-live="polite">読み込み中</span><div id="change-navigation" class="navigation" aria-label="未確認の変更へ移動"><button id="previous" class="icon-button" aria-label="前の変更" title="前の変更（Alt+↑）" disabled>↑</button><span id="position" aria-hidden="true"></span><button id="next" class="icon-button" aria-label="次の変更" title="次の変更（Alt+↓）" disabled>↓</button></div><button id="reviewed" class="review-all" title="未確認の変更をすべて確認済みにする" disabled>すべて確認</button></div></header>
  <div id="formatting" class="formatting" role="toolbar" aria-label="書式" hidden>
    <select id="block-type" aria-label="段落の種類"><option value="paragraph">本文</option><option value="h1">見出し 1</option><option value="h2">見出し 2</option><option value="h3">見出し 3</option><option value="code">コードブロック</option></select>
    <button data-format="bold" aria-label="太字" aria-pressed="false" title="太字（⌘/Ctrl+B）"><strong>B</strong></button><button data-format="italic" aria-label="斜体" aria-pressed="false"><em>I</em></button><button data-format="link">リンク</button><button data-format="bullet" aria-label="箇条書き">• リスト</button><button data-format="number" aria-label="番号付きリスト">1. リスト</button><button data-format="inlineCode" aria-label="インラインコード" aria-pressed="false">&lt;/&gt;</button>
    <select id="table-action" aria-label="表の操作"><option value="">表</option><option value="table">表を挿入</option><option value="addRow">下に行を追加</option><option value="addColumn">右に列を追加</option><option value="deleteRow">行を削除</option><option value="deleteColumn">列を削除</option><option value="deleteTable">表を削除</option></select>
    <button data-format="undo" aria-label="編集を元に戻す">↶</button><button data-format="redo" aria-label="編集をやり直す">↷</button>
  </div>
  <form id="link-form" class="link-form" hidden><label for="link-url">リンク先</label><input id="link-url" type="text" placeholder="https://example.com" autocomplete="off"><button type="submit">適用</button><button type="button" id="link-cancel">キャンセル</button></form>
  <div class="subbar"><span id="baseline">比較元を読み込んでいます…</span><div class="legend" id="legend"><span class="legend-add">＋ 追加</span><span class="legend-remove">− 削除</span></div></div>
  <div id="feedback" class="feedback" role="status" aria-live="polite" hidden></div>
  <div id="conflict" class="conflict" role="alert" hidden><strong>編集中にファイルが更新されました。</strong><p>自分の下書きは保持しています。先に別のタブへ退避できます。</p><button id="export-draft">下書きを別タブに開く</button><button id="discard-draft">下書きを破棄して最新を読み込む</button></div>
  <div id="empty" class="empty-state" tabindex="-1" hidden><span class="empty-check" aria-hidden="true">✓</span><div><strong>未確認の変更はありません</strong><p>AIや手動で編集すると、ここに差分が表示されます。</p></div></div>
  <main id="document" class="document" aria-label="Markdownの変更プレビュー"><p class="loading">プレビューを準備しています…</p></main>
  <main id="editor" class="document rich-document" aria-label="Markdownの編集" hidden></main>
  <footer><span>Markdown Review <span class="footer-dot">·</span> ローカルで比較</span><span id="save-state">保存済み</span><button id="save" class="text-button" hidden>保存</button></footer>
  <script nonce="${nonce}" src="${script}"></script></body></html>`;
}

export function activate(context: vscode.ExtensionContext) {
  const controllers = new Map<string, ReviewPanel>();
  const opening = new Map<string, Promise<ReviewPanel>>();
  const store = new BaselineStore(join((context.storageUri ?? context.globalStorageUri).fsPath, 'baselines'));
  const open = async (uri: vscode.Uri, existing?: vscode.WebviewPanel): Promise<ReviewPanel> => {
    if (uri.scheme === 'untitled' || !/\.(md|markdown|mdown)$/i.test(uri.path)) throw new Error('保存済みのMarkdownファイル（.md / .markdown / .mdown）を開いてください。');
    const key = uri.toString();
    if (opening.has(key)) return opening.get(key)!;
    const found = controllers.get(key);
    if (found) { found.panel.reveal(undefined, true); return found; }
    const operation = (async () => {
      const panel = existing ?? vscode.window.createWebviewPanel('markdownReview.preview', `${basename(uri.path)} · 変更`, { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, { enableScripts: true, retainContextWhenHidden: true });
      const controller = new ReviewPanel(uri, panel, store, context.extensionUri, () => controllers.delete(key));
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
  return { open, get: (uri: vscode.Uri) => controllers.get(uri.toString()) };
}
