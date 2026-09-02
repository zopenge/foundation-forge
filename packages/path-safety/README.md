# `@openge/forge-path-safety`

Cross-runtime portable relative-path validation and explicit Node.js root
containment.

## Installation

```sh
pnpm add @openge/forge-path-safety
```

## Usage

```ts
import {
  normalizePortableRelativePath,
  validatePortableRelativePath,
} from '@openge/forge-path-safety';
import {
  resolveExistingPathWithinRoot,
  resolvePathWithinRoot,
} from '@openge/forge-path-safety/node';

const logicalPath = normalizePortableRelativePath('assets\\atlas.json');
validatePortableRelativePath(logicalPath);

const outputPath = resolvePathWithinRoot(outputRoot, logicalPath);
const existingPath = await resolveExistingPathWithinRoot(inputRoot, logicalPath);
```

The root entry accepts canonical slash-separated relative paths and has no
Node.js or third-party runtime dependencies. It rejects absolute paths, drive
paths, UNC and device paths, NUL bytes, empty segments, and traversal segments.

`resolvePathWithinRoot` provides lexical containment only and does not claim to
prevent symbolic-link escapes. Use `resolveExistingPathWithinRoot` when both the
root and target already exist and realpath containment is required.

## License

Licensed under the Apache License 2.0.
