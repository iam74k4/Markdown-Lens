import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { t } from './i18n';
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** A relative folder below the document; never absolute, never escaping with `..`. */
export function safeFolder(value: string): boolean {
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return value.trim() !== '' && value.length <= 200 && !/^([/\\]|[a-z]:)/i.test(value) && parts.length > 0 && parts.every(part => part !== '..' && part !== '.' && !/[\0<>:"|?*]/.test(part));
}
export function decodeImage(data: unknown): { bytes: Buffer; extension: string } {
  if (typeof data !== 'string' || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))) throw new Error(t('画像はPNG・JPEG・GIF・WebP、10MB以下で貼り付けてください。'));
  const bytes = Buffer.from(data, 'base64');
  const extension = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png' : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpg' : /^GIF8[79]a/.test(bytes.subarray(0,6).toString('ascii')) ? 'gif' : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP' ? 'webp' : '';
  if (!extension || bytes.length > MAX_IMAGE_BYTES) throw new Error(t('対応する画像データではありません。PNG・JPEG・GIF・WebPを使用してください。'));
  return { bytes, extension };
}
export async function savePastedImage(documentPath: string, roots: string[], data: unknown, folderName = '.markdown-lens-images'): Promise<string> {
  if (!safeFolder(folderName)) throw new Error(t('画像の保存先は文書からの相対フォルダーで指定してください。'));
  const { bytes, extension } = decodeImage(data);
  const parent = await realpath(dirname(documentPath));
  const allowed = await Promise.all(roots.map(root => realpath(root)));
  const inside = (path: string) => allowed.some(root => { const p = relative(root, path); return p !== '..' && !p.startsWith('..' + sep) && !isAbsolute(p); });
  if (!inside(parent)) throw new Error(t('ワークスペース内のMarkdownで画像を貼り付けてください。'));
  const folder = join(parent, ...folderName.split(/[\\/]+/).filter(Boolean));
  await mkdir(folder, { recursive: true });
  const actual = await realpath(folder);
  if (!inside(actual) || actual !== folder) throw new Error(t('画像の保存先にシンボリックリンクは使えません。'));
  const name = randomUUID() + '.' + extension;
  await writeFile(join(actual, name), bytes, { flag: 'wx', mode: 0o600 });
  return './' + folderName.split(/[\\/]+/).filter(Boolean).map(encodeURIComponent).join('/') + '/' + name;
}
