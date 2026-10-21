# @openge/forge-release-vercel

Explicit Git integration releases with bounded checks, fixed commit selection, and independent Vercel production verification. Node.js >=22.14.0 and Git are required. Configure the existing Vercel Git integration to deploy the release branch to production before using this package.

```sh
pnpm add -D @openge/forge-release-vercel
pnpm exec forge-vercel-release check
pnpm exec forge-vercel-release login
pnpm exec forge-vercel-release publish
pnpm exec forge-vercel-release status
pnpm exec forge-vercel-release verify --sha <full-40-character-sha>
```

## Configuration

The default file is `release.config.json`, relative to `--cwd` (default: the current directory). All fields below are required. Unknown fields are rejected. Commands run in the repository root, without a shell. On Windows, `node`, `pnpm`, and `npm` resolve to their JavaScript entrypoints; `.cmd` and `.bat` executables are rejected. Other executables must be directly spawnable.

```json
{
  "schemaVersion": 1,
  "git": {
    "remote": "origin",
    "repository": "github.com/example/site",
    "developmentBranch": "dev",
    "releaseBranch": "main"
  },
  "vercel": {
    "teamId": "team_example",
    "projectId": "prj_example",
    "productionUrl": "https://site.example.com"
  },
  "checks": [{ "command": "pnpm", "args": ["run", "check"], "timeoutMs": 600000 }],
  "acceptance": [{ "command": "pnpm", "args": ["run", "verify:production"], "timeoutMs": 120000 }],
  "buildInfo": { "path": "/build-info.json", "revisionField": "revision" },
  "limits": {
    "commandMs": 600000,
    "deploymentMs": 600000,
    "pollMs": 5000,
    "requestMs": 30000,
    "maxOutputBytes": 65536
  }
}
```

`repository` identifies the declared fetch and push repository, independently of the remote name. HTTPS, SSH and SCP-style Git URLs normalize to `host[:port]/owner/repository`; local paths and file URLs preserve their actual directory names, including `.git`. Each remote must have exactly one declared fetch URL and at most one explicit push URL, both matching this identity; absent push URL means the declared fetch URL. Credential-bearing HTTPS URLs are rejected. Git's existing transport routing (including `url.*.insteadOf`), credentials and hooks remain trusted caller configuration; checking declared URLs does not replace that trust. Branches must differ. `productionUrl` must be an HTTPS origin with no credentials, path, port, query or fragment. `buildInfo.path` is a same-origin absolute path; `revisionField` is a top-level JSON property containing the full commit SHA.

Both command arrays contain 1–32 entries. Each entry accepts only `command`, optional `args` (up to 128 arguments), and optional `timeoutMs`. Times are positive safe integers: commands and deployment waits are capped at one hour, requests at five minutes, and `pollMs` cannot exceed `deploymentMs`. Command-specific timeouts are capped by `commandMs`. Output is bounded per stream to `maxOutputBytes` (at most 1 MiB); configured job output may be truncated, while truncated Git/API protocol output fails closed. Add `.tmp/` to the consuming repository's ignore rules.

Acceptance commands receive `FORGE_RELEASE_SHA`, `FORGE_RELEASE_URL`, and `FORGE_RELEASE_DEPLOYMENT_ID`. They own application-specific assertions. The public build marker must be deployed from source and contain the same full SHA as the Git deployment; do not fabricate it during verification.

## Commands and side effects

| Command | Behavior |
| --- | --- |
| `check` | Verify root, remote, clean development branch, run checks, and confirm HEAD/source/config remain frozen. No remote writes or Vercel requests. |
| `publish` | Acquire an exclusive local project lock; freeze HEAD; fetch and validate both remote branches as ancestors of that SHA; authenticate and check project ownership, repository link and production branch; run checks; revalidate the candidate and remotes; check project binding and lock ownership before each ordinary, non-force, exact-SHA push to development then release branch; wait for the matching authoritative Git integration production deployment to become READY; verify alias, anonymous build marker, and acceptance jobs. |
| `status` | Read a deployment for `--sha`, otherwise the latest publish receipt's frozen SHA, otherwise local HEAD if no receipt exists. Returns deployment state; successful querying alone does not imply READY. No checks, acceptance, or pushes. |
| `verify` | Independently query project and deployment, require READY and correct Git source, then verify production alias, anonymous build marker, and acceptance jobs. Uses the same SHA selection as `status`. No pushes. |
| `login` | Explicitly delegate to the pinned official Vercel CLI and let the user authorize it. No release config is required. Bounded to ten minutes. The CLI prints login instructions to stderr. |

Options are `--cwd DIR`, `--config FILE`, and `--sha SHA` (only `status`/`verify`). `--help` prints JSON usage. Standard output is one structured JSON report. Exit codes: `0` successful command, `1` operational failure, `2` invalid CLI arguments. SIGINT/SIGTERM cancel active work and release owned locks. No command automatically commits, switches branches, force-pushes, creates/uploads deployments, rolls back, or rewrites history. The only Vercel API requests are GET requests through `vercel api --raw --non-interactive`, using the official CLI session. Missing authentication returns `AUTH_REQUIRED`; only `login` initiates login.

Same-SHA reruns issue ordinary exact-SHA pushes and let the Git server report up-to-date refs through porcelain output; they never skip a push based on an earlier local snapshot. They find existing deployments and never request another deployment or upload. If a Git push succeeds and a later step fails, that success is retained in `effects`; an ambiguous push is `unknown` and requires inspecting remote state. The next publish re-fetches state before continuing. After the release ref is pushed, `recovery.nextCommand` recommends independent verification of the exact SHA.

Project binding checks compare the configured repository and production branch against `project.link`. Deployment details are requested with `withGitRepoInfo=true`; only authoritative `gitSource` provider, repository identifier, SHA and ref establish source identity. GitHub custom-host identity additionally binds the normalized host and port from both link and source; the same repository ID on a different host is rejected. Deployment `source` metrics and caller-supplied `meta` never establish provenance; list metadata only locates detail candidates. Supported Git links are GitHub (including limited/custom-host variants), GitLab and Bitbucket. Missing authoritative identity and unsupported providers fail closed.

## Node API and entries

```ts
import type { ReleaseConfig } from '@openge/forge-release-vercel';
import { runRelease, validateReleaseConfig } from '@openge/forge-release-vercel/node';

const config: ReleaseConfig = validateReleaseConfig(configurationValue);
const report = await runRelease({
  command: 'verify', cwd: repositoryRoot, config,
  sha: candidateSha, signal: abortController.signal,
});
if (!report.ok) console.error(report.error);
```

The root exports only contracts and `releaseErrorCodes`, and is browser-safe. `./node` is explicitly `browser: null` and exports `runRelease`, `validateReleaseConfig`, and `ReleaseError`. `runRelease` accepts `command`, `cwd`, optional `config` or `configPath`, `sha`, `signal`, `transport`, and `onLoginOutput`. Config objects take precedence over files and are cloned/validated. `transport` explicitly supplies `api(path, signal)` and anonymous `buildInfo(url, signal)` operations for controlled external boundaries; implementations must honor abort signals. `onLoginOutput` receives redacted official login output. The CLI supplies this callback; Node callers must supply it to display login instructions live.

Reports include schema version, timestamps, candidate SHA, config SHA-256, bounded job steps, explicit development/release push effects, deployment identity/state, and structured errors. `.tmp/forge-vercel-release/latest-publish.json` atomically stores the latest acquired publish attempt with a fixed SHA, including partial failures. Status/verify reject a receipt with a different config digest; pass an explicit SHA to make a changed-target selection intentional. Reports are local recovery data, not signed authorization. A lock contains PID, unique ownership token and acquisition time; ownership is checked immediately before each push, before writing the receipt, and before release. An existing or stale lock is never stolen. After a crash, inspect its owner and remote/deployment state before removing that exact stale lock. Abrupt process termination cannot guarantee lock cleanup. Live login output buffers incomplete lines to redact credentials spanning process chunks, and forwarding has the same per-stream byte bound as capture; a final partial line is flushed on completion.

## Error codes

| Codes | Meaning |
| --- | --- |
| `ARGUMENT_INVALID`, `CONFIG_INVALID`, `CONFIG_READ` | Invalid options, strict configuration violation, or unreadable/invalid JSON file. |
| `GIT_FAILED`, `GIT_DIRTY`, `GIT_BRANCH`, `GIT_REPOSITORY`, `GIT_DIVERGED` | Git execution, dirty source, wrong branch/root/remote, or missing/non-fast-forward remote branches. |
| `CANDIDATE_CHANGED` | HEAD, tracked/untracked source, remote identity, or config changed during checks. |
| `CHECK_FAILED`, `ACCEPTANCE_FAILED` | A configured check or production acceptance command failed. |
| `COMMAND_TIMEOUT`, `COMMAND_FAILED`, `CANCELLED` | A bounded process timed out, executable could not be resolved, or operation was cancelled. |
| `LOCKED`, `LOCK_OWNERSHIP` | Another lock exists, or the lock changed ownership before release. |
| `AUTH_REQUIRED`, `VERCEL_API` | Official CLI authentication required, failed/malformed API response, bounded request timeout or output overflow. |
| `DEPLOYMENT_SOURCE`, `DEPLOYMENT_MISSING`, `DEPLOYMENT_FAILED`, `DEPLOYMENT_TIMEOUT` | Wrong project/team/SHA/branch/source/target, no exact matching deployment, terminal failure/not READY, or bounded wait exhausted. |
| `ALIAS_MISMATCH`, `BUILD_INFO`, `BUILD_REVISION` | Wrong production alias/project/deployment, anonymous marker unavailable/oversized/invalid, or wrong revision. |
| `IO_FAILED` | Local file/process/runtime failure outside a more specific contract. |

Known credential-shaped output is redacted; configured commands remain trusted executable code and must not print secrets. The official CLI is pinned to `64.7.0`; its required transitive WASM peers are explicitly pinned to preserve strict peer installation. This package reuses public Forge command-runner/process-control and artifact-integrity capabilities. No third-party implementation types appear in its public contract.

See the [Chinese package guide](../../docs/packages/release-tooling/release-vercel.md), [official CLI API documentation](https://vercel.com/docs/cli/api), and [Vercel deployment API](https://vercel.com/docs/rest-api/deployments/list-deployments).
