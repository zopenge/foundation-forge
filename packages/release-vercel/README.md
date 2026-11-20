# @openge/forge-release-vercel

Explicit Git integration or prebuilt releases with bounded checks, fixed commit selection, and independent Vercel production verification. Node.js >=22.14.0 and Git are required. The default delivery uses an existing Vercel Git integration; the optional prebuilt delivery stages self-contained Build Output without a Git integration.

Release recovery metadata and retained prebuilt inputs use `state/forge-vercel-release/`; the recommended managed slot is `state/release-slot/`. Commit ignore rules for both before starting a release. Temporary test/build material uses `tmp/`. This changes the previous metadata location: finish or retire an active run with its original tool version and original host before upgrading. Recorded paths and filesystem identities are part of recovery proof; moving an active slot or copying its journal does not preserve that proof. There is no automatic legacy-directory lookup or state migration.

Private deployment CLI configuration and caches are generated under `tmp/forge-vercel-release/` in the execution checkout and disposed after the command. Missing temporary directories are created on demand. Removing this scratch does not remove the retained upload inputs or release recovery metadata under `state/`.

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

Both command arrays contain 1–32 entries. Each entry accepts only `command`, optional `args` (up to 128 arguments), and optional `timeoutMs`. Times are positive safe integers: commands and deployment waits are capped at one hour, requests at five minutes, and `pollMs` cannot exceed `deploymentMs`. Command-specific timeouts are capped by `commandMs`. Output is bounded per stream to `maxOutputBytes` (at most 1 MiB); configured job output may be truncated, while truncated Git/API protocol output fails closed. Add `state/forge-vercel-release/` and `tmp/` to the consuming repository's ignore rules.

Process identity observation for both managed commands and read-only management checks has a maximum ten-second budget, capped by `commandMs`. The command's own timeout continues to cover observation and execution together. Identity failure and cancellation still stop the command; they do not trigger an automatic retry.

Once the owned runner starts, its unchanged command deadline covers scope startup, identity binding, and the subsequent queue, guards, budget observations, journal writes, and execution. Slot admission, intent persistence, and the initial budget sample before runner startup retain their existing separate gates; they are not included in this command deadline. Once termination is requested, pending preparation may finish recording evidence but cannot authorize the target command. A proved timeout remains `COMMAND_TIMEOUT`, without a secondary inactive-authorization error replacing it. Genuine journal failures and unknown closure still fail closed.

Managed timeout errors include bounded `details.preparation` timings and the authorization state (`not-requested`, `requested`, or `acknowledged`). `phaseAtTermination` and `terminationAfterMs` identify when termination was requested. `elapsedMs` ends at authorization acknowledgement, or when both the runner result and queued preparation settle if acknowledgement never occurs; the latter can include OS closure waiting. Queue, guard, journal, budget, and authorization durations are reported separately; `budgetQueueMs` and `budgetScanMs` describe only the explicit pre-authorization budget sample. Intervals can overlap, and journal time includes its own safety work, so these values must not be summed as wall time. A requested authorization does not prove the target script started. No arguments, environment values, paths, or event log are included.

Windows execution requires Windows x64 and the installed Koffi prebuild. Startup identity observation and termination revalidation explicitly share the native Win32 reader, without a PowerShell identity fallback. Before the first workspace command, a bounded native-readiness check runs within that command's original budget; its elapsed time is deducted before spawning. Native capability errors stop execution before that command starts. Later commands still read each child identity afresh. POSIX execution and managed Job/subreaper closure requirements remain unchanged.

Prepare/check/acceptance commands receive protected `FORGE_RELEASE_COMMAND=check|publish|verify` and `FORGE_RELEASE_SHA`; acceptance also receives `FORGE_RELEASE_URL` and `FORGE_RELEASE_DEPLOYMENT_ID`. Inherited values cannot override this metadata. It describes intent, not business authorization. Consumers own business assertions and any idempotent remote preparation. The build marker must be deployed from source and contain the full SHA; do not fabricate it during verification.

## Managed commit mode

Schema 2 requires an explicit source; schema 1 is rejected without conversion. The example above executes directly in the existing clean workspace. To use one reusable checkout, replace `source` with:

```json
{
  "mode": "managed-commit",
  "slotPath": "state/release-slot",
  "maxBytes": 2147483648,
  "minFreeBytes": 5368709120,
  "sampleIntervalMs": 1000,
  "install": { "packageManager": "pnpm" },
  "prepare": []
}
```

Commit ignore rules for the slot and `state/forge-vercel-release/` first. `slotPath` uses relative ASCII components without `.`, `..`, `.git` or overlap with management metadata. Byte limits are positive safe integers; the example allows 2 GiB logical bytes and requires 5 GiB free. Sampling intervals are 250–5000 ms. `prepare` permits 0–32 foreground commands with the same command schema as checks. The public package does not bind a drive, project, or business permission.

Ignore-file validation accepts CRLF/LF checkout differences while comparing all other bytes against the frozen commit. Uncommitted rules, changes hidden by clean filters, global ignore files and `.git/info/exclude` cannot substitute for committed rules.

Managed inputs come from one full SHA on the development branch: committed config, scripts, lockfile and exact `packageManager: "pnpm@<version>"`. Tracked files/index/config must be clean; unrelated untracked files remain untouched. Config objects cannot override managed inputs. A real independent clone fetches unpushed candidate objects from the frozen source, runs `pnpm install --frozen-lockfile`, prepare and checks, and only then permits pushes. The installed pnpm version must match; the tool does not download another pnpm version. It never copies source `.git/config`, creates worktrees, switches the source branch, resets/stashes/cleans, forces installation or relocates the shared store.

One owned slot reuses dependencies and same-SHA output; later commits require a clean fast-forward. Dirty/diverged checkouts fail without a second slot. Source symlinks, gitlinks, LFS pointers, unsupported encodings/filenames, external Git object dependencies and replaced/junction roots are rejected. Git tree listings are streamed with bounded records, rather than accepted after capture truncation. Inherited Git directory/index/object-database/namespace overrides are rejected; trusted authentication/routing still applies. An existing anchor cannot silently rebind to a different slot/config, or switch execution to workspace mode.

Logical-byte accounting includes every slot entry plus the source anchor; hardlinks count separately, internal links are not traversed, and external/unknown links fail. Each observation visits at most 500000 entries. Metadata writes reserve their temporary peak. Admission, command monitoring and stage observations cancel on limit violations or incomplete observations. Reports expose observed maxima, free-space minima and observation gaps. **Finite sampling is not an OS quota:** writes may briefly exceed a limit between observations. The tool does not modify host quotas or clean shared stores.

On Windows, managed installation runs `pnpm install --frozen-lockfile --package-import-method=copy` to avoid shared-store hardlink import contention with budget observation. Other platforms retain `pnpm install --frozen-lockfile`. Lifecycle scripts, the shared store and existing checkout dependencies remain in use; no forced reinstall or cache cleanup is added. Copying can use more physical disk space, which remains subject to the existing free-space checks. Existing hardlinks need not be converted. Each directory enumeration closes before inspecting its children; queued names share the same 500000-entry limit. The observer rechecks each directory's type, identity and canonical path after visiting its children. A disappearing entry or a pure identity change in an ordinary checkout descendant discards the entire scan and may restart it at most twice within the original observation deadline. The checkout root remains bound across these scans; slot/checkout roots, Git metadata directories, links, type changes and canonical-path changes cannot use the identity retry. These measures do not guarantee that all filesystem operations finish within the observation deadline.

Directory and file visits share the existing bound of four scan branches; directory hints do not serialize independent subtrees. Each visit still reads fresh metadata. Before allowing a whole-scan retry, any in-flight directory interrupted by the retryable first error finishes its identity and canonical-path checks. A known non-retryable replacement still blocks the retry, and cancellation still drains pending work without authorizing another scan.

An observation's `BUDGET_UNKNOWN` details may also include `scanAttemptDiagnostics`, containing at most three scan summaries. Each records `attempt`, `startedOffsetMs`, optional `endedOffsetMs`, `elapsedMs`, `outcome` (`pending`, `resolved` or `rejected`), `retried`, `entriesVisited` and the shared `phase`; rejected scans add a content-free `failure` category. Times use the same monotonic observation start. `retried` becomes true only when the next scan actually starts. At the original deadline, a detached snapshot is captured before abort: a pending scan has no end offset, and later completion cannot rewrite that evidence. A resolved scan only means its callback returned; checkout validation and byte/free-space admission can still fail. A deadline before the first scan records an empty array. These summaries add no per-entry I/O, paths, identities, messages or file contents, and do not change observation deadlines, retry decisions, sampling or process closure.

A summary may also include `failureWitness`. Its `first` records the first selected scan failure with a finite `reason`, optional `ioCode`, `operation`, argument `role`, `boundary`, and `observedOffsetMs` relative to that attempt's existing monotonic scan start. Add this offset to the attempt's `startedOffsetMs` only when an observation-relative offset is needed. `failure-latch` means the original failure latch, before subsequent sibling draining and directory rechecks; `scan-catch` marks an error observed only at the outer scan catch. Neither is an OS failure timestamp. Whole-attempt duration includes draining and rechecks, so it is not time to the first failure. An internally handled missing-link target creates no failure witness. A separate `blocking` witness either refers to the first failure (`relation: first`) or describes the first later failure that blocks a retry (`relation: later`); it never replaces the original error. Only rejected scans include `selection`: `first`, `different`, or `unwitnessed`, describing how the scan's selected error relates to the witness. A pending deadline can contain a first failure or blocker without inventing a final scan result. Roles are `checkout-payload`, `checkout-metadata`, `managed-control`, `protected-root`, or `unknown`, based on existing arguments and known layout; they do not identify a writer or a link's final target. Operations use native syscall or explicit validation categories, otherwise `unknown`. Witness collection adds no filesystem queries or per-entry timing, and reads its clock at most twice per failed attempt and never on a successful scan. Existing deadline snapshots also detach these witnesses before abort. The diagnostics do not prove command authorization, execution, or a timeout's cause.

Each observation has one deadline across all whole-scan attempts. It defaults to 30 seconds plus `sampleIntervalMs`. A committed `source.observationTimeoutMs` from 30,000 to 120,000 sets the deadline independently of the periodic sampling interval. `BUDGET_UNKNOWN` observation failures record `budgetMs`, monotonic `elapsedMs`, UTC `observedAt`, `scanAttempts`, `entriesVisited` for the latest attempt, and the current scan `phase`. These fields contain no paths, file contents or environment values. Directory replacement additionally records `change`, `scope`, a slot-relative `entry` limited to 512 Unicode code points with `entryTruncated`, and `before`/`after` device and inode strings. If draining a sibling observes a non-retryable failure, the original error and `rescanBlockedBy` are retained and further attempts are refused. Observation time starts when the queued observation begins. An observation gap also includes scheduling and queue wait. When a command result was already recorded, a budget error additionally retains `step`, `commandTermination`, `commandExitCode` and `commandObservedAt`. Incomplete observations fail even below the byte limit. The configured deadline adds time for a full scan while keeping the retry, identity, link, byte and free-space checks.

An internal symlink or Windows junction may temporarily point to a missing target during installation. The observer validates existing ancestors within the owned root, bounds link resolution to 40 hops, and counts the link itself; materialized target files count through the ordinary directory scan. External targets, cycles, root replacement and unprovable observations still fail. This also lets `recover` inspect a retained installation containing pending internal links. Recovery still requires recorded process-closure evidence: absent PIDs cannot repair a historical gap or release its lock.

Commands must finish in the foreground. Managed execution requires Windows x64 Job Objects or Linux/glibc x64 subreaper/wait/pidfd support. A runner manual gate persists the real identity, scope ID and exact run/command binding, rechecks budget/ownership, then authorizes the job. Only matching OS-proven normal/empty closure permits another command within that run. A controlled abort or timeout may separately prove resource cessation when the Provider reports `terminated`, final emptiness, and the exact scope/binding/root identity. The command remains failed or cancelled; a subsequent run must pass every ordinary gate. Owner loss, Provider failure, unexpected surviving descendants, identity changes and crash gaps remain blocked. Unscoped polling witnesses cannot represent closed commands. Obsolete gate/result files are rejected as unknown slot entries, without execution or automatic removal.

Managed journals accept only schema 3 with the original host observation and history bindings; schema-2 run states are rejected. Config, report, receipt, anchor and independent proof schemas retain their own current versions. Before authorizing a command, the tool reserves 1 MiB within the configured budget for bounded terminal metadata; each `terminal.json` is at most 256 KiB. Its checksum, stable proof digest, host and exact metadata file identities permit read-only recovery when the ordinary state merge fails. Writing this receipt does not scan checkout payload or invoke Git. Invalid payload still blocks execution, reuse and cleanup. Metadata replacement, insufficient disk space and actual write failures remain failures. No previous `tmp` contents or Codex runtime are needed to develop or start a new checkout; recovery of an existing run requires its original local evidence on the original host.

Cancellation observed after a launch intent is written but before the SDK calls the runner can seal a separate schema-1 `notStarted` witness inside that journal. It binds the run, command and nonce and records no PID, identity, scope or OS closure. The outcome remains cancelled and the command remains `stopped`; it cannot authorize another command in the same run or establish successful publication. The ordinary recovery path can verify its independent terminal proof and preserve the original failure. A failed seal, previous launch evidence or a historical UNKNOWN without this proof remains blocked. Upgrading does not reconstruct missing evidence. Use a release that supports this witness to recover a journal containing it.

Before replacing state, the terminal receipt seals the identities and digests of both the original file and the fsynced temporary file. Recovery accepts either exact image after a coordinator exit; copying the same bytes to another file still fails. After archiving original evidence, the exclusive recovery transaction can discard only the matching uncommitted temporary file. Unknown remnants remain blocked, and historical state and remote effects stay unchanged.

Koffi 3.3.3 is a pinned, lazy native dependency. This repository and tarball consumers disable its install script with `allowBuilds.koffi: false`; consumers should do the same. Missing prebuilds/capabilities fail before the job, with no runtime download, compilation or fallback. Owned scopes manage trusted commands, not a security sandbox: do not delegate work to WMI/system services or other external process owners. Workspace commands retain direct execution and their existing timeout and termination semantics.

## Prebuilt delivery

Use `source.mode: "managed-commit"` and add this optional field to the existing schema 2 configuration:

```json
{
  "delivery": {
    "mode": "prebuilt",
    "maxFiles": 10000,
    "maxBytes": 268435456,
    "concurrencyControl": { "mode": "external-serialization", "scope": "production-project" },
    "admission": [{ "command": "node", "args": ["scripts/release-admission.mjs"] }]
  }
}
```

Keep the normal public entry, for example `"release": "forge-vercel-release publish"`. Omitting `delivery` preserves the original Git behavior and configuration digest. Prebuilt requires an existing **Git-unlinked** project. Git fields still identify and freeze the local source repository; prebuilt never pushes either branch, and `releaseBranch` does not authorize deployment provenance.

Committed `source.prepare` steps must produce a complete `.vercel/output/` implementing Build Output API version 3. A reviewed producer can use `vercel build --prod --standalone`; declare the producer and its exact version in the consuming repository. Function output must contain its dependencies. Native dependencies must target Vercel's Linux x64 environment; a Windows build or static fixture does not establish native-runtime compatibility. Obtain or generate artifacts through declared, reproducible steps; do not use a previous task's temporary directory as input.

The tool snapshots sorted file paths, directories, modes, lengths and SHA-256 digests, binds them to the real Git commit and normalized configuration, and copies only Build Output into an owned upload directory. Internal relative symbolic links are preserved, including pnpm dependency links and `.func` aliases. Each link's target text, type and complete target closure are bound to the artifact digest. The original output and copy must resolve links to the same portable target through both native filesystem resolution and Node's default realpath resolution; absolute links, junctions, escapes, dangling targets, cycles and case collisions are rejected. Links count toward `maxFiles`, and their UTF-8 target bytes count toward `maxBytes`; limits are unchanged. Source, slot roots and metadata retain their stricter link rejection.

Unsafe paths, `.git`, common environment/credential files, and the reserved `static/.well-known/forge-prebuilt.json` path are rejected. The tool creates that public marker itself. Content review and detection of secrets embedded in compiled files remain mandatory consumer responsibilities; path checks cannot prove arbitrary bytes contain no secrets. Producers must keep output quiescent during sealing and upload; these checks are not a sandbox against hostile concurrent writers.

The pinned CLI archives files and links, and recreates their parent directories. Empty payload directories are rejected because that protocol cannot retain them; the reserved marker's parent directories are the exception because the marker materializes them. Directory modes are checked for local source/copy identity, without promising their restoration by Vercel. File and link archive-header modes are preserved by clearing umask only in the deployment child. Its configuration and caches use a newly generated private directory; the CLI reads the standard `VERCEL_TOKEN` environment variable, without putting it in arguments or writing an authentication file. It does not depend on user-level CLI login. That directory is removed after the command, including failures. The normal runtime generates it afresh, with no dependency on Codex or previous temporary output.

`check` builds/checks and seals the local artifact without querying Vercel. `publish` then:

1. Runs required consumer admission and validates the existing project/account. Project root-directory settings must be unset, empty, or `.`; nested roots are rejected before recording a create intent because the isolated upload contains only `.vercel`.
2. Stages using the pinned CLI's `deploy --prebuilt --archive=tgz --prod --skip-domain --no-wait --json` path, with explicit project/team and non-interactive execution. The archive preserves relative links without expanding their directories.
3. Records the returned deployment ID, reads its authoritative project/account/production/CLI-source/READY fields, and checks its actual marker.
4. Runs `acceptance` against that exact candidate URL, with `FORGE_RELEASE_DEPLOYMENT_ID`, `FORGE_RELEASE_SHA` and `FORGE_RELEASE_ARTIFACT_SHA256`.
5. Repeats consumer admission and frozen-input checks, promotes the same ID, then reads the production alias, marker and configured build-info revision.

Admission receives `FORGE_RELEASE_PHASE=create|promote`, `FORGE_RELEASE_TEAM_ID`, `FORGE_RELEASE_PROJECT_ID` and `FORGE_RELEASE_SERIALIZATION_SCOPE`. It must reject exhausted quotas or an unacceptable plan. Every writer for the same project must be serialized by one external coordinator across machines/repositories; the declared scope is an assertion, not a distributed lock. Hold that coordination through acceptance, promotion and reconciliation of unknown effects; do not release it merely because a local process stopped. The fixed-slot lock separately protects local resources. Foundation does not buy resources, upgrade a plan, create a project, sign/register application catalogs, or guarantee unlimited free usage. The caller may queue or pause on `ADMISSION_FAILED`.

Default prebuilt API reads and writes require the standard `VERCEL_TOKEN` credential, supplied through normal protected configuration. Never commit it. This also applies to default prebuilt `status`, `verify`, and remote effect reconciliation; CLI login credentials are no longer used for those reads. A missing token fails before any request. Local recovery that does not query Vercel still needs no Vercel credential. Git delivery and supplied custom transports keep their independent authentication contracts.

Default prebuilt project, candidate, production-alias and version-alias API reads use one native HTTPS GET to `api.vercel.com`, with the original project/team binding. They do not retry, redirect, read host proxy settings, or fall back to the CLI. Each GET is limited to 30 seconds and 64 KiB, or a smaller configured `requestMs`/`maxOutputBytes`; an existing poll deadline can shorten the request further. Managed path, lock, history, foreground-closure and budget gates still run. Their work occurs outside the HTTP request timer, and the absolute poll deadline is not reset. Success, failure, cancellation and timeout settle only after the request and socket have actually closed. Closing or completing the surrounding host checks can delay delivery beyond the request deadline; an expired request remains failed. No CLI process scope is fabricated for a native GET.

The CLI and public API independently verify the same configured project/account. The fixed CLI's promote command retries POST internally, so this package uses the equivalent public promotion API with a single HTTPS POST, a finite response limit/deadline and confirmed connection closure. It does not modify or deep-import CLI internals. A trusted custom `ReleaseTransport.promote` must honor cancellation and perform at most one write. Ordinary `publish` runs install, prepare, checks and artifact sealing on each attempt.

A retry can seal new bytes for the same commit and configuration when the previous failed publication receipt matches its archived stop evidence and all recorded effects for that candidate are `not-attempted`. The original receipt remains in the run's history. An accepted or unknown effect keeps the artifact binding. The new run still performs admission and target checks under the caller's external serialization.

Reports record `prebuilt` and independent `effects.deploymentCreate` / `effects.deploymentPromote`. Write intent is persisted before each side effect. An explicit repeat can reuse the recorded exact candidate; an unknown creation without a saved ID cannot be rediscovered by trusting caller metadata or silently retried. Unknown promotion is observed through its original ID, authoritative completed promotion job and actual alias. Before a later write, a bound resolution is persisted without rewriting the original unknown history. An authoritative terminal failure for that exact promotion can also be recorded as failed, allowing a new candidate while preserving the old failure and unverified result. A pending, missing or different job cannot establish that resolution. Rolling Release projects are rejected. No automatic rollback or duplicate deployment is performed. Local resource closure does not prove a remote effect completed.

Managed prebuilt `status` stops waiting when the bound candidate reports `BLOCKED`, `ERROR`, `CANCELED`, or `CANCELLED`. The schema 2 report has `ok: false`, `stage: "deployment"`, and `error.code: "DEPLOYMENT_FAILED"`. It carries `deployment: { id, url, projectId, sha, state }` and the original `runId`, `candidateSha`, `configSha256`, `prebuilt`, and `effects`. `deployment.sha` is the receipt's source binding. `error.details` holds `deploymentId`, `state`, and the UTC `observedAt` of the SDK read. It also includes `publicationStage` when the saved publish receipt has a recognized stage. This is the original publish stage. The top-level `stage` describes the status command. For `BLOCKED`, the details include `providerBlockCode` only when Vercel supplies `TEAM_ACCESS_REQUIRED` or `COMMIT_AUTHOR_REQUIRED` in `seatBlock.blockCode`. `candidateContext` follows the existing optional version-alias contract. This describes the candidate at the time of the read. Local lock release, production routing, and unresolved promotion or alias effects still require their independent proofs. The status read leaves the original receipt and history intact.

The source and upload copies are checked again before writes. Artifact-copy growth is admitted against the existing slot budget and free-space floor; account for dependencies, the original output and its upload copy. Temporary output is owned by the normal fixed slot and can be regenerated; it is not a prerequisite for a fresh checkout. Recovery of an interrupted run still requires that run's original durable local evidence.

### Optional post-promotion completion

Managed prebuilt delivery can opt into a finite list of consumer-owned, idempotent jobs:

```json
"completion": {
  "idempotent": true,
  "jobs": [{ "command": "node", "args": ["scripts/complete-release.mjs"], "timeoutMs": 120000 }]
}
```

Omitting this field preserves existing behavior. It is supported only with managed prebuilt delivery, with 1–32 jobs and the normal command, cancellation, resource and foreground-close budgets. Jobs run after promotion of the exact deployment, production alias/marker/build-info verification, and optional version-route verification. Admission runs again with `FORGE_RELEASE_PHASE=completion`. Keep the same external project serialization through completion and any explicit retry.

Jobs run in the original frozen checkout under the same local slot lock, native process runner and journal. Protected `FORGE_RELEASE_COMPLETION_CONTEXT` contains only `teamId`, `projectId`, `sourceSha`, `configSha256`, `artifactSha256`, `deploymentId`, `candidateUrl`, `productionUrl` and optional `versionUrl`. `FORGE_RELEASE_URL` is the stable production origin during completion; candidate acceptance continues to use its original route. Inherited metadata cannot override these values. Consumers own business authorization, remote idempotency and proof that each job's external effects completed. Do not print secrets in command output.

Reports expose `completion.status` (`not-started`, `running`, `failed`, `unknown`, `completed`) and append-only attempts with per-job durations and command evidence. Completion failure, cancellation or uncertain process closure keeps the accepted create/alias/promote effects and returns failure. The tool does not roll back, upload again, reassign or promote again to repair a job. A new SHA `check` or `publish` cannot replace the pending candidate's original checkout, Git metadata or sealed artifact.

Observe with `status`. When local stop is unproved, finish the normal `recover` procedure first. A plain `verify` never replays pending completion. Explicitly retry all declared jobs for the original SHA only when their consumer-owned idempotency makes this safe:

```sh
pnpm exec forge-vercel-release verify --sha <original-full-sha> --retry-completion
```

The SDK equivalent is `runRelease({ command: 'verify', cwd, sha, retryCompletion: true })`. It reads the original committed configuration and artifact without installing, rebuilding or copying them, re-verifies the same production target, and appends a new attempt. Earlier failed or unknown attempts and original receipts remain unchanged. There are at most 32 attempts. Verified completion releases the input pin; repeating verify observes completed evidence without rerunning jobs. Changed or missing original inputs, divergent history, conflicting targets and unknown native stop remain blocked. Losing the local slot is not a supported way to recover an unfinished business operation.

If the coordinator exits before its publish receipt is committed, recovery can use only the anchor-bound, archived original intent after local stop is proved. Final retirement evidence binds the original run, slot, source and anchor. Job results come from the original execution records. The report sets `recovery.reportExists` to `false` while the successful receipt is absent. Fresh checkouts need no prior temporary files for normal development or publication. Resuming an interrupted operation requires its original durable local evidence.

### Optional version hostname

For a version URL that must be known before building, add this optional field inside `delivery`:

```json
"versionAlias": { "hostnameTemplate": "site-{sha}.vercel.app" }
```

The template accepts one full lowercase 40-character Git SHA placeholder, a lowercase ASCII prefix of 1–22 letters, digits or internal hyphens, and the exact `.vercel.app` suffix. Schemes, paths, ports, other domains and the production hostname are rejected. Omitting the field preserves existing behavior. Prepare/check receive protected `FORGE_RELEASE_VERSION_URL`, `FORGE_RELEASE_CONFIG_SHA256` and an empty `FORGE_RELEASE_CANDIDATE_CONTEXT` until an exact candidate exists. These values are available to the committed build; no prior temporary output or Codex session is needed.

Publish checks that the hostname is unused before staging, then re-reads it after the candidate is READY. An existing direct binding to that exact project/ID is only observed. Otherwise it saves a separate alias intent and sends at most one assignment POST. Only a confirmed 404 means absent; authentication, malformed or indirect routing and other API failures stop the operation. A conflicting binding fails with `VERSION_ALIAS_CONFLICT`; it is never deliberately reassigned or repaired. The version route must serve the matching source/config/artifact marker and revision before acceptance, and is rechecked before and after promoting the same deployment ID. This mode adds `FORGE_RELEASE_PHASE=version-alias` to admission. Acceptance uses the version URL as `FORGE_RELEASE_URL`.

After candidate creation, `report.candidateContext` and the protected JSON `FORGE_RELEASE_CANDIDATE_CONTEXT` contain only `teamId`, `projectId`, `sourceSha`, `configSha256`, `artifactSha256`, `deploymentId`, `candidateUrl`, `versionUrl` and `versionAliasVerified`. They contain no credentials or full configuration. Use the verified version route for consumer-owned checks and registration. The context is identity evidence, not business authorization.

`prebuilt.versionAlias` records the hostname, effect and verification independently of `effects.versionAliasAssign`. After cancellation, timeout or a lost response, repeat publish refuses to replay an uncertain assignment; use `status` to observe or `verify` to observe and run the original acceptance. These commands never assign aliases or promote. A missing hostname remains unresolved, including interruption after intent but before POST. Before later cloud writes, a separate proof must bind the original hostname/source/config/artifact/ID; the original unknown journal is immutable. Local `recover` still needs no Vercel credentials. All default prebuilt API reads and writes require protected `VERCEL_TOKEN` as described above.

Vercel's assignment API can move an existing alias and provides no atomic create-if-absent condition. All writers must share the external serialization described above, covering version aliases as well as promotion. A pre-read cannot prevent an uncoordinated outside writer from racing; an unexpected old deployment in the response stops with uncertainty and no compensating write. Consumers own capacity, deployment retention, current references and rollback policy. This feature does not retain every historical deployment indefinitely or register the version hostname as a project production domain.

## Commands and side effects

The table describes the default Git delivery. Prebuilt delivery follows the staged candidate and promotion protocol above; `check` remains local and `status`/`verify` observe the saved candidate without cloud writes.

| Command | Behavior |
| --- | --- |
| `check` | Verify root, remote, clean development branch, run checks, and confirm HEAD/source/config remain frozen. No remote writes or Vercel requests. |
| `publish` | Acquire an exclusive local project lock; freeze HEAD; fetch and validate both remote branches as ancestors of that SHA; authenticate and check project ownership, repository link and production branch; run checks; revalidate the candidate and remotes; check project binding and lock ownership before each ordinary, non-force, exact-SHA push to development then release branch; wait for the matching authoritative Git integration production deployment to become READY; verify alias, anonymous build marker, and acceptance jobs. |
| `status` | Read a deployment for `--sha`, otherwise the latest publish receipt's frozen SHA, otherwise local HEAD if no receipt exists. Returns deployment state; successful querying alone does not imply READY. No checks, acceptance, or pushes. |
| `verify` | Independently query project and deployment, require READY and correct Git source, then verify production alias, anonymous build marker, and acceptance jobs. Uses the same SHA selection as `status`. No pushes. |
| `login` | Explicitly delegate to the pinned official Vercel CLI and let the user authorize it. No release config is required. Bounded to ten minutes. The CLI prints login instructions to stderr. |
| `recover` | Managed mode only: verify cessation and ownership, archive original outcomes, observe refs and finish local cleanup. Vercel login and unchanged remote tips are not local prerequisites. No install, checks, acceptance, pushes, deployment creation or rollback. |
| `retire` | Select a managed run by ID, verify the original host and persisted cessation evidence, archive the original history, and release the exact lock. Historical verification remains UNKNOWN. |

Shared options are `--cwd DIR`, `--config FILE`, and `--sha SHA` (only `status`/`verify`). `retire` requires `--run-id UUID`. `--help` prints JSON usage. Standard output is one structured JSON report. Exit codes are `0` for success, `1` for operational failure or missing retirement evidence, and `2` for invalid CLI arguments. SIGINT/SIGTERM cancel active work. Managed lock release requires proven cessation and trusted local metadata. Git delivery reads deployment information through `vercel api --raw --non-interactive`. Default prebuilt API reads use the bounded native GET and protected token described above. Prebuilt publish uses the explicit writes described above. The `login` command initiates login.

Execution outcome, process cessation, local disposition and remote effects are separate facts. Safe local cleanup preserves the original state, receipts and `unknown` effects in bounded immutable `history/<RUN_ID>.json` records. The archive's `release-ready` flag authorizes exact lock release; it does not claim the subsequent unlink succeeded. Its optional `outcome` records execution before that release. New runs bind previous history contents and file identities, so a later check cannot erase uncertainty and missing/replaced history fails closed.

The normal managed entry can finish a previously stopped run before starting fresh checks. `recover` also provides an explicit entry. Local cleanup can complete when remote refs advance or become unreachable. Every later remote mutation rechecks unresolved historical intents: current candidate or `superseded` ancestry can establish the current remote fact; `before`, `diverged` or `unknown` blocks mutation. Original effects remain unchanged. If a lost-response intent targets the same SHA, repository and branch and fresh reads show that candidate is already current, the new run records `already-current` without sending that push again. Other pushes remain ordinary exact-SHA, non-force operations. No recovery command creates deployments. Missing cessation evidence or an active/unknown coordinator still blocks reuse; PID absence alone never repairs a crash gap.

### Explicit retirement of an interrupted run

Use the run ID in the report to request local retirement. `recovery.reportExists` indicates whether the retirement checkpoint or final archive at `recovery.reportPath` exists. The archive preserves the original execution status and receipt bytes.

```sh
pnpm exec forge-vercel-release retire --run-id <RUN_ID>
```

Retirement requires the original hashed host identity, an inactive coordinator, and persisted stop evidence for the exact run. Recorded native scope closures and SDK no-start witnesses produce `recorded-stopped-scopes`. A matching failed first-Git receipt on Windows can establish `recorded-empty-unstarted-scope` when the native provider recorded an empty scope before binding and the run attempted no external writes. A bare intent or unresolved effect blocks retirement. A terminal record sealed independently of a timed-out checkout scan is available to `recover`.

On Windows, a failed final check with a matching `CLOSURE_UNPROVEN` receipt can also establish `recorded-empty-drained-scope`. This requires the original bound native Job to report `descendants-remained` and a final empty set, a recorded root exit, stop proof for earlier commands, and all release effects recorded as `not-attempted`. Retirement verifies the original process identities and archives the failed receipt and original unknown state unchanged. After the old lock is released, ordinary `recover` in the same source root can verify this archive and return `ok: true` with closed processes and the original run, source, configuration and effects. The recovery result describes local cessation. The original check is still a failure.

The native directory lease from `@openge/forge-process-control-node` covers each SDK invocation and serializes recovery and retirement. It uses a Windows mutex or Linux directory flock. The invocation releases the native lease when it returns, retaining its durable lock and journal if recovery is required. A caller can invoke recovery in the same Node process. Recovery acquires the same lease and independently verifies that each managed command has stopped or never started. Each protocol can resume its own interrupted claim. The tool verifies the original source, file identities and bytes before writing an archive under `retired/<RUN_ID>.json` and releasing the durable lock. Remote observations are recorded separately. Each history or retirement archive counts against the slot budget and is limited to 8 MiB.

The Node equivalent is `runRelease({ command: 'retire', cwd, runId })`. Exit 0 with `retirement.status: "retired"` confirms the local retirement transaction. The archive records `historicalVerification: "unknown"` and the original effects. The empty-scope path records remote refs as `unknown`. A subsequent publish still runs the remote gates. Retirement applies to managed runs.

`recover --run-id <RUN_ID> --discard-checkout` (SDK `discardCheckout: true`) archives the exact stopped run and discards its original checkout when the run attempted no external writes and has no pending completion. The report sets `recovery.checkoutDiscarded` only after the original directory is absent. The archive binds the old directory identity before deletion. A later recovery completes an interrupted discard, and new admission refuses to reuse the directory while the discard is pending.

An anchored source root selects one fixed slot. To select a replacement slot while preserving an unprovable old run, use a fresh independent source checkout and commit its new `source.slotPath`. The caller must fence the old writer at the target, account for admitted or queued operations, reconcile the original candidate's exact refs and deployments, and keep target-level serialization across the transition and new publication. Keep the original checkout and metadata for investigation. The new root has a distinct anchor and slot identity. A different path in an already anchored root is rejected.

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

The root exports only contracts and `releaseErrorCodes`, and is browser-safe. `./node` is explicitly `browser: null` and exports `runRelease`, `validateReleaseConfig`, and `ReleaseError`. Options include `command`, `cwd`, `configPath`, workspace-only `config`, `sha`, `signal`, `transport`, and `onLoginOutput`. Config objects are cloned/validated; managed callers must use a committed file. `transport` supplies explicit `api(path, signal)`, anonymous `buildInfo(url, signal)`, and optional prebuilt `promote(deploymentId, signal)` boundaries. Version mode additionally requires `versionAlias.read(hostname, signal)` and, for publish, `versionAlias.assign(deploymentId, hostname, signal)`. Read returns a direct `VersionAliasBinding`, or `undefined` only for confirmed absence; assign returns `VersionAliasAssignment`. Custom transports must honor abort signals, close their resources, and never retry a promotion or alias write. Node callers supply `onLoginOutput` to display redacted official login instructions.

Reports include schema 2, timestamps, SHA/config digest, source/execution roots, run/slot identity, stage, budget/process summaries, bounded job steps, separate push effects, deployment and errors. Managed metadata lives in the slot: ownership, run/recovery locks, state, terminal proof, immutable history and separate latest-check/latest-publish receipts. The source `state/forge-vercel-release/managed.json` anchors slot/config/publish identity. A state/receipt is at most 1 MiB, anchor at most 64 KiB, and each persisted step stdout/stderr at most 2048 UTF-8 bytes with `truncated`; effects/diagnostics are never clipped. Writes reserve peak bytes and verify the relevant ownership boundaries. Foreign slots, unproven locks and unknown atomic-write remnants are not automatically removed. Workspace mode retains `state/forge-vercel-release/latest-publish.json` and its config-digest/explicit-SHA selection; recover is unsupported there. Receipts are local recovery evidence, not signed authorization. Abrupt termination may retain locks. Live login output buffers partial lines for cross-chunk redaction and uses the same finite per-stream budget.

Node options additionally accept `buildInfoHttp: NodeHttpTransportOptions` from `@openge/forge-http-transport`, for example `{ route: 'proxy', environment: proxySnapshot }`. It selects the route for build-info and artifact-marker reads. The default is explicit direct with no host proxy environment access. Each read owns a transport and closes it on success, cancellation, output overflow and HTTP/JSON failure. Redirects are not followed. A complete custom `transport` takes precedence. Network options are not persisted in release configuration, digests or receipts.

Managed prebuilt releases also accept `vercelApiHttp: NodeHttpTransportOptions` for native requests to `api.vercel.com`, including version-alias assignment and promotion. The default is direct. `{ route: 'proxy', environment: proxySnapshot }` selects the route from the supplied `HTTPS_PROXY`/`NO_PROXY` values (lowercase equivalents take precedence). You can supply `proxyUrl` and `tls` explicitly. Each request owns its transport, caps the response, and waits for shutdown before returning. A write is sent once. Use either native API routing or a custom `transport`. The pinned staging CLI keeps its own networking configuration.

To continue an already created managed prebuilt candidate in the same slot, use the latest stopped publication identity:

```ts
await runRelease({
  command: 'publish', cwd,
  resumePrebuilt: { runId, sha, configSha256, artifactSha256, deploymentId },
  vercelApiHttp: { route: 'proxy', environment: proxySnapshot },
});
```

The SDK reads existing schema 2 receipts and archived stop evidence. It checks the exact checkout and sealed artifact, then observes readiness, finishes any version-alias admission and assignment, runs acceptance, promotion admission and promotion, and runs configured completion. The command environment remains `publish`. Existing `version-alias`, `promote` and completion phase semantics apply. `status` can confirm staged readiness and the candidate marker before version-alias assignment has been attempted. An accepted or uncertain promotion is only observed. If completion is pending, use the existing `status` and explicit completion retry flow.

The caller keeps external target serialization and can reuse its original writer identity. A rejected identity or damaged input leaves `latest-publish` in place. A started continuation has its own run ID and its next persisted receipt becomes `latest-publish`. The prior receipts remain archived. If an interruption prevents a new receipt, recover the stopped run and use the exact archived identity exposed by `status`.

Managed prebuilt `publish`, `status`, and `verify` can also supply `candidateMarkerAuth: ResolveCandidateMarkerAuth` to the native transport. The callback receives a `PrebuiltMarkerCandidate` with `teamId`, `projectId`, `deploymentId`, and canonical HTTPS `origin`, plus the request's `AbortSignal`. The SDK invokes it only after the native provider confirms the bound candidate is READY. It reuses a successful result for that candidate binding within one `runRelease` call, including completion and any verification of unresolved publication effects. The callback may return `undefined` for an anonymous read. It must honor the signal and resolve within the marker request budget. Supply credentials that remain valid for the invocation.

To authenticate a candidate marker, return `CandidateMarkerAuth` with the exact `origin` and at least one of the lowercase header keys `x-vercel-trusted-oidc-idp-token`, `x-vercel-protection-bypass`, or `cookie`. Resolution failures, origin mismatches and invalid headers fail closed with `AUTH_REQUIRED`. The SDK uses these credentials only for the candidate marker GET, with the selected proxy route, no redirects, and the same source/config/artifact digest checks. Production and version alias reads, provider API requests, and application commands do not receive the credentials. The SDK keeps credentials in memory for the current invocation and does not include them in diagnostics or receipts. Supplying both `candidateMarkerAuth` and custom `transport` is an argument error.

## Error codes

| Codes | Meaning |
| --- | --- |
| `ARGUMENT_INVALID`, `CONFIG_INVALID`, `CONFIG_READ` | Invalid options, strict configuration violation, or unreadable/invalid JSON file. |
| `GIT_FAILED`, `GIT_DIRTY`, `GIT_BRANCH`, `GIT_REPOSITORY`, `GIT_DIVERGED` | Git execution, dirty source, wrong branch/root/remote, or missing/non-fast-forward remote branches. |
| `CANDIDATE_CHANGED` | HEAD, tracked/untracked source, remote identity, or config changed during checks. |
| `ARTIFACT_INVALID`, `ARTIFACT_CHANGED`, `ADMISSION_FAILED` | Unsafe/non-self-contained Build Output, changed local/remote artifact binding, or rejected consumer quota/content admission. |
| `CHECK_FAILED`, `ACCEPTANCE_FAILED`, `COMPLETION_FAILED` | A configured check, acceptance or post-promotion completion command failed. |
| `COMMAND_TIMEOUT`, `COMMAND_FAILED`, `CANCELLED` | A bounded process timed out, executable could not be resolved, or operation was cancelled. |
| `LOCKED`, `LOCK_OWNERSHIP` | Another lock exists, or the lock changed ownership before release. |
| `AUTH_REQUIRED`, `VERCEL_API` | CLI or provider authentication required, invalid candidate marker authentication input or resolver failure, failed/malformed API response, bounded request timeout or output overflow. |
| `DEPLOYMENT_SOURCE`, `DEPLOYMENT_MISSING`, `DEPLOYMENT_FAILED`, `DEPLOYMENT_TIMEOUT` | Wrong project/team/SHA/branch/source/target, no exact matching deployment, terminal failure/not READY, or bounded wait exhausted. |
| `ALIAS_MISMATCH`, `BUILD_INFO`, `BUILD_REVISION` | Wrong production alias/project/deployment, marker unavailable/oversized/invalid, or wrong revision. |
| `VERSION_ALIAS_CONFLICT` | Occupied, changed or unconfirmed direct version-hostname binding, including a reported external reassignment. |
| `IO_FAILED` | Local file/process/runtime failure outside a more specific contract. |
| `SOURCE_CHANGED`, `SOURCE_UNSUPPORTED`, `RECEIPT_SHA_MISMATCH` | Changed/unsupported frozen source or unknown receipt SHA. |
| `SLOT_PATH`, `SLOT_FOREIGN`, `SLOT_STATE`, `SLOT_NOT_FAST_FORWARD` | Unsafe/replaced path, unowned slot, invalid management evidence or non-fast-forward reuse. |
| `BUDGET_EXCEEDED`, `BUDGET_UNKNOWN` | Admission/observed limit violation or incomplete observation. |
| `PROCESS_STATE_UNKNOWN`, `RECOVERY_REQUIRED` | Unproven process closure/effects or retained run needing inspection. |

Known credential-shaped output is redacted; configured commands remain trusted executable code and must not print secrets. The official CLI is pinned to `64.7.0`; its required transitive WASM peers are explicitly pinned to preserve strict peer installation. This package reuses public Forge command-runner/process-control and artifact-integrity capabilities. No third-party implementation types appear in its public contract.

See the [Chinese package guide](../../docs/packages/release-tooling/release-vercel.md), [official CLI API documentation](https://vercel.com/docs/cli/api), and [Vercel deployment API](https://vercel.com/docs/rest-api/deployments/list-deployments).
