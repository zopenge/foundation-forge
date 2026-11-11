import type { PrebuiltDeliveryConfig, ReleaseConfig } from '../../src/contracts.js';

export function prebuiltConfiguration(): Omit<ReleaseConfig, 'delivery'> & { delivery: PrebuiltDeliveryConfig } {
  return {
    schemaVersion: 2, source: { mode: 'managed-commit', slotPath: 'state/release-slot', maxBytes: 2 ** 31,
      minFreeBytes: 2 ** 30, sampleIntervalMs: 250, install: { packageManager: 'pnpm' }, prepare: [] },
    delivery: { mode: 'prebuilt', maxFiles: 10_000, maxBytes: 268_435_456,
      concurrencyControl: { mode: 'external-serialization', scope: 'fixture-project' },
      admission: [{ command: 'node', args: ['admission.mjs'] }] },
    git: { remote: 'origin', repository: 'github.com/fixture/repository', developmentBranch: 'dev', releaseBranch: 'main' },
    vercel: { teamId: 'team_fixture', projectId: 'prj_fixture', productionUrl: 'https://fixture.example.invalid' },
    checks: [{ command: 'node', args: ['check.mjs'] }], acceptance: [{ command: 'node', args: ['acceptance.mjs'] }],
    buildInfo: { path: '/build-info.json', revisionField: 'revision' },
    limits: { commandMs: 10_000, deploymentMs: 100, pollMs: 10, requestMs: 50, maxOutputBytes: 4096 },
  };
}
