# @openge/forge-repository-context

Pure, deterministic repository context planning and validation primitives for Node.js and browsers.

## Install

```sh
pnpm add --save-exact @openge/forge-repository-context@0.1.0-rc.1
```

## Select a bounded context

```ts
import { buildRepositoryContextSelection } from '@openge/forge-repository-context';

const selection = buildRepositoryContextSelection({
  profile: {
    id: 'compact', impactScope: 'local', maxSourceFiles: 2,
    maxSymbols: 1, symbolScope: 'local',
  },
  requiredContextFiles: ['route.json'],
  localContextFiles: ['near.json', 'route.json'],
  sourceFiles: ['entry.ts', 'entry.ts', 'contract.ts'],
  symbols: ['Entry', 'Contract'],
});
// selection.sourceFiles: ['entry.ts', 'contract.ts']
```

## Contracts

- `createRepositoryContextRegistry({ profiles, recipes })` validates identifiers, profile references, limits, scopes and recipe string arrays. It returns copied profiles and recipes in readonly maps. Duplicate identifiers and unknown profiles fail explicitly.
- `stableUniqueRepositoryContextValues(values)` preserves the first occurrence and does not sort or mutate input. Consumers filter or rank candidates before calling it.
- `buildRepositoryContextSelection(options)` places required context first, selects local/global candidates by impact scope, deduplicates before truncation and suppresses symbols for scope `none` or a zero limit. Symbol visibility filtering belongs to the caller.
- `buildRepositoryContextImpactSlice({ nodes, rootIds })` returns reachable nodes sorted by identifier, includes roots, terminates on cycles and rejects duplicate or reached unknown identifiers. It copies returned node arrays.
- `calculateRepositoryContextReductionPercent(baseline, loaded)` returns a nonnegative percentage rounded to two decimals, with zero for a zero baseline. Negative and non-finite inputs fail.
- `evaluateRepositoryContextBudget({ policy, metrics })` returns structured `{ code, actual, limit }` diagnostics. Limits are nonnegative safe integers; percentage bounds are inclusive from 0 to 100. A configured threshold requires its corresponding metric. Diagnostic order is source files, symbols, repository reduction, subsystem reduction, global avoidance.
- `serializeRepositoryContextJson(value)` delegates strict JSON validation and UTF-16 code-unit key ordering to Deterministic JSON, using two-space indentation and one trailing newline.
- `compareRepositoryContextOutputs({ expected, current })` compares string maps after CRLF/CR/LF normalization and returns sorted `missing`, `stale`, `unexpected` paths plus `ok`. A null current value means missing. No files are read or written.
- `normalizeRepositoryContextNewlines(value)` normalizes a string to LF.

Validation failures use `RepositoryContextError` with a stable `code` and structured `details`; strict JSON failures retain the underlying serializer error. Applications own diagnostic wording.

## Ownership

This package has no filesystem discovery, parser, tokenizer, command runner, telemetry, query engine or runtime provider selection. Consumers own identifiers, semantic rules, candidate ranking, file access, output schemas and paths, and quality thresholds. Its runtime dependencies are `@openge/forge-deterministic-json` and the runtime-neutral core of `@openge/forge-generated-artifacts`. Generic comparison is delegated internally without imposing artifact filesystem path rules on caller-owned output keys. Filesystem publication remains in Generated Artifacts `/node`.

## License

Apache-2.0. See LICENSE and NOTICE.
