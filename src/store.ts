import { mkdir, readFile, readdir, rename, writeFile, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ReviewView, reviewView } from './review-view';
import { hash, validateSize } from './core';
import { t } from './i18n';

const SUFFIXES = ['', '.snapshots', '.draft', '.view'] as const;

export interface Baseline { uri: string; text: string; updatedAt: string; version: 1 }
export interface Draft { text: string; baseText: string }
export interface Snapshot { id: string; text: string; createdAt: string }
export class BaselineStore {
  private listeners = new Set<(uri: string) => void>();
  private initializing = new Map<string, Promise<Baseline>>();
  constructor(private readonly directory: string) {}
  onChange(listener: (uri: string) => void) { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }
  ensure(uri: string, text: string): Promise<Baseline> {
    const running = this.initializing.get(uri);
    if (running) return running;
    const work = (async () => await this.load(uri) ?? await this.save(uri, text))();
    this.initializing.set(uri, work);
    void work.finally(() => this.initializing.delete(uri)).catch(() => {});
    return work;
  }
  private path(uri: string) { return join(this.directory, `${hash(uri)}.json`); }
  async load(uri: string): Promise<Baseline | undefined> {
    let raw: string;
    try { raw = await readFile(this.path(uri), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const value = JSON.parse(raw) as Baseline;
    if (!value || value.version !== 1 || value.uri !== uri || typeof value.text !== 'string' || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
      throw new Error(t('保存された比較元を読み込めません。現在のファイルは変更していません。'));
    }
    validateSize(value.text);
    return value;
  }
  async save(uri: string, text: string): Promise<Baseline> {
    validateSize(text);
    await mkdir(this.directory, { recursive: true });
    const value: Baseline = { uri, text, updatedAt: new Date().toISOString(), version: 1 };
    const temp = `${this.path(uri)}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
      await rename(temp, this.path(uri));
    } finally { await unlink(temp).catch(() => {}); }
    this.listeners.forEach(listener => listener(uri));
    return value;
  }
  async snapshots(uri: string): Promise<Snapshot[]> {
    let raw: string;
    try { raw = await readFile(this.path(uri) + '.snapshots', 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const value = JSON.parse(raw);
    if (!value || value.uri !== uri || !Array.isArray(value.items) || value.items.length > 20) throw new Error(t('スナップショットを読み込めません。'));
    for (const item of value.items) {
      if (!item || typeof item.createdAt !== 'string' || typeof item.id !== 'string' || typeof item.text !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) throw new Error(t('スナップショットを読み込めません。'));
      validateSize(item.text);
    }
    return value.items;
  }
  async snapshot(uri: string, text: string): Promise<Snapshot> {
    validateSize(text);
    const items = await this.snapshots(uri);
    // Never silently evict an editing checkpoint.
    if (items.length >= 20) throw new Error(t('スナップショットは20件までです。不要なスナップショットを削除してください。'));
    const item = { id: randomUUID(), text, createdAt: new Date().toISOString() };
    await this.writeSnapshots(uri, [item, ...items]);
    return item;
  }
  async deleteSnapshot(uri: string, id: string) {
    await this.writeSnapshots(uri, (await this.snapshots(uri)).filter(item => item.id !== id));
  }
  private async writeSnapshots(uri: string, items: Snapshot[]) {
    await mkdir(this.directory, { recursive: true });
    const path = this.path(uri) + '.snapshots', temp = path + '.' + randomUUID();
    try { await writeFile(temp, JSON.stringify({ uri, items }), { mode: 0o600 }); await rename(temp, path); }
    finally { await unlink(temp).catch(() => {}); }
  }
  async loadDraft(uri: string): Promise<Draft | undefined> {
    let raw: string;
    try { raw = await readFile(this.path(uri) + '.draft', 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const value = JSON.parse(raw);
    if (!value || typeof value.text !== 'string' || typeof value.baseText !== 'string') throw new Error(t('編集中の下書きを読み込めません。'));
    validateSize(value.text); validateSize(value.baseText);
    return value;
  }
  async saveDraft(uri: string, draft: Draft): Promise<void> {
    validateSize(draft.text); validateSize(draft.baseText);
    await mkdir(this.directory, { recursive: true });
    const path = this.path(uri) + '.draft', temp = path + '.' + randomUUID();
    try { await writeFile(temp, JSON.stringify(draft), { mode: 0o600 }); await rename(temp, path); }
    finally { await unlink(temp).catch(() => {}); }
  }
  async loadView(uri: string): Promise<ReviewView | undefined> {
    try { return reviewView(JSON.parse(await readFile(this.path(uri) + '.view', 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return; throw error; }
  }
  async saveView(uri: string, value: unknown): Promise<void> {
    const view = reviewView(value); if (!view) return;
    await mkdir(this.directory, { recursive: true });
    const path = this.path(uri) + '.view', temp = path + '.' + randomUUID();
    try { await writeFile(temp, JSON.stringify(view), { mode: 0o600 }); await rename(temp, path); }
    finally { await unlink(temp).catch(() => {}); }
  }
  /** Every stored baseline, for renames of folders and storage clean-up. */
  async entries(): Promise<{ uri: string; updatedAt: string }[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const result: { uri: string; updatedAt: string }[] = [];
    for (const name of names.filter(n => /^[0-9a-f]{64}\.json$/.test(n))) {
      try {
        const value = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as Partial<Baseline>;
        if (typeof value.uri === 'string' && typeof value.updatedAt === 'string' && hash(value.uri) + '.json' === name) result.push({ uri: value.uri, updatedAt: value.updatedAt });
      } catch { /* A damaged entry is reported when that file is opened. */ }
    }
    return result;
  }
  /** Carry the baseline, draft, snapshots and view of a renamed file. Never overwrites. */
  async move(from: string, to: string): Promise<boolean> {
    if (from === to) return false;
    const baseline = await this.load(from).catch(() => undefined);
    if (!baseline || await this.load(to).catch(() => true)) return false;
    await mkdir(this.directory, { recursive: true });
    await this.writeAtomic(this.path(to), JSON.stringify({ ...baseline, uri: to }));
    const snapshots = await this.snapshots(from).catch(() => []);
    if (snapshots.length) await this.writeSnapshots(to, snapshots);
    for (const suffix of ['.draft', '.view'] as const) {
      try { await rename(this.path(from) + suffix, this.path(to) + suffix); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await this.remove(from);
    this.listeners.forEach(listener => { listener(from); listener(to); });
    return true;
  }
  async remove(uri: string): Promise<void> {
    for (const suffix of SUFFIXES) {
      try { await unlink(this.path(uri) + suffix); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  /** Bytes used by stored review data. */
  async size(): Promise<number> {
    let names: string[]; try { names = await readdir(this.directory); } catch { return 0; }
    let total = 0; for (const name of names) total += await stat(join(this.directory, name)).then(s => s.size, () => 0);
    return total;
  }
  private async writeAtomic(path: string, content: string): Promise<void> {
    const temp = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temp, content, { mode: 0o600 }); await rename(temp, path); }
    finally { await unlink(temp).catch(() => {}); }
  }
  async clearDraft(uri: string): Promise<void> {
    try { await unlink(this.path(uri) + '.draft'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
