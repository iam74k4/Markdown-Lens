import * as vscode from 'vscode';
import { configureLimits } from './limits';
import { safeFolder } from './pasted-image';

export interface LensConfig {
  excludeFolders: string[]; maxFiles: number; maxFileSizeKB: number;
  initialBaseline: 'content' | 'gitHead'; newFiles: 'unreviewed' | 'reviewed';
  imageFolder: string; pollInterval: number; editorDecorations: boolean; statusBar: boolean;
  validateLinks: boolean; math: boolean; storageRetentionDays: number;
}
const defaults: LensConfig = {
  excludeFolders: ['node_modules', '.git', 'dist', 'build', '.next', 'vendor'], maxFiles: 1000, maxFileSizeKB: 512,
  initialBaseline: 'content', newFiles: 'unreviewed', imageFolder: '.markdown-lens-images', pollInterval: 1500,
  editorDecorations: true, statusBar: true, validateLinks: true, math: true, storageRetentionDays: 14,
};
const clamp = (value: unknown, min: number, max: number, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

/** Settings are validated here so the rest of the extension can trust them. */
export function config(scope?: vscode.Uri): LensConfig {
  const c = vscode.workspace.getConfiguration('markdownLens', scope);
  const folders = c.get<unknown>('excludeFolders');
  const image = c.get<unknown>('imageFolder');
  return {
    excludeFolders: Array.isArray(folders) ? folders.filter((f): f is string => typeof f === 'string' && /^[^/\\{},*?[\]]+$/.test(f)).slice(0, 100) : defaults.excludeFolders,
    maxFiles: clamp(c.get('maxFiles'), 1, 20000, defaults.maxFiles),
    maxFileSizeKB: clamp(c.get('maxFileSizeKB'), 128, 4096, defaults.maxFileSizeKB),
    initialBaseline: c.get('initialBaseline') === 'gitHead' ? 'gitHead' : 'content',
    newFiles: c.get('newFiles') === 'reviewed' ? 'reviewed' : 'unreviewed',
    imageFolder: typeof image === 'string' && safeFolder(image) ? image.replace(/[\\/]+$/, '') : defaults.imageFolder,
    pollInterval: c.get('pollInterval') === 0 ? 0 : clamp(c.get('pollInterval'), 500, 60000, defaults.pollInterval),
    editorDecorations: c.get('editorDecorations') !== false, statusBar: c.get('statusBar') !== false,
    validateLinks: c.get('validateLinks') !== false, math: c.get('math') !== false,
    storageRetentionDays: clamp(c.get('storageRetentionDays'), 0, 3650, defaults.storageRetentionDays),
  };
}
export function applyLimits(): void { configureLimits(config().maxFileSizeKB); }
export const excludeGlob = (folders: string[]) => folders.length ? `**/{${folders.join(',')}}/**` : undefined;
