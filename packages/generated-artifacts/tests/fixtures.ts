import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const options = { pathCaseSensitivity: 'case-sensitive' } as const;
const temporaryRoot = fileURLToPath(new URL('../../../.tmp/', import.meta.url));
export async function fixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(resolve(temporaryRoot, 'generated-artifacts-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}
