# Maintainer Release Runbook

Foundation Forge publishes from GitHub Actions through npm Trusted Publishing.
Routine releases use short-lived OIDC credentials, produce npm provenance, and
do not require a local npm login or a long-lived `NPM_TOKEN`.

## Repository configuration

The following settings are required:

- GitHub Actions workflow permissions are set to **Read and write**.
- **Allow GitHub Actions to create and approve pull requests** is enabled.
- The GitHub `npm` environment exists and applies the required maintainer
  approval policy.
- Every npm package trusts this publisher:
  - organization: `zopenge`
  - repository: `foundation-forge`
  - workflow: `release.yml`
  - environment: `npm`
  - permission: publish

The release workflow must retain `contents: write`, `pull-requests: write`, and
`id-token: write`. It must not read an npm publishing token.

## Publish a release candidate

1. Set each changed package manifest to the intended prerelease version and
   retain its Changeset for the eventual stable release.
2. Run `pnpm check` on the exact commit to be released.
3. Merge `dev` into `main` and wait for the push-triggered Release run to update
   the Changesets Version PR.
4. In GitHub Actions, open **Release**, select **Run workflow**, choose `main`,
   and start the run.
5. Confirm that the manual run:
   - verifies that at least one publishable package is a prerelease;
   - runs the complete repository check;
   - publishes only missing versions in dependency-safe order to `next`;
   - signs npm provenance through GitHub OIDC;
   - pushes the lightweight package tags with `git push origin --tags`.

Package publication is idempotent. Re-running the same commit skips versions
already present in npm and verifies that their package tags already exist. It
must fail when a published version has no tag instead of guessing which commit
to tag. A successful job is not sufficient evidence by itself: verify registry
metadata, dist-tags, provenance, and remote Git tags before migrating consumers.

## Publish a stable release

1. Review the Changesets Version PR and confirm package versions, changelogs,
   internal dependency ranges, and the absence of unintended packages.
2. Merge the Version PR into `main`.
3. The push-triggered Release workflow runs `pnpm release`, publishes missing
   stable versions to `latest`, creates provenance, and reports every newly
   created package tag through the Changesets v2 `CHANGESETS_OUTPUT` NDJSON
   file. Changesets Action then pushes those tags and creates GitHub Releases.
4. Verify npm and GitHub before updating consumers.

Do not manually publish a stable version and do not dispatch the prerelease
path with stable unpublished manifests; the prerelease guard rejects that
state.

## Bootstrap a new npm package once

npm does not allow a Trusted Publisher to be configured before the package
exists. The first package version is therefore a one-time exception:

1. From a clean, reviewed, tagged `main` commit, build and pack the new package
   under the ignored `.tmp/` directory.
2. Publish `0.1.0-rc.0` to `next` with maintainer authentication, 2FA, public
   access, and no repository token. Consumers must not adopt this bootstrap
   version.
3. Configure Trusted Publishing. The verified command is:

   ```sh
   npx --yes npm@11.19.1 trust github @openge/<package> \
     --file release.yml \
     --repo zopenge/foundation-forge \
     --env npm \
     --allow-publish \
     --yes
   ```

   npm 10 does not provide `npm trust`. Use the pinned npm 11 command above for
   this one-time configuration. Do not enable stage-only mode, because staged
   promotion would reintroduce an interactive release step.
4. Change the package to `0.1.0-rc.1`, merge it into `main`, and publish it with
   the normal GitHub workflow before any consumer adopts the package.
5. After OIDC provenance is verified, disallow traditional publishing tokens
   for the package where npm settings permit it.

Only the first package creation and publisher registration may require
interactive npm authentication. Later release candidates and stable releases
must use GitHub Actions.

## Verification checklist

For every published package and version, confirm:

- the expected version exists at `https://registry.npmjs.org/<encoded-name>`;
- `next` or `latest` points to the intended version;
- `dist.integrity` is present;
- `dist.attestations.provenance.predicateType` is
  `https://slsa.dev/provenance/v1`;
- the matching `<package>@<version>` tag exists on the remote and points to the
  released commit;
- a clean consumer can install the actual tarball and import all public entries.

npm may report that a newly published package is still being processed. If the
publish log contains the successful package line and signed provenance, wait
for registry propagation and query the canonical npm registry again. Do not
republish with another version merely to work around propagation delay.

## Failure rules

- If Changesets cannot create or update its Version PR, recheck the repository
  Actions permissions before changing workflow code.
- If `npm trust` is unknown, use the pinned npm 11 command from the bootstrap
  section; do not add an npm token as a workaround.
- If package tags are missing, confirm the workflow uses `git push origin
  --tags` for manually dispatched prereleases. `--follow-tags` does not push
  the lightweight tags created by the release script.
- If Changesets Action warns that it failed to read `CHANGESETS_OUTPUT`, npm
  publication may have succeeded while stable tags and GitHub Releases were
  skipped. The custom publish script must initialize that file and append one
  NDJSON event per newly published package in this exact shape:

  ```json
  {"type":"git-tag","tag":"@openge/example@1.2.3","packageName":"@openge/example"}
  ```

  Do not paper over this warning with a general post-action tag push: the Action
  needs these events to identify packages and create GitHub Releases. If npm
  already contains the version, recover the exact source commit from its
  provenance attestation and repair only the missing tag; never attach a
  published version to the current commit by assumption.
- If any package publish, provenance, tarball, or consumer verification fails,
  stop downstream migrations. Fix the root cause and rerun the idempotent
  workflow; do not unpublish a package or silently move a dist-tag.
