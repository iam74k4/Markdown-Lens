import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, validateSize } from './core';

export interface Baseline { uri: string; text: string; updatedAt: string; version: 1 }
export interface Draft { text: string; baseText: string }
export class BaselineStore {
  constructor(private readonly directory: string) {}
  private path(uri: string) { return join(this.directory, `${hash(uri)}.json`); }
  async load(uri: string): Promise<Baseline | undefined> {
    let raw: string;
    try { raw = await readFile(this.path(uri), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const value = JSON.parse(raw) as Baseline;
    if (value.version !== 1 || value.uri !== uri || typeof value.text !== 'string' || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
      throw new Error('保存された比較元を読み込めません。現在のファイルは変更していません。');
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
    return value;
  }
  async loadDraft(uri: string): Promise<Draft | undefined> {
    let raw: string;
    try { raw = await readFile(this.path(uri) + '.draft', 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const value = JSON.parse(raw);
    if (typeof value.text !== 'string' || typeof value.baseText !== 'string') throw new Error('編集中の下書きを読み込めません。');
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
  async clearDraft(uri: string): Promise<void> {
    try { await unlink(this.path(uri) + '.draft'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
