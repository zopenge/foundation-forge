# @openge/forge-text-integrity

Runtime-neutral text corruption inspection with explicit Node.js filesystem,
Git, and CLI adapters. The package has no third-party runtime dependencies.

```sh
pnpm add -D @openge/forge-text-integrity
```

Use the root entry when you already have text in memory:

```ts
import { inspectTextIntegrity } from '@openge/forge-text-integrity';

const issues = inspectTextIntegrity(source, { filePath: 'src/example.ts' });
```

Use the Node.js entry to scan paths or the current Git change set:

```ts
import {
  scanChangedTextIntegrityFiles,
  scanTextIntegrityPaths,
} from '@openge/forge-text-integrity/node';

const repositoryIssues = await scanTextIntegrityPaths(['src', 'docs']);
const changedIssues = await scanChangedTextIntegrityFiles();
```

The CLI accepts either explicit paths or `--changed`, but never both:

```sh
forge-text-integrity src docs
forge-text-integrity --changed
```

The default line marker `check-mojibake-ignore-line` suppresses an intentional
match on that line. Markdown inline code spans are ignored by default.

Licensed under the Apache License 2.0.
