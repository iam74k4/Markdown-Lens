import { build } from 'esbuild';
await build({ entryPoints: ['src/extension.ts'], bundle: true, outfile: 'dist/extension.js', external: ['vscode'], platform: 'node', target: 'node20', format: 'cjs', minify: true, legalComments: 'inline' });
await build({ entryPoints: ['src/webview.ts'], bundle: true, outfile: 'media/webview.js', platform: 'browser', target: 'chrome120', format: 'iife', minify: true, legalComments: 'inline' });
