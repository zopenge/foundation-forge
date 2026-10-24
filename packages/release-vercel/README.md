# @openge/forge-release-vercel

Explicit Git integration releases with bounded checks, fixed commit selection, and independent Vercel production verification. Node.js >=22.14.0 and Git are required. Configure the existing Vercel Git integration to deploy the release branch to production before using this package.

Internal Git commands keep automatic maintenance and garbage collection in the foreground through invocation-local settings. That work remains inside the command deadline and managed process scope; repository and global Git settings are not rewritten.

Frozen-source checks and committed-config reads preserve Git execution failures, command timeouts, cancellation, and unknown process closure diagnostics. These errors stop the release without being relabeled as source changes or an uncommitted config. A config path is reported as missing only after Git exits normally and confirms its absence; actual changes to the frozen source still fail with `SOURCE_CHANGED`.

```sh
pnpm add -D @openge/forge-release-vercel
pnpm exec forge-vercel-release check
pnpm exec forge-vercel-release login
pnpm exec forge-vercel-release publish
pnpm exec forge-vercel-release status
pnpm exec forge-vercel-release verify --sha <full-40-character-sha>
pnpm exec forge-vercel-release recover
```

## Configuration

The default file is `release.config.json`, relative to `--cwd` (default: the current directory). All fields below are required. Unknown fields are rejected. Commands run in the repository root, without a shell. On Windows, `node`, `pnpm`, and `npm` resolve to their JavaScript entrypoints; `.cmd` and `.bat` executables are rejected. Other executables must be directly spawnable.

```json
{
  "schemaVersion": 2,
  "source": { "mode": "workspace" },
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

Prepare/check/acceptance commands receive protected `FORGE_RELEASE_COMMAND=check|publish|verify` and `FORGE_RELEASE_SHA`; acceptance also receives `FORGE_RELEASE_URL` and `FORGE_RELEASE_DEPLOYMENT_ID`. Inherited values cannot override this metadata. It describes intent, not business authorization. Consumers own business assertions and any idempotent remote preparation. The build marker must be deployed from source and contain the full SHA; do not fabricate it during verification.

## Managed commit mode

Schema 2 requires an explicit source; schema 1 is rejected without conversion. The example above executes directly in the existing clean workspace. To use one reusable checkout, replace `source` with:

```json
{
  "mode": "managed-commit",
  "slotPath": ".tmp/release-slot",
  "maxBytes": 2147483648,
  "minFreeBytes": 5368709120,
  "sampleIntervalMs": 1000,
  "install": { "packageManager": "pnpm" },
  "prepare": []
}
```

Commit ignore rules for the slot and `.tmp/forge-vercel-release/` first. `slotPath` uses relative ASCII components without `.`, `..`, `.git` or overlap with management metadata. Byte limits are positive safe integers; the example allows 2 GiB logical bytes and requires 5 GiB free. Sampling intervals are 250–5000 ms. `prepare` permits 0–32 foreground commands with the same command schema as checks. The public package does not bind a drive, project, or business permission.

Ignore-file validation accepts CRLF/LF checkout differences while comparing all other bytes against the frozen commit. Uncommitted rules, changes hidden by clean filters, global ignore files and `.git/info/exclude` cannot substitute for committed rules.

Managed inputs come from one full SHA on the development branch: committed config, scripts, lockfile and exact `packageManager: "pnpm@<version>"`. Tracked files/index/config must be clean; unrelated untracked files remain untouched. Config objects cannot override managed inputs. A real independent clone fetches unpushed candidate objects from the frozen source, runs `pnpm install --frozen-lockfile`, prepare and checks, and only then permits pushes. The installed pnpm version must match; the tool does not download another pnpm version. It never copies source `.git/config`, creates worktrees, switches the source branch, resets/stashes/cleans, forces installation or relocates the shared store.

One owned slot reuses dependencies and same-SHA output; later commits require a clean fast-forward. Dirty/diverged checkouts fail without a second slot. Source symlinks, gitlinks, LFS pointers, unsupported encodings/filenames, external Git object dependencies and replaced/junction roots are rejected. Git tree listings are streamed with bounded records, rather than accepted after capture truncation. Inherited Git directory/index/object-database/namespace overrides are rejected; trusted authentication/routing still applies. An existing anchor cannot silently rebind to a different slot/config, or switch execution to workspace mode.

Logical-byte accounting includes every slot entry plus the source anchor; hardlinks count separately, internal links are not traversed, and external/unknown links fail. Each observation visits at most 500000 entries. Metadata writes reserve their temporary peak. Admission, command monitoring and stage observations cancel on limit violations or incomplete observations. Reports expose observed maxima, free-space minima and observation gaps. **Finite sampling is not an OS quota:** writes may briefly exceed a limit between observations. The tool does not modify host quotas or clean shared stores.

An internal symlink or Windows junction may temporarily point to a missing target during installation. The observer validates existing ancestors within the owned root, bounds link resolution to 40 hops, and counts the link itself; materialized target files count through the ordinary directory scan. External targets, cycles, root replacement and unprovable observations still fail. This also lets `recover` inspect a retained installation containing pending internal links. Recovery still requires recorded process-closure evidence: absent PIDs cannot repair a historical gap or release its lock.

Commands must finish in the foreground. Managed execution requires Windows x64 Job Objects or Linux/glibc x64 subreaper/wait/pidfd support. A runner manual gate persists the real identity, scope ID and exact run/command binding, rechecks budget/ownership, then authorizes the job. Only matching OS-proven normal/empty closure permits the next command within that run or normal lock release. Cancellation, crash gaps, identity changes or surviving descendants remain unknown even if force cleanup proves emptiness. Historical schema-2 polling witnesses remain readable but cannot establish closure or release a lock. Old gate/result files are never executed or automatically removed. Explicit interrupted-run retirement is a separate resource operation described below.

Koffi 3.3.3 is a pinned, lazy native dependency. This repository and tarball consumers disable its install script with `allowBuilds.koffi: false`; consumers should do the same. Missing prebuilds/capabilities fail before the job, with no runtime download, compilation or fallback. Owned scopes manage trusted commands, not a security sandbox: do not delegate work to WMI/system services or other external process owners. Workspace mode retains its existing behavior.

## Commands and side effects

| Command | Behavior |
| --- | --- |
| `check` | Verify root, remote, clean development branch, run checks, and confirm HEAD/source/config remain frozen. No remote writes or Vercel requests. |
| `publish` | Acquire an exclusive local project lock; freeze HEAD; fetch and validate both remote branches as ancestors of that SHA; authenticate and check project ownership, repository link and production branch; run checks; revalidate the candidate and remotes; check project binding and lock ownership before each ordinary, non-force, exact-SHA push to development then release branch; wait for the matching authoritative Git integration production deployment to become READY; verify alias, anonymous build marker, and acceptance jobs. |
| `status` | Read a deployment for `--sha`, otherwise the latest publish receipt's frozen SHA, otherwise local HEAD if no receipt exists. Returns deployment state; successful querying alone does not imply READY. No checks, acceptance, or pushes. |
| `verify` | Independently query project and deployment, require READY and correct Git source, then verify production alias, anonymous build marker, and acceptance jobs. Uses the same SHA selection as `status`. No pushes. |
| `login` | Explicitly delegate to the pinned official Vercel CLI and let the user authorize it. No release config is required. Bounded to ten minutes. The CLI prints login instructions to stderr. |
| `recover` | Managed mode only: claim recovery, inspect owner/processes/real refs/deployment, reconcile proven facts and release the exact old lock only when closure is established. No install, checks, acceptance, pushes, deployment creation or rollback. |
| `retire` | Managed mode only: explicitly select an interrupted run, bind its original host, require an independently observed later OS boot, archive the unchanged historical evidence and release its exact lock. Historical verification remains UNKNOWN; a new publish must pass all ordinary gates. |

Shared options are `--cwd DIR`, `--config FILE`, and `--sha SHA` (only `status`/`verify`); `retire` additionally accepts `--run-id UUID` and `--confirm-origin SHA256`. `--help` prints JSON usage. Standard output is one structured JSON report. Exit codes: `0` successful command, `1` operational failure or pending retirement proof, `2` invalid CLI arguments. SIGINT/SIGTERM cancel active work; managed locks are released only with proven closure/effects or explicit completed retirement. No command automatically commits, switches branches, force-pushes, creates/uploads deployments, rolls back, or rewrites history. Vercel requests are GET through `vercel api --raw --non-interactive`, reusing the official CLI session. Only `login` initiates login.

Same-SHA reruns use ordinary exact-SHA pushes and the server's porcelain up-to-date result, locating existing deployments without requesting another upload. Success survives later failure in `effects`. An ambiguous managed push retains `unknown` and its lock: use `recover` before retrying. With proven closure, candidate refs reconcile to `already-current`, ancestor refs to `not-current` (observed state, not “never attempted”). Later/diverged/unavailable refs retain the lock. Original publish effects/errors remain in the receipt; recovery appends observations and status checks current refs before showing reconciled facts. A crash before closure was recorded remains unknown even after processes disappear. No force-confirmation or automatic stale-lock deletion exists. Follow the quoted `recovery.nextCommand`; unresolved identity gaps require maintainer investigation of that exact run.

### Explicit retirement of an interrupted run

`recover` keeps its normal-closure requirement. When that evidence is irretrievably missing it points to `retire --run-id UUID`; `recovery.reportExists` distinguishes an existing receipt from an intended path. Retirement never reconstructs a successful publish receipt or changes an old command to closed.

```sh
pnpm exec forge-vercel-release retire --run-id <RUN_ID>
```

New managed runs record a hashed machine identity and OS boot observation before executing commands. Legacy runs require a maintainer to confirm that the exact run originated on this host and that its slot was never copied, migrated, cloned or restored. The first call returns `ORIGIN_CONFIRMATION_REQUIRED` with `retirement.originConfirmation`, bound to the original files and this host. Only after making that factual confirmation, run:

```sh
pnpm exec forge-vercel-release retire --run-id <RUN_ID> --confirm-origin <ORIGIN_CONFIRMATION_FROM_REPORT>
```

The saved origin is explicitly `operator-confirmed-origin`, not a reconstructed machine observation. A confirmation cannot override an already recorded different host or changed evidence. The command saves a checkpoint and exits 1 with `SUBSEQUENT_BOOT_REQUIRED` until it can prove a later boot on that same host. The tool never restarts the machine. After arranging a real restart, rerun the first command promptly. On Windows, proof requires the OS uptime counter to be at least 60 seconds lower than the saved baseline; sleep and wall-clock changes are insufficient. On Linux, a different kernel boot ID is required. A short baseline or a long delay after restarting can leave Windows proof insufficient; the baseline is not silently reset. Host observation requires the Windows machine identity registry value or Linux machine-id and kernel boot-id files; unavailable observations fail closed.

A native Windows mutex or Linux directory flock serializes retirement. OS release of that lease proves only the end of the metadata transaction, never historical process closure. Only this protocol's abandoned recovery claim can be resumed under that lease; foreign claims remain protected. Exact file contents and identities, original source/config, current refs and project/deployment identity are checked. Later, diverged or unknown refs block retirement. The tool writes an archive under the same slot's `retired/<RUN_ID>.json` before releasing the original lock. Original state and existing receipts remain unchanged; each archive is bounded to 8 MiB and counts against the slot budget. Interrupted finalization can be resumed without rewriting historical results or creating another slot.

Exit 0 with `retirement.status: "retired"` means resource retirement completed. `historicalVerification: "unknown"` and original push effects remain in the report and archive. Follow its next command to start a new, fully checked publish on the same slot. This operation does not grant new Git or deployment authorization. `--run-id` and `--confirm-origin` are accepted only by `retire`; workspace mode does not support it.

In managed mode, status/verify select the latest publish receipt even after later source/config/check changes; unknown requested SHAs fail. Verify locks and uses the original exact checkout/config/scripts. Missing/untrusted checkouts fail without installing or falling back to current source. Check never overwrites publish selection. The command table's direct-workspace SHA fallback applies only to workspace mode.

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

The root exports only contracts and `releaseErrorCodes`, and is browser-safe. `./node` is explicitly `browser: null` and exports `runRelease`, `validateReleaseConfig`, and `ReleaseError`. Options include `command`, `cwd`, `configPath`, workspace-only `config`, `sha`, `signal`, `transport`, and `onLoginOutput`. Config objects are cloned/validated; managed callers must use a committed file. `transport` supplies only explicit `api(path, signal)` and anonymous `buildInfo(url, signal)` boundaries and must honor abort signals. Node callers supply `onLoginOutput` to display redacted official login instructions.

Reports include schema 2, timestamps, SHA/config digest, source/execution roots, run/slot identity, stage, budget/process summaries, bounded job steps, separate push effects, deployment and errors. Managed metadata lives in the slot: ownership, run/recovery locks, state and separate latest-check/latest-publish receipts. The source `.tmp/forge-vercel-release/managed.json` anchors slot/config/publish identity. A state/receipt is at most 1 MiB, anchor at most 64 KiB, and each persisted step stdout/stderr at most 2048 UTF-8 bytes with `truncated`; effects/diagnostics are never clipped. Writes reserve peak bytes and verify paths/index/HEAD/lock ownership. Foreign slots, stale locks and atomic-write remnants are not automatically removed. Workspace mode retains `.tmp/forge-vercel-release/latest-publish.json` and its config-digest/explicit-SHA selection; recover is unsupported there. Receipts are local recovery evidence, not signed authorization. Abrupt termination may retain locks. Live login output buffers partial lines for cross-chunk redaction and uses the same finite per-stream budget.

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
| `SOURCE_CHANGED`, `SOURCE_UNSUPPORTED`, `RECEIPT_SHA_MISMATCH` | Changed/unsupported frozen source or unknown receipt SHA. |
| `SLOT_PATH`, `SLOT_FOREIGN`, `SLOT_STATE`, `SLOT_NOT_FAST_FORWARD` | Unsafe/replaced path, unowned slot, invalid management evidence or non-fast-forward reuse. |
| `BUDGET_EXCEEDED`, `BUDGET_UNKNOWN` | Admission/observed limit violation or incomplete observation. |
| `PROCESS_STATE_UNKNOWN`, `RECOVERY_REQUIRED` | Unproven process closure/effects or retained run needing inspection. |

Known credential-shaped output is redacted; configured commands remain trusted executable code and must not print secrets. The official CLI is pinned to `64.7.0`; its required transitive WASM peers are explicitly pinned to preserve strict peer installation. This package reuses public Forge command-runner/process-control and artifact-integrity capabilities. No third-party implementation types appear in its public contract.

See the [Chinese package guide](../../docs/packages/release-tooling/release-vercel.md), [official CLI API documentation](https://vercel.com/docs/cli/api), and [Vercel deployment API](https://vercel.com/docs/rest-api/deployments/list-deployments).
