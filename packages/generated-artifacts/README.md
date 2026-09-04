# @openge/forge-generated-artifacts

Explicit generated file plans, deterministic comparison, and safe Node.js publication.

The root entry is runtime-neutral. The `./node` entry provides filesystem inspection and publication and is unavailable under the `browser` condition. The only runtime dependency is `@openge/forge-path-safety`.

## Pure planning and comparison

```ts
import {
  defineGeneratedArtifactPlan,
  compareGeneratedArtifactSnapshot,
} from '@openge/forge-generated-artifacts';

const plan = defineGeneratedArtifactPlan({
  artifacts: [{ path: 'generated/index.txt', content: 'ready\n' }],
  retiredPaths: ['generated/old.txt'],
});
const comparison = compareGeneratedArtifactSnapshot(plan, [
  { path: 'generated/index.txt', content: new TextEncoder().encode('ready\n') },
]);
// { ok: true, missing: [], stale: [], retiredPresent: [] }
```

Plans copy caller arrays, definitions, and byte buffers. Paths and result arrays use UTF-16 code-unit sorting. Paths must already be portable relative paths with forward slashes; absolute paths, traversal, empty segments, backslashes, Windows device names, alternate data streams, and trailing dots or spaces are rejected. Unpaired UTF-16 surrogates in paths are rejected by the shared path validator; valid surrogate pairs are preserved. No ambiguous input path is silently repaired.

String content is UTF-8. Bytes use exact comparison. Set `comparison: 'normalize-newlines'` on a string artifact to compare CRLF and CR as LF. This preserves whitespace, byte order marks, and the presence or absence of a final newline. Invalid UTF-8 snapshots remain stale. Binary artifacts cannot request text normalization. Publication always writes the supplied content using UTF-8 encoding for strings, including the standard replacement of unpaired surrogates, without changing newline sequences. Comparison applies that same UTF-8 encoding to expected text.

## Node.js publication

```ts
import { defineGeneratedArtifactPlan } from '@openge/forge-generated-artifacts';
import {
  inspectGeneratedArtifacts,
  publishGeneratedArtifacts,
} from '@openge/forge-generated-artifacts/node';

const plan = defineGeneratedArtifactPlan({
  artifacts: [{ path: 'generated/index.txt', content: 'ready\n' }],
  retiredPaths: ['generated/old.txt'],
});
const rootDirectory = '/absolute/project/root';
const options = { pathCaseSensitivity: 'case-sensitive' } as const;
const before = await inspectGeneratedArtifacts(rootDirectory, plan, options);
const result = await publishGeneratedArtifacts(rootDirectory, plan, options);
// result: { written, unchanged, removed, diagnostics }
```

The root must be an explicit absolute path. Callers must select `case-sensitive` or `case-insensitive`; the package never guesses from the platform. Case-insensitive conflicts across expected and retired paths fail before any filesystem access. The selected policy validates the plan; it does not change the filesystem's native case behavior.

File/ancestor conflicts across all expected and retired paths (such as `a` and `a/b`) are rejected before any filesystem access with `GENERATED_ARTIFACT_PATH_CONFLICT`, using the selected case policy. All explicit targets are preflighted before publication. Any existing symlink or junction at a target or ancestor, including the root and its ancestors, is rejected. Expected and retired targets must be regular files when present. Required parent directories are created, and unchanged files keep their modification time.

Each changed file is written to a unique, exclusively created temporary file in its target directory, flushed, closed, and renamed. Target and ancestor checks run again immediately before rename and each retired deletion. Expected write failures stop publication before any retired deletion. Publication never recursively deletes directories and never scans or removes files outside the explicit plan.

Validation and preflight failures throw `GeneratedArtifactError` with stable `code` and `details`. Failures after publication begins are returned in `diagnostics`; `written`, `unchanged`, and `removed` describe completed work. A failed write leaves the previous version of that file intact. Earlier successful writes are not rolled back: this is atomic publication per file, not a transaction across the whole plan. Failed retired deletions are reported individually while other explicit retired deletions continue.

Temporary files are cleaned after ordinary failures. If an adversarial ancestor replacement makes cleanup unsafe, cleanup is refused and the diagnostic includes `details.cleanupFailed`. Repeated path checks reduce replacement races but cannot provide an operating-system-level filesystem sandbox. Callers must control concurrent directory mutations. There is no cross-process locking, automatic retry, or durability guarantee for the containing directory after a system crash.

## Ownership and boundaries

A plan owns only its explicit expected files and retired paths. Unlisted snapshot files do not produce an `unexpected` diagnostic. Discovery of obsolete files, directory ownership policies, and application-specific normalization stay with the consuming layer.

`@openge/forge-repository-context` may depend on this lower-level package for comparison; this package does not depend on repository context. It provides no repository discovery, output schema, fast-state cache, CLI, watcher, or product workflow.
