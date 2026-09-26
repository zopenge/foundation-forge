import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

describe('repository policy package boundaries', () => {
  it('keeps the root entrypoint free of Node re-exports', async () => {
    const source = await readFile(join(packageRoot, 'src', 'index.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"].*node/u);
    expect(source).not.toContain("from './node");
  });

  it('marks only the explicit /node export as browser-incompatible', async () => {
    const manifest = JSON.parse(
      await readFile(join(packageRoot, 'package.json'), 'utf8'),
    );
    expect(manifest.exports['.'].browser).toBeUndefined();
    expect(manifest.exports['./node'].browser).toBeNull();
  });

  it('contains no command execution or network client imports in Node implementation', async () => {
    const nodeDir = join(packageRoot, 'src', 'node');
    const files = (await readdir(nodeDir))
      .filter((name) => name.endsWith('.ts'));
    const sources = await Promise.all(files.map(async (name) => ({
      name,
      text: await readFile(join(nodeDir, name), 'utf8'),
    })));
    for (const { name, text } of sources) {
      expect(text, name).not.toMatch(
        /node:(?:child_process|http|https|net|dns)|\bfetch\s*\(/u,
      );
    }
  });

  it('declares the CLI bin at the compiled Node entrypoint', async () => {
    const manifest = JSON.parse(
      await readFile(join(packageRoot, 'package.json'), 'utf8'),
    );
    expect(manifest.bin).toEqual({
      'forge-repository-policy': './dist/node/cli.js',
    });
  });
});
