# Foundation Forge Agent Collaboration Rules

## Capability boundaries

- This repository accepts only domain-neutral capabilities that can be versioned independently and have at least two independent consumers.
- Dependencies among packages must form a directed acyclic graph and follow the documented dependency direction. Reverse dependencies and dependency cycles, whether direct or transitive, are strictly forbidden.
- Do not introduce AI agent, game, room, Lobby, matchmaking, business workflow, rendering, or product-specific storage semantics.
- Core contracts must not depend on Providers. Providers may depend on Core, but Providers must not depend on one another.
- Do not introduce implicit fallbacks, automatic runtime Provider selection, or third-party implementation types in public signatures.
- Public architecture and boundary documents must describe consumers through abstract layers and roles. Do not encode specific external repository names, local paths, or current consumer topology as Foundation ownership or dependency rules. Concrete consumers may appear only in explicitly scoped migration or release evidence when that identity is required.
- `index.ts` files and public entries may only aggregate exports or perform extremely thin assembly. Protocol parsing, I/O, and stateful workflows belong in files with explicit responsibilities.

## TypeScript and text

- Source code uses NodeNext/ESM. Relative imports and exports must include their `.js` runtime suffix.
- Do not use `as unknown as` double assertions or diagnostic suppression comments to hide contract problems.
- Runtime logic produces only structured errors and diagnostics. User-facing product copy belongs to the consuming application.
- New or revised code comments, architecture documents, and delivery notes default to Simplified Chinese and must be saved as UTF-8.
- The repository README and public package READMEs use English.

## Dependencies and releases

- Repository automation must be metadata- and convention-driven. Central scripts must not duplicate package names, public entries, dependency mappings, release order, versions, or repository coordinates when they can be derived from authoritative manifests, workspace configuration, Git metadata, or workflow configuration. Irreducible package-specific verification must live with the package and be discovered by convention.
- Pin dependencies to exact versions. Public packages declare only the direct dependencies required at runtime.
- Do not commit npm tokens, authenticated `.npmrc` files, lockfiles from other package managers, or locally packed artifacts.
- Agent-generated working plans are transient artifacts. Keep them in ignored temporary storage and never force-add `docs/superpowers/` or another tool-owned planning directory to the public documentation tree.
- Do not commit, push, create tags, or publish npm packages without explicit maintainer authorization.
- Every version change requires a Changeset. Publish release candidates to `next` and stable releases to `latest`.

## Verification

- Use test-first development for features and defect fixes: observe the targeted test fail before implementing the smallest code that satisfies the contract.
- Run `pnpm check` before delivery. Lint must report zero errors and zero warnings, and tests must have no unhandled errors or asynchronous leaks.
- Verify that browser entries do not reference `node:*`, the `ws` server, or Node-only transports.
- Package verification must use real tarballs, and temporary files may exist only under the repository's ignored `.tmp/` directory.
- After changing Chinese text, scan for U+FFFD, consecutive half-width question marks, and common mojibake patterns, then confirm the text is readable.
