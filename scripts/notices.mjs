import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const dirs = execFileSync('npm', ['ls', '--omit=dev', '--parseable', '--all'], { encoding: 'utf8' }).trim().split('\n');
let result = 'Third-party notices for the bundled runtime dependencies\n\n';
for (const dir of [...new Set(dirs)].filter(d => d !== resolve('.'))) {
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  result += `\n${pkg.name} ${pkg.version} (${pkg.license})\n${'='.repeat(60)}\n`;
  for (const file of await readdir(dir, { withFileTypes: true })) {
    if (file.isFile() && /^(license|copying)/i.test(file.name)) result += await readFile(join(dir, file.name), 'utf8') + '\n';
  }
}
await writeFile('THIRD-PARTY-NOTICES.txt', result.trimEnd() + '\n');
