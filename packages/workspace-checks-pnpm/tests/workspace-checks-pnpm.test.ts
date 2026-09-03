import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { checkPnpmWorkspace } from '../src/index.js';
import { runWorkspaceChecksCli } from '../src/cli-runner.js';

const testRoot = resolve(import.meta.dirname, '..', '.tmp', 'tests');
const createdDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map((directory) => (
    rm(directory, { force: true, recursive: true })
  )));
});

test('runs package cycle checks for a pnpm workspace', async () => {
  const root = resolve(testRoot, randomUUID());
  createdDirectories.push(root);
  await mkdir(resolve(root, 'packages', 'a'), { recursive: true });
  await mkdir(resolve(root, 'packages', 'b'), { recursive: true });
  await writeFile(resolve(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf8');
  await writeFile(resolve(root, 'packages', 'a', 'package.json'), JSON.stringify({
    dependencies: { b: 'workspace:*' },
    name: 'a',
  }), 'utf8');
  await writeFile(resolve(root, 'packages', 'b', 'package.json'), JSON.stringify({
    dependencies: { a: 'workspace:*' },
    name: 'b',
  }), 'utf8');

  await expect(checkPnpmWorkspace({ cwd: root })).resolves.toEqual({
    diagnostics: [{
      checkId: 'package-cycles',
      code: 'PACKAGE_DEPENDENCY_CYCLE',
      details: { cycle: ['a', 'b', 'a'] },
    }],
    passed: false,
  });
});

test('runs successfully for a workspace with no package patterns', async () => {
  const root = resolve(testRoot, randomUUID());
  createdDirectories.push(root);
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, 'pnpm-workspace.yaml'), 'allowBuilds: {}\n', 'utf8');

  await expect(checkPnpmWorkspace({ cwd: root })).resolves.toEqual({
    diagnostics: [],
    passed: true,
  });
});

test('returns the existing structured error for an invalid workspace manifest', async () => {
  const root = resolve(testRoot, randomUUID());
  createdDirectories.push(root);
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, 'pnpm-workspace.yaml'), 'packages: invalid\n', 'utf8');

  await expect(checkPnpmWorkspace({ cwd: root })).rejects.toMatchObject({
    code: 'INVALID_WORKSPACE_MANIFEST',
  });
});

test('writes a missing workspace manifest error only to stderr with exit status two', async () => {
  const root = resolve(testRoot, randomUUID());
  createdDirectories.push(root);
  await mkdir(root, { recursive: true });
  const stdout: string[] = [];
  const stderr: string[] = [];

  await expect(runWorkspaceChecksCli(
    [],
    { stderr: (value) => stderr.push(value), stdout: (value) => stdout.push(value) },
    root,
  )).resolves.toBe(2);

  expect(stdout).toEqual([]);
  expect(stderr).toEqual(['WORKSPACE_FILE_NOT_FOUND\n']);
});

test('writes an invalid workspace manifest error only to stderr with exit status two', async () => {
  const root = resolve(testRoot, randomUUID());
  createdDirectories.push(root);
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, 'pnpm-workspace.yaml'), 'packages: invalid\n', 'utf8');
  const stdout: string[] = [];
  const stderr: string[] = [];

  await expect(runWorkspaceChecksCli(
    [],
    { stderr: (value) => stderr.push(value), stdout: (value) => stdout.push(value) },
    root,
  )).resolves.toBe(2);

  expect(stdout).toEqual([]);
  expect(stderr).toEqual(['INVALID_WORKSPACE_MANIFEST\n']);
});

test('uses --cwd to run the default package cycle rule against the requested workspace', async () => {
  const initialRoot = resolve(testRoot, randomUUID());
  const requestedRoot = resolve(testRoot, randomUUID());
  createdDirectories.push(initialRoot, requestedRoot);
  await mkdir(initialRoot, { recursive: true });
  await writeFile(resolve(initialRoot, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8');
  await mkdir(resolve(requestedRoot, 'packages', 'a'), { recursive: true });
  await mkdir(resolve(requestedRoot, 'packages', 'b'), { recursive: true });
  await writeFile(resolve(requestedRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf8');
  await writeFile(resolve(requestedRoot, 'packages', 'a', 'package.json'), JSON.stringify({
    dependencies: { b: 'workspace:*' },
    name: 'a',
  }), 'utf8');
  await writeFile(resolve(requestedRoot, 'packages', 'b', 'package.json'), JSON.stringify({
    dependencies: { a: 'workspace:*' },
    name: 'b',
  }), 'utf8');
  const stdout: string[] = [];
  const stderr: string[] = [];

  await expect(runWorkspaceChecksCli(
    ['--cwd', requestedRoot],
    { stderr: (value) => stderr.push(value), stdout: (value) => stdout.push(value) },
    initialRoot,
  )).resolves.toBe(1);

  expect(stdout).toEqual([]);
  expect(stderr).toEqual(['package-cycles PACKAGE_DEPENDENCY_CYCLE: a -> b -> a\n']);
});

test('writes the normal success result to stdout with exit status zero', async () => {
  const root = resolve(testRoot, randomUUID());
  createdDirectories.push(root);
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8');
  const stdout: string[] = [];
  const stderr: string[] = [];

  await expect(runWorkspaceChecksCli(
    [],
    { stderr: (value) => stderr.push(value), stdout: (value) => stdout.push(value) },
    root,
  )).resolves.toBe(0);

  expect(stdout).toEqual(['Workspace checks passed.\n']);
  expect(stderr).toEqual([]);
});

test('formats a package cycle once when the check option is repeated', async () => {
  const root = resolve(testRoot, randomUUID());
  createdDirectories.push(root);
  await mkdir(resolve(root, 'packages', 'a'), { recursive: true });
  await mkdir(resolve(root, 'packages', 'b'), { recursive: true });
  await writeFile(resolve(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf8');
  await writeFile(resolve(root, 'packages', 'a', 'package.json'), JSON.stringify({
    dependencies: { b: 'workspace:*' },
    name: 'a',
  }), 'utf8');
  await writeFile(resolve(root, 'packages', 'b', 'package.json'), JSON.stringify({
    dependencies: { a: 'workspace:*' },
    name: 'b',
  }), 'utf8');
  const stdout: string[] = [];
  const stderr: string[] = [];

  await expect(runWorkspaceChecksCli(
    ['--check', 'package-cycles', '--check', 'package-cycles'],
    { stderr: (value) => stderr.push(value), stdout: (value) => stdout.push(value) },
    root,
  )).resolves.toBe(1);

  expect(stdout).toEqual([]);
  expect(stderr).toEqual(['package-cycles PACKAGE_DEPENDENCY_CYCLE: a -> b -> a\n']);
});

test('returns usage statuses for help, unknown checks, and missing option values', async () => {
  const helpOutput: string[] = [];
  const errors: string[] = [];
  const output = { stderr: (value: string) => errors.push(value), stdout: (value: string) => helpOutput.push(value) };

  await expect(runWorkspaceChecksCli(['--help'], output, testRoot)).resolves.toBe(0);
  await expect(runWorkspaceChecksCli(['--check', 'unknown'], output, testRoot)).resolves.toBe(2);
  await expect(runWorkspaceChecksCli(['--cwd'], output, testRoot)).resolves.toBe(2);

  expect(helpOutput).toEqual(['Usage: forge-workspace-checks [--cwd <path>] [--check package-cycles]... [--help]\n']);
  expect(errors).toEqual([
    'UNKNOWN_CHECK: unknown\n',
    'MISSING_OPTION_VALUE: --cwd\n',
  ]);
});
