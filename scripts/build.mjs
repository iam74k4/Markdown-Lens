import { build } from 'esbuild';
import { rm, readFile, writeFile } from 'node:fs/promises';
await build({ entryPoints: ['src/extension.ts'], bundle: true, outfile: 'dist/extension.js', external: ['vscode'], platform: 'node', target: 'node20', format: 'cjs', minify: true, legalComments: 'inline' });
// KaTeX fonts: browsers choose WOFF2, so the larger legacy formats are not shipped.
await rm('media/fonts', { recursive: true, force: true });
await build({ entryPoints: ['src/webview.ts'], bundle: true, outfile: 'media/webview.js', platform: 'browser', target: 'chrome120', format: 'iife', minify: true, legalComments: 'inline',
  loader: { '.woff2': 'file', '.woff': 'empty', '.ttf': 'empty' }, assetNames: 'fonts/[name]-[hash]' });
const css = await readFile('media/webview.css', 'utf8');
await writeFile('media/webview.css', css.replace(/,\s*url\(\)\s*format\("[^"]+"\)/g, ''));
