import * as vscode from 'vscode';
import { basename } from 'node:path';
import { planReview } from './core';
import { changeLines, type ChangeLines } from './review-summary';
import type { BaselineStore } from './store';
import { config } from './config';
import { t } from './i18n';

export const BASELINE_SCHEME = 'markdown-lens-baseline';
const markdown = (doc: vscode.TextDocument) => doc.languageId === 'markdown' || /\.(md|markdown|mdown)$/i.test(doc.uri.path);

/** Unreviewed changes in ordinary text editors: gutter marks, status bar count, navigation and a text diff. */
export class EditorReview implements vscode.Disposable, vscode.TextDocumentContentProvider {
  private readonly types: Record<ChangeLines['kind'], vscode.TextEditorDecorationType>;
  private readonly status = vscode.window.createStatusBarItem('markdownLens.unreviewed', vscode.StatusBarAlignment.Right, 90);
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly cache = new Map<string, { version: number; baseline: string; lines: ChangeLines[] }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly subscriptions: vscode.Disposable[] = [];
  constructor(private readonly store: BaselineStore, extensionUri: vscode.Uri) {
    const type = (kind: string, ruler: string) => vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', `gutter-${kind}.svg`), gutterIconSize: 'contain',
      overviewRulerColor: new vscode.ThemeColor(ruler), overviewRulerLane: vscode.OverviewRulerLane.Left, isWholeLine: true,
    });
    this.types = { added: type('added', 'editorOverviewRuler.addedForeground'), changed: type('changed', 'editorOverviewRuler.modifiedForeground'), removed: type('removed', 'editorOverviewRuler.deletedForeground') };
    this.status.name = 'Markdown Lens';
    this.subscriptions.push(this.status, ...Object.values(this.types), this.changed,
      vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, this),
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshVisible()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshVisible()),
      vscode.workspace.onDidChangeTextDocument(e => { if (markdown(e.document)) this.schedule(e.document.uri); }),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('markdownLens')) this.refreshVisible(); }),
      store.onChange(uri => { this.cache.delete(uri); this.changed.fire(this.baselineUri(vscode.Uri.parse(uri))); this.schedule(vscode.Uri.parse(uri)); }));
    this.refreshVisible();
  }
  private schedule(uri: vscode.Uri): void {
    const key = uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); this.refreshVisible(key); }, 250));
  }
  private async lines(doc: vscode.TextDocument): Promise<ChangeLines[] | undefined> {
    const key = doc.uri.toString(), cached = this.cache.get(key);
    if (cached?.version === doc.version) return cached.lines;
    const baseline = await this.store.load(key).catch(() => undefined);
    if (!baseline) return;
    try {
      const lines = changeLines(doc.getText(), planReview(baseline.text, doc.getText(), { cells: false }).hunks);
      this.cache.set(key, { version: doc.version, baseline: baseline.text, lines });
      return lines;
    } catch { return; }
  }
  private refreshVisible(only?: string): void {
    const settings = config();
    for (const editor of vscode.window.visibleTextEditors) {
      if (!markdown(editor.document) || (only && editor.document.uri.toString() !== only)) continue;
      void this.lines(editor.document).then(lines => {
        for (const kind of ['added', 'changed', 'removed'] as const) {
          const ranges = settings.editorDecorations ? (lines ?? []).filter(l => l.kind === kind).map(l => ({ range: new vscode.Range(l.start, 0, l.end, 0), hoverMessage: t('Markdown Lens: 未確認の変更') })) : [];
          editor.setDecorations(this.types[kind], ranges);
        }
      });
    }
    void this.updateStatus(settings.statusBar);
  }
  private async updateStatus(enabled: boolean): Promise<void> {
    const doc = vscode.window.activeTextEditor?.document;
    const lines = enabled && doc && markdown(doc) ? await this.lines(doc) : undefined;
    if (!lines?.length || !doc) { this.status.hide(); return; }
    this.status.text = `$(diff) ${lines.length}`;
    this.status.tooltip = t('Markdown Lens: 未確認の変更 {0}件 — クリックでプレビューを開く', lines.length);
    this.status.command = { command: 'markdownReview.open', title: t('変更プレビューを開く'), arguments: [doc.uri] };
    this.status.show();
  }
  /** Move the cursor of a text editor to the next or previous unreviewed change. */
  async navigate(editor: vscode.TextEditor, direction: 1 | -1): Promise<boolean> {
    const lines = await this.lines(editor.document);
    if (!lines?.length) { void vscode.window.showInformationMessage(t('未確認の変更はありません')); return false; }
    const current = editor.selection.active.line;
    const sorted = [...lines].sort((a, b) => a.start - b.start);
    const target = direction > 0 ? sorted.find(l => l.start > current) ?? sorted[0] : [...sorted].reverse().find(l => l.start < current) ?? sorted[sorted.length - 1];
    const position = new vscode.Position(target.start, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(target.start, 0, target.end, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return true;
  }
  baselineUri(uri: vscode.Uri): vscode.Uri {
    return vscode.Uri.from({ scheme: BASELINE_SCHEME, path: uri.path, query: uri.toString() });
  }
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const baseline = await this.store.load(uri.query).catch(() => undefined);
    return baseline?.text ?? '';
  }
  /** VS Code's own diff editor between the confirmed baseline and the current file. */
  async openTextDiff(uri: vscode.Uri): Promise<void> {
    if (!await this.store.load(uri.toString()).catch(() => undefined)) { void vscode.window.showInformationMessage(t('このファイルの比較元はまだありません。変更プレビューを開くと保存されます。')); return; }
    await vscode.commands.executeCommand('vscode.diff', this.baselineUri(uri), uri, t('{0} · 確認済み ↔ 現在', basename(uri.path)));
  }
  dispose(): void { this.timers.forEach(clearTimeout); this.subscriptions.forEach(d => d.dispose()); }
}
