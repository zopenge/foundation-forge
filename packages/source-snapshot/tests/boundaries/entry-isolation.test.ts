import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const specifierPattern = /(?:\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\))/gu;
const specifiers = (source: string): string[] => [...source.matchAll(specifierPattern)]
  .map(match => match[1] ?? match[2])
  .filter((value): value is string => value !== undefined);

const visit = async (path: string, visited: Set<string>, imports: string[]): Promise<void> => {
  if (visited.has(path)) return;
  visited.add(path);
  const source = await readFile(path, 'utf8');
  for (const specifier of specifiers(source)) {
    imports.push(specifier);
    if (!specifier.startsWith('.')) continue;
    const tsPath = resolve(dirname(path), specifier.replace(/\.js$/u, '.ts'));
    await visit(tsPath, visited, imports);
  }
};

test('runtime-neutral root source graph has no Node, ws or node-subpath dependency', async () => {
  const imports: string[] = [];
  await visit(join(packageRoot, 'src', 'index.ts'), new Set(), imports);
  expect(imports.filter(value => value.startsWith('node:') || value === 'ws')).toEqual([]);
  expect(imports.filter(value => value === './node.js' || value.endsWith('/node'))).toEqual([]);

  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    exports?: Record<string, { browser?: unknown }>; files?: unknown;
  };
  expect(manifest.exports?.['./node']?.browser).toBeNull();
  const verify = JSON.parse(await readFile(join(packageRoot, 'package.verify.json'), 'utf8')) as { browserExports?: unknown };
  expect(verify.browserExports).toEqual(['.']);
});
