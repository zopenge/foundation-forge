# `@openge/forge-workspace-pnpm`

Explicit pnpm workspace discovery Provider for `@openge/forge-workspace-graph`.

## Installation

```sh
pnpm add -D @openge/forge-workspace-graph @openge/forge-workspace-pnpm
```

## Usage

```ts
import { readPnpmWorkspace } from '@openge/forge-workspace-pnpm';

const graph = await readPnpmWorkspace({ cwd: process.cwd() });
```

This Node.js provider reads an explicitly selected `pnpm-workspace.yaml`,
expands its package patterns, and converts package manifests into the neutral
workspace graph contract. Missing or malformed inputs produce structured
`WorkspacePnpmError` instances.

There is no package-manager auto-detection or fallback. Manifest editing,
lockfile changes, build scheduling, and publishing remain outside this package.

## License

Licensed under the Apache License 2.0.
