# Contributing to Foundation Forge

Thank you for helping improve Foundation Forge. Contributions must preserve the
domain-neutral boundaries documented in
[docs/architecture/boundaries.md](docs/architecture/boundaries.md).

## Development workflow

1. Fork the repository and create a focused branch from `main`.
2. Install Node.js 22.14.0 or newer and pnpm 10.33.2.
3. Run `pnpm install --frozen-lockfile`.
4. Add a failing test for behavior changes, then implement the smallest complete change.
5. Add a Changeset with `pnpm changeset` for every published-package change.
6. Run `pnpm check` before opening a pull request.

## Pull requests

- Keep each pull request focused on one capability or correction.
- Explain the public contract, affected packages, tests, and compatibility impact.
- Do not mix consumer migrations with Foundation Forge implementation changes.
- Do not commit credentials, generated tarballs, coverage output, or another package manager's lockfile.
- Update English and Simplified Chinese root documentation together when their shared contract changes.

Commits should be concise and describe the resulting change. Maintainers may ask
for commits to be reorganized before merge when independent release units are
mixed together.

## Maintainer release process

The first release of each new npm package must be performed from a clean, tagged
`main` commit with a maintainer login and 2FA. Publish in this order:

```sh
pnpm --filter @openge/forge-peer-network publish --access public --tag next
pnpm --filter @openge/forge-peer-network-libp2p publish --access public --tag next
pnpm --filter @openge/forge-peer-network-websocket publish --access public --tag next
```

Using pnpm here is intentional: it resolves `workspace:^` to the packed Core
version. Do not add a long-lived npm token to the repository or GitHub secrets.

After all three package pages exist, configure the same npm Trusted Publisher
for each package:

- Organization: `zopenge`
- Repository: `foundation-forge`
- Workflow: `release.yml`
- Environment: `npm`
- Allowed action: npm publish

Require maintainer approval on the GitHub `npm` environment. Then use the
manually dispatched `publish-next.yml` workflow for prereleases on the `next`
dist-tag. Stable version PRs and `latest` publication are managed by
`release.yml`. Both OIDC workflows install npm 12 and publish with provenance;
they do not use an npm token.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
