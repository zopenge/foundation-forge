import { rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(packageRoot, 'dist');
if (basename(target) !== 'dist' || dirname(target) !== packageRoot) {
  throw new Error('refusing to clean an unexpected path');
}
await rm(target, { recursive: true, force: true });
