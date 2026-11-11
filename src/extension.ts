import * as vscode from 'vscode';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { BaselineStore, Baseline, Draft, Snapshot } from './store';
import { buildReview, confirmHunk, revertHunk, Review, Hunk, validateSize } from './core';
import { minimalEdit } from './text-edit';
import { applyCell } from './cell-review';
import type { ReviewView } from './review-view';
import { savePastedImage } from './pasted-image';
import { PendingFiles } from './pending-files';
import { documentText } from './document-source';
import { applyLimits, config } from './config';
import { EditorReview } from './editor-review';
import { checkLinks, openLink } from './link-check';
import { chooseGitRevision, gitText } from './git';
import { reviewSummary, type SummaryInput } from './review-summary';
import { limits } from './limits';
import { t, dateLocale } from './i18n';
import { shellHtml } from './shell';

const ACTIONS = ['view', 'pasteImage', 'reviewCell', 'revertCell', 'ready', 'revert', 'reviewHunk', 'reviewed', 'save', 'edit', 'draft', 'discardDraft', 'exportDraft', 'undoReview', 'snapshot', 'chooseSnapshot', 'openLink', 'hostCommand'] as const;
type Action = { type: typeof ACTIONS[number]; revision?: string; id?: string; text?: string; baseText?: string; save?: boolean; composing?: boolean; view?: ReviewView; row?: number; column?: number; data?: string; href?: string; wiki?: string; command?: string };
interface EditResult { id: string; accepted: boolean }
export interface State {
  view?: ReviewView; uri: string; name: string; html: string; revision: string; count: number;
  hunks: Hunk[]; baselineMarkdown: string; confirmedMarkdown: string;
  updatedAt: string; dirty: boolean; markdown: string; draft?: Draft; undoId?: string; comparison?: string; comparisonLabel?: string; editResult?: EditResult; error?: string; notice?: string;
  settings: { math: boolean; maxBytes: number };
}
/** Shared by every review tab. */
export interface Services {
  store: BaselineStore; pendingFiles: PendingFiles; editorReview: EditorReview; diagnostics: vscode.DiagnosticCollection;
  openMarkdown(uri: vscode.Uri, fragment?: string): Promise<void>;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
const formatDate = (iso: string) => new Date(iso).toLocaleString(dateLocale());

export class ReviewPanel implements vscode.Disposable {
  private baseline!: Baseline;
  private undo?: { id: string; text: string };
  private snapshotBase?: Snapshot & { label?: string };
  private review?: Review;
  private current = '';
  private stamp = '';
  private draft?: Draft;
  private latestDraft?: Action;
  private latestView?: Action;
  private savedView?: ReviewView;
  private state?: State;
  private ready = false;
  private pendingReveal?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private previewTimer?: ReturnType<typeof setTimeout>;
  private linkTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private polling = false;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private disposables: vscode.Disposable[] = [];
  private readonly store: BaselineStore;
  /** Messages from the mounted UI. Callers that send the UI's messages themselves can detach it. */
  private readonly uiMessages: vscode.Disposable;

  constructor(readonly uri: vscode.Uri, readonly panel: vscode.WebviewPanel,
    private readonly services: Services, extensionUri: vscode.Uri, private readonly onClose: () => void) {
    this.store = services.store;
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media'), ...(vscode.workspace.workspaceFolders?.map(f => f.uri) ?? [vscode.Uri.file(dirname(uri.fsPath))])] };
    panel.webview.html = shell(panel.webview, extensionUri);
    this.disposables.push(panel.onDidDispose(() => this.dispose()));
    this.uiMessages = panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.receive(message).catch(error => this.sendError(error));
    });
    this.disposables.push(this.uiMessages);
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
    this.disposables.push(panel.onDidChangeViewState(e => { if (e.webviewPanel.visible) this.schedule(); }),
      vscode.window.onDidChangeWindowState(e => { if (e.focused && panel.visible) this.schedule(); }),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('markdownLens')) { this.startPolling(); this.review = undefined; this.schedule(); } }));
    this.startPolling();
  }
  /** Some watcher exclusions suppress notifications entirely. Only visible previews poll,
   * with at most one queued read, and an unchanged file is detected from its size and time. */
  private startPolling(): void {
    clearInterval(this.pollTimer);
    const interval = config(this.uri).pollInterval;
    if (!interval) return;
    this.pollTimer = setInterval(() => {
      if (this.disposed || !this.panel.visible || this.polling) return;
      this.polling = true;
      void this.serial(() => this.refresh(undefined, undefined, true)).catch(error => this.sendError(error))
        .finally(() => { this.polling = false; });
    }, interval);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(work, work);
    this.queue = pending.catch(() => {});
    return pending;
  }
  async initialize(): Promise<void> {
    return this.serial(async () => {
      const doc = await this.document();
      const text = await documentText(this.uri, doc);
      this.baseline = await this.store.load(this.uri.toString()) ?? await this.store.ensure(this.uri.toString(), await this.services.pendingFiles.initialText(this.uri, text));
      this.savedView = await this.store.loadView(this.uri.toString());
      this.draft = await this.store.loadDraft(this.uri.toString());
      await this.refresh();
    });
  }
  private async document(): Promise<vscode.TextDocument> {
    const missing = () => new Error(t('ファイルが見つかりません。移動・削除された場合は、対象ファイルからプレビューを開き直してください。'));
    try { await vscode.workspace.fs.stat(this.uri); }
    catch { throw missing(); }
    // The file can disappear between the check and the read, notably on remote file systems.
    try { return await vscode.workspace.openTextDocument(this.uri); }
    catch (error) { if (await vscode.workspace.fs.stat(this.uri).then(() => false, () => true)) throw missing(); throw error; }
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
  /** A cheap identity of the source: editor version when unsaved, disk time and size otherwise. */
  private async sourceStamp(): Promise<string | undefined> {
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === this.uri.toString());
    if (doc?.isDirty) return `dirty:${doc.version}`;
    try { const stat = await vscode.workspace.fs.stat(this.uri); return `disk:${stat.mtime}:${stat.size}:${doc?.version ?? ''}`; } catch { return; }
  }
  private async refresh(notice?: string, editResult?: EditResult, onlyIfChanged = false): Promise<void> {
    if (this.disposed || !this.baseline) return;
    const stamp = await this.sourceStamp();
    if (onlyIfChanged && stamp && stamp === this.stamp && this.review && !this.state?.error) return;
    const doc = await this.document();
    const text = await documentText(this.uri, doc).catch(async error => {
      if (await vscode.workspace.fs.stat(this.uri).then(() => false, () => true)) return this.document().then(() => { throw error; });
      throw error;
    });
    if (onlyIfChanged && this.review && text === this.current && doc.isDirty === this.state?.dirty && !this.state.error) { this.stamp = stamp ?? ''; return; }
    const feedback = notice ?? (text === this.current ? this.state?.notice : undefined);
    if (!this.review || text !== this.current) this.review = buildReview(this.snapshotBase?.text ?? this.baseline.text, text, { imageUri: this.imageUri });
    this.current = text; this.stamp = stamp ?? '';
    this.state = {
      view: this.savedView, uri: this.uri.toString(), name: basename(this.uri.path), html: this.review.html,
      revision: this.review.revision, count: this.review.hunks.length,
      updatedAt: this.baseline.updatedAt, dirty: doc.isDirty, notice: feedback,
      hunks: this.review.hunks, baselineMarkdown: this.snapshotBase?.text ?? this.baseline.text, confirmedMarkdown: this.baseline.text,
      markdown: text, draft: this.draft, editResult, undoId: this.undo?.id, comparison: this.snapshotBase?.createdAt, comparisonLabel: this.snapshotBase?.label,
      settings: { math: config(this.uri).math, maxBytes: limits.maxBytes },
    };
    // A restored webview does not mount until its serializer resolves. Waiting for
    // delivery here would deadlock restoration; the UI's ready handshake resends it.
    void this.panel.webview.postMessage({ type: 'update', state: this.state });
    this.scheduleLinkCheck(text);
  }
  private scheduleLinkCheck(text: string): void {
    clearTimeout(this.linkTimer);
    this.linkTimer = setTimeout(() => {
      if (this.disposed) return;
      if (!config(this.uri).validateLinks) { this.services.diagnostics.delete(this.uri); void this.panel.webview.postMessage({ type: 'links', broken: {} }); return; }
      void checkLinks(this.uri, text).then(({ broken, diagnostics }) => {
        if (this.disposed || text !== this.current) return;
        this.services.diagnostics.set(this.uri, diagnostics);
        void this.panel.webview.postMessage({ type: 'links', broken });
      }, () => {});
    }, 500);
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
  /** Commands from the palette or keyboard shortcuts, executed by the webview's own controls. */
  command(name: 'next' | 'previous' | 'reviewAll' | 'find'): void { void this.panel.webview.postMessage({ type: 'command', name }); }
  /** Scroll to a heading anchor once the document has been displayed. */
  reveal(fragment?: string): void {
    if (!fragment) return;
    if (this.ready) void this.panel.webview.postMessage({ type: 'reveal', fragment }); else this.pendingReveal = fragment;
  }
  // The UI and integration tests use exactly the same validated action path.
  async receive(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const action = message as Action;
    if (!(ACTIONS as readonly string[]).includes(action.type)) return;
    if (action.type === 'view') this.latestView = action;
    if (action.type === 'draft') {
      if (typeof action.text !== 'string' || typeof action.baseText !== 'string') return;
      validateSize(action.text); validateSize(action.baseText);
      this.latestDraft = action;
    }
    if (action.type === 'openLink') {
      if ((action.href !== undefined && typeof action.href !== 'string') || (action.wiki !== undefined && typeof action.wiki !== 'string') || (action.href ?? action.wiki ?? '').length > 4000) return;
      await openLink(this.uri, { href: action.href, wiki: action.wiki }, (uri, fragment) => this.services.openMarkdown(uri, fragment)).catch(error => vscode.window.showErrorMessage(errorText(error)));
      return;
    }
    if (action.type === 'hostCommand') {
      const commands: Record<string, string> = { textDiff: 'markdownReview.textDiff', resetBaseline: 'markdownReview.resetBaseline', exportSummary: 'markdownReview.exportSummary', compareGit: 'markdownReview.compareGit' };
      if (typeof action.command === 'string' && commands[action.command]) await vscode.commands.executeCommand(commands[action.command], this.uri);
      return;
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
          if (this.uri.scheme !== 'file') throw new Error(t('ローカルのMarkdownファイルで画像を貼り付けてください。'));
          const src = await savePastedImage(this.uri.fsPath, vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [dirname(this.uri.fsPath)], action.data, config(this.uri).imageFolder);
          void this.panel.webview.postMessage({ type: 'imageSaved', id: action.id, src });
        } catch (error) { void this.panel.webview.postMessage({ type: 'imageSaved', id: action.id, error: errorText(error) }); }
        return;
      }
      if (action.type === 'ready') {
        this.ready = true; await this.refresh();
        if (this.pendingReveal) { void this.panel.webview.postMessage({ type: 'reveal', fragment: this.pendingReveal }); this.pendingReveal = undefined; }
        return;
      }
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
        await this.refresh(t('確認を取り消しました。本文は変更していません。')); return;
      }
      if (action.type === 'chooseSnapshot') {
        try { await this.chooseComparison(); } catch (error) { await this.refresh(errorText(error)); }
        return;
      }
      const result = action.type === 'edit' && typeof action.id === 'string' ? { id: action.id, accepted: false } : undefined;
      if (!this.review || action.revision !== this.review.revision) {
        await this.refresh(t('ファイルが更新されました。最新の差分でもう一度お試しください。'), result);
        return;
      }
      let doc = await this.document();
      if (await documentText(this.uri, doc) !== this.current) {
        await this.refresh(t('ファイルが更新されました。最新の差分でもう一度お試しください。'), result);
        return;
      }
      if (['edit', 'revert', 'revertCell', 'save'].includes(action.type) && !doc.isDirty && doc.getText() !== this.current) {
        doc = await this.reloadCleanDocument(doc);
        if (doc.getText() !== this.current || await documentText(this.uri, doc) !== this.current) {
          await this.refresh(t('ファイルが更新されました。下書きを保持しています。最新の差分を確認してください。'), result);
          return;
        }
      }
      if (action.type === 'snapshot') {
        try {
          await this.store.snapshot(this.uri.toString(), this.current);
          await this.refresh(t('スナップショットを保存しました。履歴アイコンから比較できます。'));
        } catch (error) { await this.refresh(errorText(error)); }
        return;
      }
      if (this.snapshotBase && ['reviewed', 'reviewHunk', 'reviewCell'].includes(action.type)) { await this.refresh(t('確認済みの内容に戻してから確認してください。')); return; }
      if (action.type === 'reviewCell' || action.type === 'revertCell') {
        const hunk = this.review.hunks.find(h => h.id === action.id);
        const cell = hunk?.cells?.find(c => c.row === action.row && c.column === action.column);
        if (!hunk || !cell) { await this.refresh(t('対象のセルが更新されました。もう一度選択してください。')); return; }
        if (action.type === 'reviewCell') {
          const previous = this.baseline.text;
          const next = applyCell(previous, hunk.oldStart + cell.before.start, hunk.oldStart + cell.before.end, cell.before.text, cell.after.text);
          buildReview(next, this.current);
          this.baseline = await this.store.save(this.uri.toString(), next);
          this.undo = { id: randomBytes(12).toString('hex'), text: previous }; this.review = undefined;
          await this.refresh(t('✓ セルを確認しました'));
        } else {
          const next = applyCell(this.current, hunk.start + cell.after.start, hunk.start + cell.after.end, cell.after.text, cell.before.text);
          buildReview(this.baseline.text, next);
          const applied = await this.applyText(doc, next);
          await this.refresh(applied ? t('セルを戻しました。保存でファイルに反映します。') : t('セルを戻せませんでした。最新の内容を確認してください。'));
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
        const applied = action.text === this.current || await this.applyText(doc, action.text);
        if (applied) {
          this.draft = undefined;
          await this.store.clearDraft(this.uri.toString());
          const saved = action.save ? await doc.save() : false;
          await this.refresh(action.save ? (saved ? t('保存しました。') : t('編集は反映しました。ファイルの保存を確認してください。')) : undefined, { ...result, accepted: true });
        } else await this.refresh(t('同時に編集されたため反映できませんでした。下書きは保持しています。'), result);
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
        await this.refresh(t('✓ 確認しました'));
      } else if (action.type === 'reviewed') {
        // Snapshot exactly what was displayed, even if another edit arrives while saving.
        const previous = this.baseline.text;
        this.baseline = await this.store.save(this.uri.toString(), this.current);
        this.undo = { id: randomBytes(12).toString('hex'), text: previous };
        this.review = undefined;
        await this.refresh(t('✓ 確認しました'));
      } else if (action.type === 'revert') {
        const hunk = this.review.hunks.find(h => h.id === action.id);
        if (!hunk) { await this.refresh(); return; }
        const applied = await this.applyText(doc, revertHunk(this.current, hunk), hunk.eol);
        await this.refresh(applied ? t('変更を戻しました。保存でファイルに反映します。エディタのUndoで取り消せます。') : t('ファイルが更新されたため戻せませんでした。もう一度お試しください。'));
      } else if (action.type === 'save') {
        const saved = await doc.save();
        await this.refresh(saved ? t('保存しました。') : t('保存できませんでした。エディタでファイルを確認してください。'));
      }
    });
  }
  /** Snapshots and Git revisions are read-only comparisons; they never change the confirmed baseline. */
  private async chooseComparison(): Promise<void> {
    const items = await this.store.snapshots(this.uri.toString());
    const picked = await vscode.window.showQuickPick([
      { label: `$(check-all) ${t('確認済みの内容')}`, description: t('通常のレビューに戻る'), id: '' },
      { label: `$(git-commit) ${t('Git: HEADと比較')}`, description: t('最後のコミットとの差分'), id: 'git:HEAD' },
      { label: `$(git-branch) ${t('Git: ブランチ・コミットと比較…')}`, description: '', id: 'git:choose' },
      ...items.map(item => ({ label: '$(history) ' + formatDate(item.createdAt), description: t('この時点と比較'), id: item.id })),
      ...(items.length ? [{ label: `$(trash) ${t('スナップショットを削除…')}`, description: '', id: 'delete' }] : []),
    ], { title: t('比較元を選択'), placeHolder: items.length ? t('スナップショットとGitの比較は確認済みの状態を変更しません') : t('カメラボタンで現在の状態を保存できます') });
    if (picked?.id === 'delete') {
      const target = await vscode.window.showQuickPick(items.map(item => ({ label: formatDate(item.createdAt), id: item.id })), { title: t('削除するスナップショット') });
      if (target) {
        await this.store.deleteSnapshot(this.uri.toString(), target.id);
        if (this.snapshotBase?.id === target.id) this.snapshotBase = undefined;
      }
    } else if (picked?.id.startsWith('git:')) {
      const choice = picked.id === 'git:HEAD' ? { ref: 'HEAD', label: 'HEAD' } : await chooseGitRevision(this.uri);
      if (choice) {
        const text = await gitText(this.uri, choice.ref);
        if (text === undefined) throw new Error(t('このファイルはGitリポジトリにありません。Git拡張機能が有効か確認してください。'));
        validateSize(text ?? '');
        this.snapshotBase = { id: 'git:' + choice.ref, text: text ?? '', createdAt: new Date().toISOString(), label: `Git ${choice.label}${text === null ? t('（未追跡）') : ''}` };
      }
    } else if (picked) this.snapshotBase = items.find(item => item.id === picked.id);
    this.review = undefined; await this.refresh();
  }
  /** Compare with a Git revision without changing the confirmed baseline. */
  async compareGit(ref: string): Promise<void> {
    await this.serial(async () => {
      const text = await gitText(this.uri, ref);
      if (text === undefined) throw new Error(t('このファイルはGitリポジトリにありません。Git拡張機能が有効か確認してください。'));
      validateSize(text ?? '');
      this.snapshotBase = { id: 'git:' + ref, text: text ?? '', createdAt: new Date().toISOString(), label: `Git ${ref.length === 40 ? ref.slice(0, 8) : ref}${text === null ? t('（未追跡）') : ''}` };
      this.review = undefined; await this.refresh();
    });
  }
  /** Replace the confirmed baseline: with the current text, a Git revision, or nothing at all.
   * `choice` skips the picker: 'current', 'empty', 'HEAD' or any Git revision. */
  async resetBaseline(choice?: string): Promise<void> {
    const picked = typeof choice === 'string' && choice ? { id: choice === 'current' || choice === 'empty' ? choice : 'ref', ref: choice } : await vscode.window.showQuickPick([
      { label: `$(check-all) ${t('現在の内容')}`, description: t('すべて確認済みにする'), id: 'current' },
      { label: `$(git-commit) ${t('Git HEAD')}`, description: t('コミット以降の変更を未確認にする'), id: 'HEAD' },
      { label: `$(git-branch) ${t('Gitのブランチ・コミット…')}`, description: '', id: 'choose' },
      { label: `$(circle-slash) ${t('空の文書')}`, description: t('全文を未確認にする'), id: 'empty' },
    ], { title: t('確認済みの内容（比較元）をリセット'), placeHolder: t('直後なら「取り消す」で元に戻せます') }).then(item => item && { id: item.id, ref: item.id });
    if (!picked) return;
    await this.serial(async () => {
      let text: string;
      if (picked.id === 'current') text = this.current;
      else if (picked.id === 'empty') text = '';
      else {
        const revision = picked.id === 'choose' ? await chooseGitRevision(this.uri) : { ref: picked.ref };
        if (!revision) return;
        const value = await gitText(this.uri, revision.ref);
        if (value === undefined) { void vscode.window.showWarningMessage(t('このファイルはGitリポジトリにありません。Git拡張機能が有効か確認してください。')); return; }
        text = value ?? '';
      }
      validateSize(text);
      const previous = this.baseline.text;
      this.baseline = await this.store.save(this.uri.toString(), text);
      this.undo = { id: randomBytes(12).toString('hex'), text: previous };
      this.snapshotBase = undefined; this.review = undefined;
      await this.refresh(t('比較元をリセットしました。本文は変更していません。'));
    });
  }
  /** The comparison currently on screen, for summaries. */
  summaryInput(): SummaryInput | undefined {
    if (!this.baseline) return;
    return { name: vscode.workspace.asRelativePath(this.uri), before: this.snapshotBase?.text ?? this.baseline.text, after: this.current,
      baselineLabel: this.snapshotBase?.label ?? (this.snapshotBase ? t('スナップショット {0}', formatDate(this.snapshotBase.createdAt)) : t('確認済みの内容（{0}）', formatDate(this.baseline.updatedAt))) };
  }
  private async reloadCleanDocument(doc: vscode.TextDocument): Promise<vscode.TextDocument> {
    // Opening a clean file editor refreshes both text and the host's save etag.
    // openTextDocument alone returns a stale cached model. Do this only for an
    // explicit edit/save, preserve focus, then restore Preview and close only
    // the temporary clean tab. Never revert a dirty document or force-save it.
    if (doc.isDirty || this.disposed) return doc;
    const existing = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs));
    const isThisFile = (tab: vscode.Tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === this.uri.toString();
    const hadTab = [...existing].some(isThisFile);
    const version = doc.version;
    let opened = false;
    try {
      await vscode.window.showTextDocument(doc, { viewColumn: this.panel.viewColumn, preserveFocus: true, preview: false });
      opened = true;
      // File editor opening can resolve before its asynchronous disk reload.
      const deadline = Date.now() + 2000;
      while (!doc.isClosed && !doc.isDirty && doc.version === version && doc.getText() !== this.current && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 25));
      return await this.document();
    } finally {
      if (!this.disposed) this.panel.reveal(this.panel.viewColumn, true);
      const find = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => !existing.has(tab) && !tab.isDirty && isThisFile(tab));
      let temporary = find();
      // The tab model can reach the extension host after showTextDocument resolves, notably in remote
      // windows. Wait briefly for the tab we opened, but only when the file had no tab before.
      for (const deadline = Date.now() + 1000; opened && !hadTab && !temporary.length && Date.now() < deadline; temporary = find())
        await new Promise(resolve => setTimeout(resolve, 25));
      if (temporary.length) await vscode.window.tabGroups.close(temporary, true);
    }
  }
  private async applyText(doc: vscode.TextDocument, text: string, eol?: 'LF' | 'CRLF'): Promise<boolean> {
    // Coordinates belong to the actual VS Code buffer, which may still contain
    // the pre-AI version. The caller has already validated the latest source.
    const delta = minimalEdit(doc.getText(), text), edit = new vscode.WorkspaceEdit();
    const edits = [vscode.TextEdit.replace(new vscode.Range(doc.positionAt(delta.start), doc.positionAt(delta.end)), delta.text)];
    const newline = /\r?\n/.exec(text)?.[0];
    const ending = eol ? (eol === 'CRLF' ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF)
      : newline ? (newline === '\r\n' ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF) : doc.eol;
    if (ending !== doc.eol) edits.push(vscode.TextEdit.setEndOfLine(ending));
    edit.set(this.uri, edits);
    return vscode.workspace.applyEdit(edit);
  }
  inspect(): State | undefined { return this.state ? { ...this.state } : undefined; }
  settled(): Promise<void> { return this.queue.then(() => {}); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.previewTimer);
    clearTimeout(this.linkTimer);
    clearInterval(this.pollTimer);
    this.services.diagnostics.delete(this.uri);
    this.disposables.splice(0).forEach(d => d.dispose());
    this.onClose();
  }
}

function shell(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const media = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', name)).toString();
  return shellHtml({ cspSource: webview.cspSource, nonce: randomBytes(18).toString('base64'), css: media('review.css'), editorCss: media('webview.css'), script: media('webview.js') });
}

const isMarkdown = (uri: vscode.Uri) => /\.(md|markdown|mdown)$/i.test(uri.path);

export function activate(context: vscode.ExtensionContext) {
  applyLimits();
  const controllers = new Map<string, ReviewPanel>();
  const opening = new Map<string, Promise<ReviewPanel>>();
  const closing = new Map<string, Promise<void>>();
  let focused: ReviewPanel | undefined;
  const store = new BaselineStore(join((context.storageUri ?? context.globalStorageUri).fsPath, 'baselines'));
  const pendingFiles = new PendingFiles(store);
  const pendingView = vscode.window.createTreeView('markdownReview.pending', { treeDataProvider: pendingFiles });
  const editorReview = new EditorReview(store, context.extensionUri);
  const diagnostics = vscode.languages.createDiagnosticCollection('markdownLens');
  pendingFiles.attach(pendingView);
  const services: Services = {
    store, pendingFiles, editorReview, diagnostics,
    async openMarkdown(uri, fragment) { const panel = await open(uri); panel.reveal(fragment); },
  };
  context.subscriptions.push(pendingFiles, pendingView, editorReview, diagnostics,
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('markdownLens.maxFileSizeKB')) applyLimits(); }));
  const open = async (uri: vscode.Uri, existing?: vscode.WebviewPanel, replace = false): Promise<ReviewPanel> => {
    if (uri.scheme === 'untitled' || !isMarkdown(uri)) throw new Error(t('保存済みのMarkdownファイル（.md / .markdown / .mdown）を開いてください。'));
    const key = uri.toString();
    if (opening.has(key) && !existing) return opening.get(key)!;
    await opening.get(key)?.catch(() => undefined);
    const found = controllers.get(key);
    if (found && !replace) { found.panel.reveal(undefined, true); return found; }
    if (found) found.panel.dispose();
    const operation = (async () => {
      // A just-closed tab may still be writing its last received draft. Never
      // restore the next tab from an older on-disk version of that draft.
      await closing.get(key);
      const panel = existing ?? vscode.window.createWebviewPanel('markdownReview.preview', t('{0} · 変更', basename(uri.path)), { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, { enableScripts: true, retainContextWhenHidden: true });
      const controller = new ReviewPanel(uri, panel, services, context.extensionUri, () => {
        if (controllers.get(key) === controller) controllers.delete(key);
        if (focused === controller) focused = undefined;
        const pending = controller.settled(); closing.set(key, pending);
        void pending.finally(() => { if (closing.get(key) === pending) closing.delete(key); });
      });
      controllers.set(key, controller);
      if (panel.active) focused = controller;
      panel.onDidChangeViewState(e => { if (e.webviewPanel.active) focused = controller; });
      try { await controller.initialize(); }
      catch (error) { panel.dispose(); throw error; }
      return controller;
    })();
    opening.set(key, operation);
    try { return await operation; } finally { if (opening.get(key) === operation) opening.delete(key); }
  };
  /** The review tab a palette command acts on: the focused one, or the one for the active editor. */
  const target = (resource?: unknown): ReviewPanel | undefined => {
    if (resource instanceof vscode.Uri) return controllers.get(resource.toString());
    if (focused && !focused.panel.active && vscode.window.activeTextEditor) return controllers.get(vscode.window.activeTextEditor.document.uri.toString()) ?? focused;
    return focused ?? (vscode.window.activeTextEditor && controllers.get(vscode.window.activeTextEditor.document.uri.toString()));
  };
  const resourceOf = (resource?: unknown): vscode.Uri | undefined => resource instanceof vscode.Uri ? resource : focused?.panel.active ? focused.uri : vscode.window.activeTextEditor?.document.uri ?? focused?.uri;
  const run = (work: () => Promise<unknown>) => work().catch(error => { void vscode.window.showErrorMessage(errorText(error)); });
  const command = (id: string, handler: (...args: unknown[]) => Promise<unknown> | unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, (...args: unknown[]) => run(async () => handler(...args))));

  command('markdownReview.open', async (resource?: unknown) => {
    const uri = resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri;
    if (!uri) { void vscode.window.showInformationMessage(t('Markdownファイルを開いて、右上の差分アイコンを押してください。')); return; }
    await open(uri);
  });
  command('markdownReview.refresh', () => pendingFiles.refresh());
  for (const [id, name, direction] of [['markdownReview.nextChange', 'next', 1], ['markdownReview.previousChange', 'previous', -1]] as const) command(id, async (resource?: unknown) => {
    const panel = focused?.panel.active ? focused : undefined;
    if (panel) { panel.command(name); return; }
    const editor = vscode.window.activeTextEditor;
    if (editor && isMarkdown(editor.document.uri)) { await editorReview.navigate(editor, direction); return; }
    target(resource)?.command(name);
  });
  command('markdownReview.reviewAll', async (resource?: unknown) => {
    const uri = resourceOf(resource);
    const panel = target(resource) ?? (uri && isMarkdown(uri) ? await open(uri) : undefined);
    panel?.command('reviewAll');
  });
  command('markdownReview.textDiff', async (resource?: unknown) => { const uri = resourceOf(resource); if (uri && isMarkdown(uri)) await editorReview.openTextDiff(uri); });
  // Optional second arguments let keybindings and automation skip the pickers.
  command('markdownReview.resetBaseline', async (resource?: unknown, choice?: unknown) => {
    const uri = resourceOf(resource); if (!uri || !isMarkdown(uri)) return;
    await (controllers.get(uri.toString()) ?? await open(uri)).resetBaseline(typeof choice === 'string' ? choice : undefined);
  });
  command('markdownReview.compareGit', async (resource?: unknown, ref?: unknown) => {
    const uri = resourceOf(resource); if (!uri || !isMarkdown(uri)) return;
    const panel = controllers.get(uri.toString()) ?? await open(uri);
    if (typeof ref === 'string' && ref) await panel.compareGit(ref); else await panel.receive({ type: 'chooseSnapshot' });
  });
  command('markdownReview.exportSummary', async (resource?: unknown) => {
    const uri = resourceOf(resource);
    const choices = [
      ...(uri && isMarkdown(uri) ? [{ label: `$(file) ${t('このファイル')}`, description: vscode.workspace.asRelativePath(uri), all: false }] : []),
      { label: `$(files) ${t('未確認のすべてのファイル')}`, description: t('{0}ファイル', pendingFiles.files.length), all: true },
    ];
    const picked = resource instanceof vscode.Uri ? choices[0] : choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(choices, { title: t('変更の要約を書き出す') });
    if (!picked) return;
    const inputs: SummaryInput[] = [];
    for (const file of picked.all ? pendingFiles.files : [uri!]) {
      const live = controllers.get(file.toString())?.summaryInput();
      if (live) { inputs.push(live); continue; }
      const baseline = await store.load(file.toString());
      if (baseline) inputs.push({ name: vscode.workspace.asRelativePath(file), before: baseline.text, after: await documentText(file), baselineLabel: t('確認済みの内容（{0}）', formatDate(baseline.updatedAt)) });
    }
    if (!inputs.length) { void vscode.window.showInformationMessage(t('未確認の変更はありません')); return; }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'markdown', content: reviewSummary(inputs) }));
  });
  command('markdownReview.cleanStorage', async () => {
    const missing: string[] = [];
    for (const entry of await store.entries()) {
      try { await vscode.workspace.fs.stat(vscode.Uri.parse(entry.uri)); } catch { missing.push(entry.uri); }
    }
    if (!missing.length) { void vscode.window.showInformationMessage(t('整理が必要な保存データはありません。')); return; }
    const remove = t('削除');
    const answer = await vscode.window.showWarningMessage(t('存在しないファイルの比較元・下書き・スナップショット {0}件を削除しますか？', missing.length), { modal: true }, remove);
    if (answer !== remove) return;
    for (const uri of missing) await store.remove(uri);
    void vscode.window.showInformationMessage(t('{0}件の保存データを削除しました。', missing.length));
  });

  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('markdownReview.preview', {
    async deserializeWebviewPanel(panel, state) {
      try {
        const saved = state as { uri?: unknown } | undefined;
        if (!saved || typeof saved.uri !== 'string') { panel.dispose(); return; }
        await open(vscode.Uri.parse(saved.uri), panel);
      } catch (error) { panel.dispose(); void vscode.window.showErrorMessage(errorText(error)); }
    },
  }));
  // "Open With… → Markdown Lens" and an optional default editor for Markdown files.
  context.subscriptions.push(vscode.window.registerCustomEditorProvider('markdownReview.editor', {
    async resolveCustomTextEditor(document, panel) {
      try { await open(document.uri, panel, true); }
      catch (error) { panel.webview.html = `<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:16px">${String(errorText(error)).replace(/[<>&]/g, c => `&#${c.charCodeAt(0)};`)}</p>`; }
    },
  }, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }));
  // Renames inside VS Code carry review data; external renames are matched by the file list.
  context.subscriptions.push(vscode.workspace.onDidRenameFiles(event => run(async () => {
    for (const { oldUri, newUri } of event.files) {
      const moves: [string, string][] = [];
      if (isMarkdown(oldUri) && isMarkdown(newUri)) moves.push([oldUri.toString(), newUri.toString()]);
      else {
        const from = oldUri.toString().replace(/\/?$/, '/'), to = newUri.toString().replace(/\/?$/, '/');
        for (const entry of await store.entries()) if (entry.uri.startsWith(from)) moves.push([entry.uri, to + entry.uri.slice(from.length)]);
      }
      for (const [from, to] of moves) {
        const controller = controllers.get(from), visible = controller?.panel.visible;
        controller?.panel.dispose(); await closing.get(from);
        await store.move(from, to);
        if (visible) await open(vscode.Uri.parse(to));
      }
    }
    pendingFiles.schedule();
  })));
  // Review data of files deleted long ago is removed in the background.
  const cleanup = setTimeout(() => void run(async () => {
    const days = config().storageRetentionDays;
    if (!days) return;
    const limit = Date.now() - days * 86400000;
    for (const entry of await store.entries()) {
      if (Date.parse(entry.updatedAt) > limit) continue;
      try { await vscode.workspace.fs.stat(vscode.Uri.parse(entry.uri)); } catch { await store.remove(entry.uri); }
    }
  }), 60000);
  context.subscriptions.push({ dispose: () => { clearTimeout(cleanup); for (const c of controllers.values()) c.panel.dispose(); } });
  return { open, pendingFiles, store, editorReview, get: (uri: vscode.Uri) => controllers.get(uri.toString()) };
}
