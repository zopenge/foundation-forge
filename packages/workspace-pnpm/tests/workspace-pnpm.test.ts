import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { readPnpmWorkspace } from '../src/index.js';

const testRoot = resolve(import.meta.dirname, '..', '.tmp', 'tests');
const createdDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map((directory) => (
    rm(directory, { force: true, recursive: true })
  )));
});

test('reads pnpm members and preserves tagged dependency declarations deterministically', async () => {
  const root = resolve(testRoot, randomUUID());
  createdDirectories.push(root);
  await mkdir(resolve(root, 'packages', 'app'), { recursive: true });
  await mkdir(resolve(root, 'packages', 'core'), { recursive: true });
  await mkdir(resolve(root, 'packages', 'groups', 'tool'), { recursive: true });
  await mkdir(resolve(root, 'packages', 'ignored'), { recursive: true });
  await writeFile(resolve(root, 'pnpm-workspace.yaml'), [
    'packages:',
    '  - "packages/*"',
    '  - "packages/groups/*"',
    '  - "!packages/ignored"',
    '',
  ].join('\n'), 'utf8');
  await writeFile(resolve(root, 'packages', 'app', 'package.json'), JSON.stringify({
    name: '@scope/app',
    dependencies: { '@scope/core': 'workspace:^', external: '^1.0.0' },
    devDependencies: { test: '^2.0.0' },
  }), 'utf8');
  await writeFile(resolve(root, 'packages', 'core', 'package.json'), JSON.stringify({
    name: '@scope/core',
  }), 'utf8');
  await writeFile(resolve(root, 'packages', 'groups', 'tool', 'package.json'), JSON.stringify({
    name: '@scope/tool',
  }), 'utf8');
  await writeFile(resolve(root, 'packages', 'ignored', 'package.json'), JSON.stringify({
    name: '@scope/ignored',
  }), 'utf8');

  const graph = await readPnpmWorkspace({ cwd: root });

  expect(graph).toEqual({
    diagnostics: [],
    packages: [
      {
        dependencies: [
          { kind: 'dependencies', name: '@scope/core', specifier: 'workspace:^' },
          { kind: 'dependencies', name: 'external', specifier: '^1.0.0' },
          { kind: 'devDependencies', name: 'test', specifier: '^2.0.0' },
        ],
        name: '@scope/app',
        relativeDirectory: 'packages/app',
      },
      { dependencies: [], name: '@scope/core', relativeDirectory: 'packages/core' },
      { dependencies: [], name: '@scope/tool', relativeDirectory: 'packages/groups/tool' },
    ],
  });
});

test('treats an object workspace manifest without packages as an empty workspace', async () => {
  const root = resolve(testRoot, randomUUID());
  createdDirectories.push(root);
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, 'pnpm-workspace.yaml'), 'allowBuilds: {}\n', 'utf8');
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'root-package' }), 'utf8');

  await expect(readPnpmWorkspace({ cwd: root })).resolves.toEqual({
    diagnostics: [],
    packages: [],
  });
});
