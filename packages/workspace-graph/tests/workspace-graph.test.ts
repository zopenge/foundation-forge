import { expect, test } from 'vitest';

import {
  createWorkspaceGraph,
  findWorkspaceCycles,
  listReachableWorkspacePackages,
  sortWorkspacePackages,
} from '../src/index.js';

test('sorts dependencies before dependents for explicitly selected dependency kinds', () => {
  const graph = createWorkspaceGraph([
    {
      dependencies: [
        { kind: 'dependencies', name: '@scope/core', specifier: 'workspace:^' },
        { kind: 'devDependencies', name: '@scope/test-kit', specifier: 'workspace:^' },
      ],
      name: '@scope/app',
      relativeDirectory: 'apps/app',
    },
    { dependencies: [], name: '@scope/core', relativeDirectory: 'packages/core' },
    { dependencies: [], name: '@scope/test-kit', relativeDirectory: 'packages/test-kit' },
  ]);

  expect(sortWorkspacePackages(graph, { dependencyKinds: ['dependencies'] }))
    .toEqual(['@scope/core', '@scope/app', '@scope/test-kit']);
  expect(sortWorkspacePackages(graph, {
    dependencyKinds: ['dependencies', 'devDependencies'],
  })).toEqual(['@scope/core', '@scope/test-kit', '@scope/app']);
});

test('reports unresolved workspace protocol dependencies without treating external packages as errors', () => {
  const graph = createWorkspaceGraph([{
    dependencies: [
      { kind: 'dependencies', name: '@scope/missing', specifier: 'workspace:^' },
      { kind: 'dependencies', name: 'external', specifier: '^1.0.0' },
    ],
    name: '@scope/app',
    relativeDirectory: 'apps/app',
  }]);

  expect(graph.diagnostics).toEqual([{
    code: 'UNRESOLVED_WORKSPACE_DEPENDENCY',
    dependencyName: '@scope/missing',
    kind: 'dependencies',
    packageName: '@scope/app',
    specifier: 'workspace:^',
  }]);
});

test('finds a canonical package cycle and prevents topological sorting', () => {
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
  const options = { dependencyKinds: ['dependencies'] as const };

  expect(findWorkspaceCycles(graph, options)).toEqual([['a', 'b', 'a']]);
  expect(() => sortWorkspacePackages(graph, options)).toThrowError(
    expect.objectContaining({ code: 'CYCLE_DETECTED' }),
  );
});

test('lists the selected roots and their reachable dependencies in topological order', () => {
  const graph = createWorkspaceGraph([
    {
      dependencies: [{ kind: 'dependencies', name: 'core', specifier: 'workspace:*' }],
      name: 'app',
      relativeDirectory: 'app',
    },
    { dependencies: [], name: 'core', relativeDirectory: 'core' },
    { dependencies: [], name: 'other', relativeDirectory: 'other' },
  ]);

  expect(listReachableWorkspacePackages(graph, ['app'], {
    dependencyKinds: ['dependencies'],
  })).toEqual(['core', 'app']);
});

test('rejects duplicate package names with a structured error', () => {
  expect(() => createWorkspaceGraph([
    { dependencies: [], name: 'duplicate', relativeDirectory: 'one' },
    { dependencies: [], name: 'duplicate', relativeDirectory: 'two' },
  ])).toThrowError(expect.objectContaining({ code: 'DUPLICATE_PACKAGE_NAME' }));
});
