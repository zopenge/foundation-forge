# `@openge/forge-repository-policy`

Deterministic, runtime-neutral repository policy selection and validation primitives.

The root entrypoint validates repository-policy manifests and resolves caller-declared path/fact evidence without Node.js I/O, AI providers, authorization decisions, or consumer-specific semantics.

## Runtime-neutral API

`validatePolicyManifest()`, `evaluatePolicyCondition()`, and `resolvePolicies()` operate on already validated in-memory inputs. Missing or suggested facts remain unknown; explicit dependencies and conflicts are preserved in the resolution.

## Node.js API

Import `@openge/forge-repository-policy/node` for read-only repository access:

- `checkPolicyRepository()` validates a strict JSON manifest, source files, and declared package-script references without executing commands.
- `resolvePolicyBundle()` returns required/candidate source text, raw-byte SHA-256 identities, and a deterministic bundle digest.
- `preparePolicyRepository()` creates an explicit read session for repeated resolution. It fixes the root, manifest, and limits at preparation and caches each successfully read policy source.

The Node entrypoint rejects invalid UTF-8, duplicate JSON keys, source paths outside the declared root, unsafe aliases, source changes during reads, and configured input-limit violations.

```ts
import { preparePolicyRepository } from '@openge/forge-repository-policy/node';

const prepared = await preparePolicyRepository({
  root: '.',
  manifestPath: '.forge/repository-policy.json',
  preload: 'policy-sources',
});
if (prepared.ok) {
  const bundle = await prepared.repository.resolve({
    schemaVersion: 1,
    contextId: 'example',
    scope: { paths: [], complete: false },
    facts: [],
    evidence: [],
  });
  console.log(bundle.resolution.state);
}
```

Without `preload`, source text is captured on its first successful resolution. With `preload: 'policy-sources'`, every policy source is read before preparation succeeds. Both modes retain strict source validation; preloading also enforces the total source budget. Preparation does not check package-script targets; use `checkPolicyRepository()` for that validation.

A prepared session does not watch files or refresh cached content. Create a new session, or use `resolvePolicyBundle()`, to observe subsequent edits. The manifest and source reads are not an atomic filesystem snapshot; source digests identify the returned bytes, not the current repository state. Returned documents do not expose mutable cache identities. Read sessions remain caller-owned in-memory objects and can be released by dropping their references.

## CLI

```sh
forge-repository-policy check --root . --manifest .forge/repository-policy.json
forge-repository-policy resolve --root . --manifest .forge/repository-policy.json --input - --delivery inline
forge-repository-policy resolve --root . --manifest .forge/repository-policy.json --input request.json --delivery references
```

`resolve` accepts `--max-output-bytes` with a minimum of 1024 bytes and a default of 128 KiB. Output is JSON only. Exit 0 means ready inline delivery, exit 2 means unresolved/references/budget-limited delivery, and exit 1 means invalid input, conflict, or source/check failure.

The package does not execute repository commands, access the network, infer authorization, or claim that a host or model actually read or obeyed returned policies.

Licensed under the Apache License 2.0.
