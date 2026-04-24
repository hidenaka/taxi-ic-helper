import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadJson(relPath) {
  return JSON.parse(readFileSync(join(root, relPath), 'utf8'));
}
