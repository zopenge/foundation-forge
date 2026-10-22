import { describe, expect, it } from 'vitest';
import { validateReleaseConfig } from '../src/node/config.js';
import { parseArguments } from '../src/cli-arguments.js';

export const workspaceConfig = {
  schemaVersion: 2,
  source: { mode: 'workspace' },
  git: { remote: 'origin', repository: 'github.com/fixture/repository', developmentBranch: 'dev', releaseBranch: 'main' },
  vercel: { teamId: 'team_fixture', projectId: 'prj_fixture', productionUrl: 'https://fixture.example.invalid' },
  checks: [{ command: 'node', args: ['-e', 'process.exit(0)'] }],
  acceptance: [{ command: 'node', args: ['-e', 'process.exit(0)'] }],
  buildInfo: { path: '/build-info.json', revisionField: 'revision' },
  limits: { commandMs: 10000, deploymentMs: 1000, pollMs: 20, requestMs: 1000, maxOutputBytes: 4096 },
};
export const managedConfig = { ...workspaceConfig, source: {
  mode: 'managed-commit', slotPath: '.tmp/release-slot', maxBytes: 2147483648, minFreeBytes: 5368709120,
  sampleIntervalMs: 1000, install: { packageManager: 'pnpm' }, prepare: [],
} };

describe('schema 2 source contracts', () => {
  it('accepts explicit workspace and managed-commit sources', () => {
    expect(validateReleaseConfig(workspaceConfig)).toEqual(workspaceConfig);
    expect(validateReleaseConfig(managedConfig)).toEqual(managedConfig);
  });
  it.each([
    { ...workspaceConfig, schemaVersion: 1 },
    { ...managedConfig, source: { ...managedConfig.source, maxBytes: 0 } },
    { ...managedConfig, source: { ...managedConfig.source, minFreeBytes: -1 } },
    { ...managedConfig, source: { ...managedConfig.source, sampleIntervalMs: 249 } },
    { ...managedConfig, source: { ...managedConfig.source, sampleIntervalMs: 5001 } },
    { ...managedConfig, source: { ...managedConfig.source, slotPath: '../escape' } },
    { ...managedConfig, source: { ...managedConfig.source, slotPath: '/absolute' } },
    { ...managedConfig, source: { ...managedConfig.source, slotPath: '.git/slot' } },
    { ...managedConfig, source: { ...managedConfig.source, install: { packageManager: 'npm' } } },
    { ...managedConfig, source: { ...managedConfig.source, prepare: [{ command: 'cmd.exe', unknown: true }] } },
    { ...workspaceConfig, source: { mode: 'workspace', ignoreUntracked: true } },
  ])('rejects ambiguous or unsafe configuration %#', config => {
    expect(() => validateReleaseConfig(config)).toThrow('CONFIG_INVALID');
  });
  it('accepts recover without permitting SHA publication or a recovery SHA override', () => {
    expect(parseArguments(['recover']).command).toBe('recover');
    for (const command of ['check', 'publish', 'recover']) {
      expect(() => parseArguments([command, '--sha', 'a'.repeat(40)])).toThrow('ARGUMENT_INVALID');
    }
  });
});
