import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const manifestPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.codex-plugin', 'plugin.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (typeof manifest.version !== 'string' || !manifest.version.trim()) throw new Error(`Invalid plugin version in ${manifestPath}`);

export const PLUGIN_VERSION = manifest.version;
