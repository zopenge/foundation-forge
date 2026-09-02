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
- Update the English public documentation when its contract changes.

Commits should be concise and describe the resulting change. Maintainers may ask
for commits to be reorganized before merge when independent release units are
mixed together.

## Maintainer release process

Maintainers must follow the verified
[release runbook](docs/maintenance/releases.md). Routine prerelease and stable
publishing runs entirely in GitHub Actions through npm Trusted Publishing. Do
not add a long-lived npm token to the repository or GitHub secrets.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
