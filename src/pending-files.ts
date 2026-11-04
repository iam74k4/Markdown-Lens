import * as vscode from 'vscode';
import { BaselineStore } from './store';
import { buildReview, MAX_BYTES, validateSize } from './core';
import { documentText } from './document-source';

interface Entry { uri: vscode.Uri; count?: number; error?: string }
/** One workspace index; it keeps monitoring when all review tabs are closed. */
export class PendingFiles implements vscode.TreeDataProvider<Entry>, vscode.Disposable {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private entries: Entry[] = [];
  private cache = new Map<string, { stamp: string; entry?: Entry }>();
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private again = false;
  private disposed = false;
  private subscriptions: vscode.Disposable[] = [];
  private view?: vscode.TreeView<Entry>;
  private readonly pattern = '**/*.{md,markdown,mdown,MD,MARKDOWN,MDOWN}';
  private readonly exclude = '**/{node_modules,.git,dist,build,.next,vendor}/**';
  constructor(private store: BaselineStore) {
    const watcher = vscode.workspace.createFileSystemWatcher(this.pattern);
    const schedule = (uri?: vscode.Uri) => { if (uri) this.cache.delete(uri.toString()); this.schedule(); };
    this.subscriptions.push(watcher, watcher.onDidChange(schedule), watcher.onDidCreate(schedule), watcher.onDidDelete(schedule),
      vscode.workspace.onDidChangeTextDocument(e => { if (/\.(md|markdown|mdown)$/i.test(e.document.uri.path)) schedule(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { this.cache.clear(); this.schedule(); }), store.onChange(uri => { this.cache.delete(uri); schedule(); }));
  }
  attach(view: vscode.TreeView<Entry>) { this.view = view; this.schedule(); }
  schedule() { if (this.disposed) return; clearTimeout(this.timer); this.timer = setTimeout(() => void this.refresh(), 250); }
  async refresh() {
    if (this.running) { this.again = true; return; }
    this.running = true;
    try {
      do {
        this.again = false;
        const files = await vscode.workspace.findFiles(this.pattern, this.exclude, 1001);
        const entries: Entry[] = [];
        for (const uri of files.slice(0, 1000)) {
          if (this.disposed) return;
          try {
            const key = uri.toString();
            const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
            const stat = await vscode.workspace.fs.stat(uri);
            const stamp = doc?.isDirty ? `document:${doc.version}:${doc.getText().length}` : `disk:${stat.mtime}:${stat.size}`;
            const cached = this.cache.get(key);
            if (cached?.stamp === stamp) { if (cached.entry) entries.push(cached.entry); continue; }
            if (!doc && stat.size > MAX_BYTES) throw new Error('512KBを超えるため比較できません');
            const text = await documentText(uri, doc);
            validateSize(text);
            const baseline = await this.store.ensure(uri.toString(), text);
            const count = buildReview(baseline.text, text).hunks.length;
            const entry = count ? { uri, count } : undefined;
            this.cache.set(key, { stamp, entry });
            if (entry) entries.push(entry);
          } catch (error) { entries.push({ uri, error: error instanceof Error ? error.message : String(error) }); }
        }
        const live = new Set(files.map(uri => uri.toString()));
        for (const key of this.cache.keys()) if (!live.has(key)) this.cache.delete(key);
        this.entries = entries.sort((a, b) => a.uri.path.localeCompare(b.uri.path));
        if (this.view) {
          this.view.message = files.length > 1000 ? '先頭1,000ファイルを監視中。対象フォルダーを絞ってください。' : `監視中 ${files.length}ファイル · 初回読み込み以降の変更`;
          const count = entries.filter(e => e.count).length;
          this.view.badge = { value: count, tooltip: `未確認のMarkdown ${count}ファイル` };
        }
        this.changed.fire();
      } while (this.again && !this.disposed);
    } catch (error) {
      if (this.view) this.view.message = `一覧を読み込めません: ${String(error)}`;
    } finally { this.running = false; }
  }
  getChildren() { return this.entries; }
  getTreeItem(entry: Entry) {
    const item = new vscode.TreeItem(entry.uri);
    item.description = entry.error ? '比較できません' : `${entry.count}件`;
    item.tooltip = `${vscode.workspace.asRelativePath(entry.uri)}\n${entry.error ?? `未確認 ${entry.count}件`}`;
    item.iconPath = new vscode.ThemeIcon(entry.error ? 'warning' : 'diff');
    item.command = { command: 'markdownReview.open', title: '差分を開く', arguments: [entry.uri] };
    return item;
  }
  dispose() { this.disposed = true; clearTimeout(this.timer); this.changed.dispose(); this.subscriptions.forEach(d => d.dispose()); }
}
