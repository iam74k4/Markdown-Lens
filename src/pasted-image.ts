import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export function decodeImage(data: unknown): { bytes: Buffer; extension: string } {
  if (typeof data !== 'string' || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))) throw new Error('画像はPNG・JPEG・GIF・WebP、10MB以下で貼り付けてください。');
  const bytes = Buffer.from(data, 'base64');
  const extension = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png' : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpg' : /^GIF8[79]a/.test(bytes.subarray(0,6).toString('ascii')) ? 'gif' : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP' ? 'webp' : '';
  if (!extension || bytes.length > MAX_IMAGE_BYTES) throw new Error('対応する画像データではありません。PNG・JPEG・GIF・WebPを使用してください。');
  return { bytes, extension };
}
export async function savePastedImage(documentPath: string, roots: string[], data: unknown): Promise<string> {
  const { bytes, extension } = decodeImage(data);
  const parent = await realpath(dirname(documentPath));
  const allowed = await Promise.all(roots.map(root => realpath(root)));
  const inside = (path: string) => allowed.some(root => { const p = relative(root, path); return p !== '..' && !p.startsWith('..' + sep) && !isAbsolute(p); });
  if (!inside(parent)) throw new Error('ワークスペース内のMarkdownで画像を貼り付けてください。');
  const folder = join(parent, '.markdown-lens-images');
  await mkdir(folder, { recursive: true });
  const actual = await realpath(folder);
  if (!inside(actual) || actual !== folder) throw new Error('画像の保存先にシンボリックリンクは使えません。');
  const name = randomUUID() + '.' + extension;
  await writeFile(join(actual, name), bytes, { flag: 'wx', mode: 0o600 });
  return './.markdown-lens-images/' + name;
}
