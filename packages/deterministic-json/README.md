# `@openge/forge-deterministic-json`

Strict deterministic JSON validation, sorting, and serialization without
runtime dependencies.

## Installation

```sh
pnpm add @openge/forge-deterministic-json
```

## Usage

```ts
import { stringifyDeterministicJson } from '@openge/forge-deterministic-json';

const output = stringifyDeterministicJson(
  { z: 1, a: 2 },
  { space: 2, trailingNewline: true },
);
```

Objects are copied with code-unit-sorted keys and arrays retain their original
order. The package rejects values whose JSON identity would otherwise be
ambiguous, including cycles, sparse arrays, accessors, custom prototypes,
`undefined`, bigint, and non-finite numbers.

This package does not claim RFC canonical JSON compatibility. It defines the
smaller strict contract documented by its exported types and errors.

## License

Licensed under the Apache License 2.0.
