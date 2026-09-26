import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NodePolicyOptions } from '../../src/node.js';
import { sampleManifest, sampleRequest } from './sample.js';

export interface NodePolicyFixture {
  readonly root: string;
  readonly options: NodePolicyOptions;
  write(path: string, text: string): Promise<void>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

export const withPolicyFixture = async (
  action: (fixture: NodePolicyFixture) => Promise<void>,
): Promise<void> => {
  const cache = fileURLToPath(
    new URL('../../../../.tmp/policy-tests/', import.meta.url),
  );
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, 'fixture-'));
  const targetFor = (path: string): string => join(root, ...path.split('/'));
  const writeBytes = async (
    path: string,
    bytes: Uint8Array,
  ): Promise<void> => {
    const target = targetFor(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  };
  const write = async (path: string, text: string): Promise<void> => {
    await writeBytes(path, Buffer.from(text, 'utf8'));
  };
  const remove = async (path: string): Promise<void> => {
    await rm(targetFor(path), { recursive: true, force: true });
  };

  try {
    await write(
      '.forge/repository-policy.json',
      JSON.stringify(sampleManifest),
    );
    await write('rules/base.md', 'base\n');
    await write('rules/api.md', 'api\n');
    await write(
      'package.json',
      JSON.stringify({ scripts: { lint: 'echo lint' } }),
    );
    await action({
      root,
      options: {
        root,
        manifestPath: '.forge/repository-policy.json',
        request: sampleRequest,
      },
      write,
      writeBytes,
      remove,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
