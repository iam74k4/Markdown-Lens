import * as vscode from 'vscode';
import { BaselineStore } from './store';
import { countChanges, validateSize } from './core';
import { limits } from './limits';
import { documentText } from './document-source';
import { config, excludeGlob } from './config';
import { similarity } from './review-summary';
import { gitText } from './git';
import { t } from './i18n';

interface Entry { uri: vscode.Uri; count?: number; error?: string }
const markdown = (uri: vscode.Uri) => /\.(md|markdown|mdown)$/i.test(uri.path);

/**
 * One workspace index; it keeps monitoring when all review tabs are closed.
 * A full scan runs at startup and when files appear or disappear; edits only
 * recompute the edited file. Files created after monitoring started begin
 * unreviewed, and a file that reappears under a new name keeps its baseline.
 */
export class PendingFiles implements vscode.TreeDataProvider<Entry>, vscode.Disposable {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private entries = new Map<string, Entry>();
  private cache = new Map<string, { stamp: string; entry?: Entry }>();
  private known = new Set<string>();
  private created = new Map<string, number>();
  private deleted = new Map<string, number>();
  private scanned = false;
  private total = 0;
  private fullTimer?: ReturnType<typeof setTimeout>;
  private fileTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pass?: Promise<void>;
  private again = false;
  private disposed = false;
  private subscriptions: vscode.Disposable[] = [];
  private view?: vscode.TreeView<Entry>;
  private readonly pattern = '**/*.{md,markdown,mdown,MD,MARKDOWN,MDOWN}';
  constructor(private store: BaselineStore) {
    const watcher = vscode.workspace.createFileSystemWatcher(this.pattern);
    this.subscriptions.push(watcher,
      watcher.onDidChange(uri => this.scheduleFile(uri)),
      watcher.onDidCreate(uri => { if (this.scanned && !this.known.has(uri.toString())) this.created.set(uri.toString(), Date.now()); this.scheduleFull(); }),
      watcher.onDidDelete(uri => { this.deleted.set(uri.toString(), Date.now()); this.scheduleFull(); }),
      vscode.workspace.onDidChangeTextDocument(e => { if (markdown(e.document.uri) && e.contentChanges.length) this.scheduleFile(e.document.uri); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleFull(true)),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('markdownLens')) this.scheduleFull(true); }),
      store.onChange(uri => this.scheduleFile(vscode.Uri.parse(uri))));
  }
  attach(view: vscode.TreeView<Entry>) { this.view = view; this.scheduleFull(); }
  /** Unreviewed changes of a monitored file, if known. */
  count(uri: vscode.Uri): number | undefined { return this.entries.get(uri.toString())?.count; }
  get files(): vscode.Uri[] { return [...this.entries.values()].filter(e => e.count).map(e => e.uri); }
  /** The baseline a file gets the first time Markdown Lens sees it. */
  async initialText(uri: vscode.Uri, text: string): Promise<string> {
    const key = uri.toString(), settings = config(uri);
    // Git knows which content is committed, so a branch switch does not look like new work.
    if (settings.initialBaseline === 'gitHead') {
      const head = await gitText(uri);
      if (typeof head === 'string') return head;
      if (head === null) return settings.newFiles === 'unreviewed' ? '' : text;
    }
    return this.created.has(key) && settings.newFiles === 'unreviewed' ? '' : text;
  }
  schedule() { this.scheduleFull(); }
  private scheduleFull(clear = false) {
    if (this.disposed) return;
    if (clear) this.cache.clear();
    clearTimeout(this.fullTimer);
    this.fullTimer = setTimeout(() => void this.refresh(), 250);
  }
  private scheduleFile(uri: vscode.Uri) {
    if (this.disposed || !markdown(uri)) return;
    const key = uri.toString();
    clearTimeout(this.fileTimers.get(key));
    this.fileTimers.set(key, setTimeout(() => { this.fileTimers.delete(key); void this.refreshFile(uri); }, 250));
  }
  /** Recompute a single file without scanning the workspace. */
  private async refreshFile(uri: vscode.Uri) {
    if (this.disposed || this.pass || !this.scanned) { if (this.scanned) this.scheduleFile(uri); return; }
    const key = uri.toString();
    if (!this.known.has(key)) { this.scheduleFull(); return; }
    this.cache.delete(key);
    const entry = await this.evaluate(uri);
    if (entry) this.entries.set(key, entry); else this.entries.delete(key);
    this.publish();
  }
  private async evaluate(uri: vscode.Uri): Promise<Entry | undefined> {
    const key = uri.toString();
    try {
      const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
      const stat = doc?.isDirty ? undefined : await vscode.workspace.fs.stat(uri);
      const stamp = doc?.isDirty ? `document:${doc.version}` : `disk:${stat!.mtime}:${stat!.size}`;
      const cached = this.cache.get(key);
      if (cached?.stamp === stamp) return cached.entry;
      if (stat && stat.size > limits.maxBytes) throw new Error(t('{0}を超えるため比較できません', limits.label));
      const text = await documentText(uri, doc);
      validateSize(text);
      let baseline = await this.store.load(key);
      if (!baseline) {
        await this.adoptRenamed(uri, text);
        baseline = await this.store.load(key) ?? await this.store.ensure(key, await this.initialText(uri, text));
      }
      const count = countChanges(baseline.text, text), entry = count ? { uri, count } : undefined;
      this.cache.set(key, { stamp, entry });
      return entry;
    } catch (error) { this.cache.delete(key); return { uri, error: error instanceof Error ? error.message : String(error) }; }
  }
  /** A watcher reports a rename as delete + create; keep the baseline of a matching recent deletion. */
  private async adoptRenamed(uri: vscode.Uri, text: string) {
    const now = Date.now(), candidates: { key: string; score: number }[] = [];
    for (const [key, time] of this.deleted) {
      if (now - time > 10000) { this.deleted.delete(key); continue; }
      if (key === uri.toString()) continue;
      const old = await this.store.load(key).catch(() => undefined);
      if (old) candidates.push({ key, score: similarity(old.text, text) });
    }
    const best = candidates.sort((a, b) => b.score - a.score)[0];
    if (best && best.score >= 0.5 && await this.store.move(best.key, uri.toString())) {
      this.deleted.delete(best.key); this.created.delete(uri.toString());
    }
  }
  /** Rescan the workspace. While a scan runs, callers wait for it and for one more pass. */
  refresh(): Promise<void> {
    if (this.pass) { this.again = true; return this.pass; }
    this.pass = this.scan().finally(() => { this.pass = undefined; });
    return this.pass;
  }
  private async scan() {
    try {
      do {
        this.again = false;
        const settings = config();
        const files = await vscode.workspace.findFiles(this.pattern, excludeGlob(settings.excludeFolders), settings.maxFiles + 1);
        const watched = files.slice(0, settings.maxFiles);
        const next = new Map<string, Entry>();
        const firstScan = !this.scanned;
        for (const uri of watched) {
          if (this.disposed) return;
          // Files present at the first scan are the starting point, never "new".
          if (firstScan) this.known.add(uri.toString());
          else if (!this.known.has(uri.toString())) { this.known.add(uri.toString()); if (!this.created.has(uri.toString())) this.created.set(uri.toString(), Date.now()); }
          const entry = await this.evaluate(uri);
          if (entry) next.set(uri.toString(), entry);
        }
        const live = new Set(files.map(uri => uri.toString()));
        for (const key of [...this.cache.keys()]) if (!live.has(key)) this.cache.delete(key);
        for (const key of [...this.known]) if (!live.has(key)) this.known.delete(key);
        this.entries = next; this.total = files.length; this.scanned = true;
        this.publish(files.length > settings.maxFiles ? settings.maxFiles : undefined);
      } while (this.again && !this.disposed);
    } catch (error) {
      if (this.view) this.view.message = t('一覧を読み込めません: {0}', String(error));
    }
  }
  private publish(limited?: number) {
    if (this.view) {
      this.view.message = limited ? t('先頭{0}ファイルを監視中。対象フォルダーを絞ってください。', limited.toLocaleString()) : t('監視中 {0}ファイル · 初回読み込み以降の変更', this.total);
      const count = [...this.entries.values()].filter(e => e.count).length;
      this.view.badge = { value: count, tooltip: t('未確認のMarkdown {0}ファイル', count) };
    }
    this.changed.fire();
  }
  getChildren() { return [...this.entries.values()].sort((a, b) => a.uri.path.localeCompare(b.uri.path)); }
  getTreeItem(entry: Entry) {
    const item = new vscode.TreeItem(entry.uri);
    item.description = entry.error ? t('比較できません') : t('{0}件', entry.count ?? 0);
    item.tooltip = `${vscode.workspace.asRelativePath(entry.uri)}\n${entry.error ?? t('未確認 {0}件', entry.count ?? 0)}`;
    item.iconPath = new vscode.ThemeIcon(entry.error ? 'warning' : 'diff');
    item.contextValue = entry.error ? 'markdownLensError' : 'markdownLensPending';
    item.command = { command: 'markdownReview.open', title: t('差分を開く'), arguments: [entry.uri] };
    return item;
  }
  dispose() { this.disposed = true; clearTimeout(this.fullTimer); this.fileTimers.forEach(clearTimeout); this.changed.dispose(); this.subscriptions.forEach(d => d.dispose()); }
}
