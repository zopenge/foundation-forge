# `@openge/forge-repository-files`

Deterministic, read-only Git repository file discovery for Node.js tooling.

## Installation

```sh
pnpm add @openge/forge-repository-files
```

## Usage

```ts
import {
  listChangedRepositoryFiles,
  listRepositoryFiles,
} from '@openge/forge-repository-files';

const allFiles = await listRepositoryFiles({ cwd: process.cwd() });
const changedFiles = await listChangedRepositoryFiles({ cwd: process.cwd() });
```

Returned paths are repository-relative, slash-normalized, deduplicated, and
sorted deterministically. Changed-file discovery includes untracked files and
rename or copy targets while excluding deleted paths by default.

The package never mutates a repository and never falls back to an implicit
filesystem walk when Git is unavailable.

## License

Licensed under the Apache License 2.0.
