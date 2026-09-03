# `@openge/forge-workspace-checks`

Pure, deterministic checks for neutral workspace dependency graphs.

## Installation

```sh
pnpm add -D @openge/forge-workspace-checks
```

## Usage

```ts
import { createPackageCycleCheck, runWorkspaceChecks } from '@openge/forge-workspace-checks';

const report = runWorkspaceChecks(graph, [createPackageCycleCheck()]);
```

The package performs no filesystem access or package-manager discovery. Its
checks consume caller-provided graphs and return structured diagnostics.

## License

Licensed under the Apache License 2.0.
