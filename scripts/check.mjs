import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanRoots = ['plugins', 'scripts', 'tests'].map((entry) => path.join(root, entry));
const files = [];

function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(filePath);
    else if (entry.isFile() && /\.(?:mjs|js)$/.test(entry.name)) files.push(filePath);
  }
}

for (const directory of scanRoots) if (fs.existsSync(directory)) collect(directory);
files.sort();
const failures = [];
for (const filePath of files) {
  const result = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' });
  if (result.status !== 0) {
    failures.push({ file: path.relative(root, filePath), output: `${result.stdout || ''}${result.stderr || ''}`.trim().slice(-4000) });
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`${failure.file}\n${failure.output}`);
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} JavaScript files.`);
}
