# @openge/forge-config-bundle

Deterministic, manifest-backed ZIP bundles with explicit Node.js import planning, backup, and best-effort rollback. File selection, secret scanning, CLI behavior, and product rules belong to the caller.

## Format and core usage

The reserved manifest path is `__forge_config_bundle__/manifest.json`. All other entries must be files with portable relative paths outside `__forge_config_bundle__/`. Absolute paths, traversal, backslashes, NUL/control characters, Windows device names, alternate data streams, trailing dots/spaces, duplicate paths, and file/ancestor collisions are rejected.

Manifest V1 contains `schemaVersion: 1`, a caller-supplied ISO 8601 UTC `createdAt`, and sorted `entries` with `path`, `byteLength`, and a lowercase SHA-256 hex digest. JSON uses deterministic key ordering, UTF-8, and a single final LF. Unknown schema versions and archives without the manifest have distinct structured errors.

~~~ts
import { createConfigBundle, decodeConfigBundle } from '@openge/forge-config-bundle';

const archive = await createConfigBundle([
  { path: 'settings/preferences.json', content: new TextEncoder().encode('{"enabled":true}\n') },
], { createdAt: '2026-09-04T00:00:00.000Z' });
const bundle = await decodeConfigBundle(archive);
~~~

The same entry bytes, paths, `createdAt`, and package versions produce identical ZIP bytes regardless of input order. ZIP metadata has a fixed 1980 timestamp and fixed default attributes; compression is DEFLATE level 6. The library never reads the current time. The core entry uses Web Crypto SHA-256 and imports no Node.js APIs.

Default limits apply to business entries: 256 files, 4 MiB per file, and 16 MiB total expanded content. The archive limit is 20 MiB. The manifest has a separate 1 MiB bound and consumes one additional ZIP entry. Create/decode accept positive safe-integer limit overrides. Decode validates ZIP metadata, paths, entry count, and declared expanded sizes before decompression, then requires an exact manifest/entry set and verifies every size and digest.

## Node.js import

~~~ts
import { inspectConfigBundleImport, applyConfigBundleImport } from '@openge/forge-config-bundle/node';

const root = '/absolute/configuration-root';
const options = {
  conflictPolicy: 'backup-and-overwrite',
  pathCaseSensitivity: 'case-insensitive',
  backupDirectory: '/absolute/configuration-root/backups/import-001',
} as const;
const plan = await inspectConfigBundleImport(root, bundle, options);
if (plan.conflicts.length === 0) {
  const result = await applyConfigBundleImport(root, bundle, options);
  // Interpret diagnostics and rollbackFailures before reporting success.
}
~~~

Roots must be explicit absolute paths. Case sensitivity must be chosen as `case-sensitive` or `case-insensitive`; it is never inferred from the operating system. Choose the policy matching the target filesystem. Insensitive mode reports all case aliases, including ancestor spelling and existing disk entries, before writing. Sensitive mode compares portable paths exactly; it does not make an insensitive filesystem case-sensitive.

The plan classifies each file as `create`, `unchanged`, or `overwrite`. Identical regular files are unchanged and retain their modification time. Directories, symlinks/junctions, and other non-regular targets are always refused. Existing root and ancestor components are also checked for links.

- `reject`: collect all differing existing-file conflicts and apply nothing.
- `overwrite`: replace differing regular files after preflight.
- `backup-and-overwrite`: require a caller-chosen backup root and preserve the old bytes before publication. Backup relative paths mirror the target paths. A backup directory inside the target root is allowed when its generated backup files and directory do not overlap any bundle target. Existing backup files are never replaced; callers choose a fresh backup root for each import.

The caller must inspect diagnostics even after obtaining a plan. Apply enforces the default content limits, repeats preflight, and copies/revalidates the decoded manifest and content rather than trusting a cached plan or mutable caller-owned bytes. Each changed file is staged in its destination directory and closed before any target is published. Backups are exclusively created and completed before publication. Publication uses same-directory atomic rename per file; the operation is not an atomic transaction across multiple files.

On failure, diagnostics identify `preflight` (no writes), `staging`, `backup`, `commit`, `rollback`, or `cleanup`. After a commit failure, previously overwritten files are restored and newly created files removed where possible. `created` and `overwritten` audit successful publication attempts; `restoredAfterFailure` records successful undo operations. Every unsuccessful undo appears in `rollbackFailures`. Completed backups remain available after failure. Temporary files and newly created empty directories are cleaned up where safe, with cleanup failures reported separately. Files outside the bundle are not modified.

Safety checks repeat around reads, staging, and publication, including actual file identities and content. Portable Node.js path APIs cannot eliminate the final race between a check and a filesystem operation, especially when another process can rename ancestors. Callers must exclude concurrent writers and prevent untrusted modification of root/ancestor directories for the duration of an import. This is not a sandbox or a crash-recovery journal. The package does not manage permissions, ownership, or ACLs.

## Upgrade and ownership

Legacy archives without Manifest V1 return `CONFIG_BUNDLE_UNSUPPORTED_LEGACY_FORMAT`; they are not guessed or converted automatically. Re-export through the owning application's supported migration flow before switching formats. Secret inspection and file selection run in the consumer before invoking this package. Inspect throws `ConfigBundleError` for invalid inputs or unsafe targets; apply returns auditable diagnostics for those same preflight failures.
