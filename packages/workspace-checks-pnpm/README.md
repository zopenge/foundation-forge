# `@openge/forge-workspace-checks-pnpm`

pnpm workspace checks command-line assembly and integration facade.

## Installation

```sh
pnpm add -D @openge/forge-workspace-checks-pnpm
```

## CLI

```sh
forge-workspace-checks --cwd . --check package-cycles
```

The command returns 0 when checks pass, 1 for findings, and 2 for invalid
arguments or workspace read errors. It reads only the requested pnpm workspace
and does not modify workspace files or lockfiles.

## Programmatic usage

```ts
import { checkPnpmWorkspace } from '@openge/forge-workspace-checks-pnpm';

const report = await checkPnpmWorkspace({ cwd: process.cwd() });
```

`checkPnpmWorkspace({ cwd, workspaceFile?, checks? })` uses the built-in
`package-cycles` rule when `checks` is omitted. The facade assembles the CLI
and Core checks; `@openge/forge-workspace-pnpm` remains the pnpm Provider.

## License

Licensed under the Apache License 2.0.
