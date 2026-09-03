import { expect, test } from 'vitest';

import { createWorkspaceGraph } from '@openge/forge-workspace-graph';
import type { WorkspaceDependencyKind } from '@openge/forge-workspace-graph';

import {
  createPackageCycleCheck,
  runWorkspaceChecks,
  WorkspaceChecksError,
  type WorkspaceCheck,
} from '../src/index.js';

test('reports canonical package dependency cycles through the package-cycles check', () => {
  const graph = createWorkspaceGraph([
    {
      dependencies: [{ kind: 'dependencies', name: 'b', specifier: 'workspace:*' }],
      name: 'a',
      relativeDirectory: 'a',
    },
    {
      dependencies: [{ kind: 'dependencies', name: 'a', specifier: 'workspace:*' }],
      name: 'b',
      relativeDirectory: 'b',
    },
  ]);

  expect(runWorkspaceChecks(graph, [createPackageCycleCheck()])).toEqual({
    diagnostics: [{
      checkId: 'package-cycles',
      code: 'PACKAGE_DEPENDENCY_CYCLE',
      details: { cycle: ['a', 'b', 'a'] },
    }],
    passed: false,
  });
});

test('uses only explicitly selected dependency kinds for package cycle checks', () => {
  const graph = createWorkspaceGraph([
    {
      dependencies: [{ kind: 'devDependencies', name: 'b', specifier: 'workspace:*' }],
      name: 'a',
      relativeDirectory: 'a',
    },
    {
      dependencies: [{ kind: 'devDependencies', name: 'a', specifier: 'workspace:*' }],
      name: 'b',
      relativeDirectory: 'b',
    },
  ]);

  expect(runWorkspaceChecks(graph, [createPackageCycleCheck({
    dependencyKinds: ['dependencies'],
  })])).toEqual({ diagnostics: [], passed: true });
});

test('passes the default package cycle check for an acyclic workspace graph', () => {
  const graph = createWorkspaceGraph([
    {
      dependencies: [{ kind: 'dependencies', name: 'core', specifier: 'workspace:*' }],
      name: 'app',
      relativeDirectory: 'app',
    },
    { dependencies: [], name: 'core', relativeDirectory: 'core' },
  ]);

  expect(runWorkspaceChecks(graph, [createPackageCycleCheck()])).toEqual({
    diagnostics: [],
    passed: true,
  });
});

test.each([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const)('detects a %s cycle with the default package cycle check', (kind) => {
  const graph = createWorkspaceGraph([
    {
      dependencies: [{ kind, name: 'b', specifier: 'workspace:*' }],
      name: 'a',
      relativeDirectory: 'a',
    },
    {
      dependencies: [{ kind, name: 'a', specifier: 'workspace:*' }],
      name: 'b',
      relativeDirectory: 'b',
    },
  ]);

  expect(runWorkspaceChecks(graph, [createPackageCycleCheck()])).toEqual({
    diagnostics: [{
      checkId: 'package-cycles',
      code: 'PACKAGE_DEPENDENCY_CYCLE',
      details: { cycle: ['a', 'b', 'a'] },
    }],
    passed: false,
  });
});

test('aggregates findings from custom checks in deterministic diagnostic order', () => {
  const graph = createWorkspaceGraph([]);
  const checks: readonly WorkspaceCheck[] = [
    {
      id: 'z-check',
      run: () => [{ code: 'LATE', details: { position: 2 } }],
    },
    {
      id: 'a-check',
      run: () => [
        { code: 'SECOND', details: { position: 2 } },
        { code: 'FIRST', details: { position: 1 } },
      ],
    },
  ];

  expect(runWorkspaceChecks(graph, checks)).toEqual({
    diagnostics: [
      { checkId: 'a-check', code: 'FIRST', details: { position: 1 } },
      { checkId: 'a-check', code: 'SECOND', details: { position: 2 } },
      { checkId: 'z-check', code: 'LATE', details: { position: 2 } },
    ],
    passed: false,
  });
});

test('projects diagnostics so a structural check cannot override its check id', () => {
  const spoofedFinding = { checkId: 'spoofed-check', code: 'FINDING', details: {} };
  const check: WorkspaceCheck = {
    id: 'actual-check',
    run: () => [spoofedFinding],
  };

  expect(runWorkspaceChecks(createWorkspaceGraph([]), [check])).toEqual({
    diagnostics: [{ checkId: 'actual-check', code: 'FINDING', details: {} }],
    passed: false,
  });
});

test('rejects duplicate check ids before invoking an earlier throwing check', () => {
  const duplicateId = 'duplicate';
  const throwingCheck: WorkspaceCheck = {
    id: duplicateId,
    run: () => {
      throw new Error('CHECK_RAN');
    },
  };
  const duplicateCheck: WorkspaceCheck = { id: duplicateId, run: () => [] };

  expect(() => runWorkspaceChecks(createWorkspaceGraph([]), [throwingCheck, duplicateCheck]))
    .toThrowError(expect.objectContaining({ code: 'DUPLICATE_CHECK_ID' }));
});

test('rejects BigInt check finding details with a structured workspace checks error', () => {
  const details = Object.create(null);
  Object.assign(details, { value: 1n });
  const check: WorkspaceCheck = {
    id: 'invalid-details',
    run: () => [{ code: 'INVALID', details }],
  };

  expect(() => runWorkspaceChecks(createWorkspaceGraph([]), [check]))
    .toThrowError(expect.objectContaining({ code: 'INVALID_CHECK_FINDING_DETAILS' }));
});

test('rejects circular check finding details with a structured workspace checks error', () => {
  const details = Object.create(null);
  Object.assign(details, { parent: details });
  const check: WorkspaceCheck = {
    id: 'circular-details',
    run: () => [{ code: 'INVALID', details }],
  };

  expect(() => runWorkspaceChecks(createWorkspaceGraph([]), [check]))
    .toThrowError(expect.objectContaining({ code: 'INVALID_CHECK_FINDING_DETAILS' }));
});

test('uses canonical JSON details to deterministically sort otherwise colliding diagnostics', () => {
  const check: WorkspaceCheck = {
    id: 'same-check',
    run: () => [
      { code: 'SAME', details: { b: 1, a: 2 } },
      { code: 'SAME', details: { b: 2, a: 1 } },
    ],
  };

  const report = runWorkspaceChecks(createWorkspaceGraph([]), [check]);

  expect(report.diagnostics.map((diagnostic) => diagnostic.details)).toEqual([
    { b: 2, a: 1 },
    { b: 1, a: 2 },
  ]);
});

test('copies package cycle dependency kinds so later caller mutation cannot change the check', () => {
  const dependencyKinds: WorkspaceDependencyKind[] = ['devDependencies'];
  const check = createPackageCycleCheck({ dependencyKinds });
  dependencyKinds.splice(0, 1, 'dependencies');
  const graph = createWorkspaceGraph([
    {
      dependencies: [{ kind: 'devDependencies', name: 'b', specifier: 'workspace:*' }],
      name: 'a',
      relativeDirectory: 'a',
    },
    {
      dependencies: [{ kind: 'devDependencies', name: 'a', specifier: 'workspace:*' }],
      name: 'b',
      relativeDirectory: 'b',
    },
  ]);

  expect(runWorkspaceChecks(graph, [check]).passed).toBe(false);
});

test('rejects duplicate check ids with a structured error', () => {
  const graph = createWorkspaceGraph([]);
  const check = createPackageCycleCheck();

  expect(() => runWorkspaceChecks(graph, [check, check])).toThrowError(
    expect.objectContaining({ code: 'DUPLICATE_CHECK_ID' }),
  );
  expect(() => runWorkspaceChecks(graph, [check, check])).toThrowError(WorkspaceChecksError);
});
