# `@openge/forge-workspace-graph`

Deterministic workspace package dependency graphs without filesystem or package-manager coupling.

## Installation

```sh
pnpm add -D @openge/forge-workspace-graph
```

## Usage

```ts
import { createWorkspaceGraph, sortWorkspacePackages } from '@openge/forge-workspace-graph';

const graph = createWorkspaceGraph([
  { dependencies: [], name: '@example/core', relativeDirectory: 'packages/core' },
  {
    dependencies: [{ kind: 'dependencies', name: '@example/core', specifier: 'workspace:^' }],
    name: '@example/app',
    relativeDirectory: 'apps/app',
  },
]);

const order = sortWorkspacePackages(graph, { dependencyKinds: ['dependencies'] });
```

The package provides stable ordering, cycle detection, reachable-package
selection, duplicate-name errors, and diagnostics for unresolved `workspace:`
dependencies. It performs no filesystem access and does not run builds,
releases, or package-manager commands.

## License

Licensed under the Apache License 2.0.
