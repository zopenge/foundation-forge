# Foundation P0–P2 公共能力实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增四个领域中立、独立发布的 Foundation 包，并先完成 Foundation 内部迁移和真实 tarball 消费验证。

**Architecture:** `repository-files` 只负责只读 Git 文件发现；`deterministic-json` 只负责严格 JSON 值的确定性排序与序列化；`artifact-integrity` 将跨运行时字节校验与 Node 文件校验分入口；`archive-safety` 只验证归档条目和资源限制，不负责下载或解压。外部仓库只在 RC 已通过 OIDC 发布后使用精确版本迁移，禁止提交 `file:`、tgz 或 workspace 依赖。

**Tech Stack:** TypeScript 6、NodeNext ESM、Node.js `>=22.14.0`、pnpm 10.33.2、Vitest 4、Changesets。

**Spec:** `docs/architecture/boundaries.md` 与本文件的接口定义。

## Global Constraints

- 四个新包初始版本均为 `0.1.0-rc.0`，相互独立版本化。
- 所有公开类型均由 Foundation 持有，不暴露 Git 工具、归档 Provider 或第三方实现类型。
- 根运行时入口不得引用 `node:*`；Node 专属能力使用 `/node` 入口。
- 禁止隐式 fallback、运行时自动 Provider 选择、业务错误文案和产品配置环境变量。
- 所有功能以失败测试开始；每个包必须通过 lint、typecheck、test、coverage、build 和真实 tarball 消费验证。
- 未获得明确授权前不提交、不推送、不打 tag、不发布 npm。

---

### Task 1: Repository Files

**Files:**
- Create: `packages/repository-files/src/{contracts,errors,git-process,paths,repository-files,index}.ts`
- Create: `packages/repository-files/tests/*.test.ts`
- Create: `packages/repository-files/{package.json,README.md,LICENSE,NOTICE,tsconfig.json,tsconfig.build.json,vitest.config.ts}`
- Modify: `packages/text-integrity/src/node/{git,scan}.ts`
- Modify: `packages/text-integrity/package.json`

**Interfaces:**
- Produces: `findRepositoryRoot(startPath?, options?)`, `listRepositoryFiles(options?)`, `listChangedRepositoryFiles(options?)`, `filterIgnoredRepositoryPaths(paths, options?)`, `normalizeRepositoryPath(path)`。
- All returned paths are normalized repository-relative paths sorted by UTF-16 code-unit order.
- `listChangedRepositoryFiles` excludes deleted paths by default and returns rename/copy targets.
- Git absence, non-repository input and command failures throw `RepositoryFilesError` with stable codes; no recursive filesystem fallback is allowed.

- [ ] Write integration tests using repositories under `packages/repository-files/.tmp/` for tracked, untracked, ignored, renamed, copied, deleted, nested repository, spaces and abort behavior.
- [ ] Run the focused test and confirm it fails because the package/API does not exist.
- [ ] Implement the minimal Git process, parsing, normalization and error contracts.
- [ ] Run focused lint, typecheck and tests until green.
- [ ] Replace Text Integrity Git discovery with the new workspace dependency and delete its duplicate Git process/parser implementation.
- [ ] Run the complete Text Integrity suite and both package builds.

### Task 2: Deterministic JSON

**Files:**
- Create: `packages/deterministic-json/src/{contracts,errors,validation,sorting,stringify,index}.ts`
- Create: `packages/deterministic-json/tests/*.test.ts`
- Create: package metadata, README, license, notice and TypeScript/Vitest configs.

**Interfaces:**
- Produces: `assertJsonValue(value)`, `sortJsonValue(value)`, `stringifyDeterministicJson(value, options?)`.
- Options: `{ space?: number | string; trailingNewline?: boolean }`.
- Accepts only null, boolean, finite number, string, arrays and plain string-keyed objects.
- Rejects `undefined`, bigint, symbol, function, non-finite number, cycles, sparse arrays, custom prototypes and `toJSON` objects with `DeterministicJsonError`.
- Object keys use code-unit ordering; arrays preserve order; input values are never mutated.

- [ ] Write failing tests for stable nested ordering, formatting, immutability and every rejected value class.
- [ ] Run tests and verify the missing API failure.
- [ ] Implement validation, sorting and serialization without runtime dependencies.
- [ ] Run focused lint, typecheck, coverage and build.

### Task 3: Artifact Integrity

**Files:**
- Create: `packages/artifact-integrity/src/{contracts,errors,digest,bytes,index,node}.ts`
- Create: `packages/artifact-integrity/src/node/file-integrity.ts`
- Create: `packages/artifact-integrity/tests/*.test.ts`
- Create: package metadata, README, license, notice and TypeScript/Vitest configs.

**Interfaces:**
- Root produces: `parseSha256Digest(value)`, `formatSha256Digest(digest)`, `calculateBytesIntegrity(bytes)`, `verifyBytesIntegrity(bytes, expected)`.
- `/node` produces: `calculateFileIntegrity(path, options?)`, `verifyFileIntegrity(path, expected, options?)`.
- Integrity values use `{ byteLength: number; sha256: string }`; expected digests are normalized lowercase hexadecimal.
- Root hashing uses Web Crypto and contains no Node imports. Node file hashing rejects symlinks and non-regular files and observes `AbortSignal`.
- Failures use `ArtifactIntegrityError` and stable mismatch, invalid-digest, invalid-expectation, non-regular-file and aborted codes.

- [ ] Write failing root tests using known SHA-256 vectors and mismatch/validation cases.
- [ ] Write failing Node tests for regular files, symlinks, byte length, digest mismatch and cancellation.
- [ ] Implement the root and `/node` entries.
- [ ] Run focused lint, typecheck, coverage and build and assert the root dependency graph has no `node:*` import.

### Task 4: Archive Safety

**Files:**
- Create: `packages/archive-safety/src/{contracts,errors,entry-path,limits,index}.ts`
- Create: `packages/archive-safety/tests/*.test.ts`
- Create: package metadata, README, license, notice and TypeScript/Vitest configs.

**Interfaces:**
- Produces: `validateArchiveEntryPath(path)`, `inspectArchiveEntries(entries, limits?)`.
- Entry contract: `{ path: string; kind: 'file' | 'directory' | 'symbolic-link' | 'hard-link' | 'other'; uncompressedBytes?: number }`.
- Rejects absolute/drive/UNC paths, backslashes, NUL, empty/dot/parent segments, links and unsupported entry kinds.
- Limits require positive safe integers and default to `10_000` entries and `1_073_741_824` expanded bytes.
- Returns `{ entryCount, fileCount, directoryCount, expandedBytes }`; it performs no extraction or filesystem I/O.

- [ ] Write failing tests for safe paths, traversal variants, link rejection, invalid sizes, entry limit and expanded-byte limit.
- [ ] Run tests and verify the missing API failure.
- [ ] Implement pure validation and aggregation.
- [ ] Run focused lint, typecheck, coverage and build.

### Task 5: Repository Integration and Packaging

**Files:**
- Modify: `README.md`, `docs/architecture/boundaries.md`, `scripts/verify-packages.mjs`, `pnpm-lock.yaml`.
- Create: one Changeset for the Text Integrity dependency change and one initial Changeset entry per new package where required by release tooling.

**Interfaces:**
- Clean consumer imports every public entry from actual tgz files and executes one representative operation per package.
- Browser-boundary verification includes Deterministic JSON, Artifact Integrity root and Archive Safety source files.

- [ ] Update the public package catalog, installation examples and ownership boundaries in English README content.
- [ ] Extend package metadata, browser-boundary and tarball consumer verification.
- [ ] Install with pnpm and review the lockfile for only expected workspace changes.
- [ ] Run `pnpm check` with a finite timeout and inspect every failure rather than adding fallback behavior.
- [ ] Review `git diff --check`, package contents, changesets and repository status.

### Task 6: External Consumer Migration After RC Publication

**Files:**
- AI Forge: root `package.json`, AI Context Git/JSON helpers, AI Kit integrity/archive helpers and relevant tests.
- Runtime Forge: `package.json`, AI Context Git/JSON helpers, third-party archive inspection and relevant tests.
- Link Light: `package.json`, AI Context/project-map Git/JSON helpers, config archive validation and relevant tests.

**Interfaces:**
- Consumers use exact RC versions; no `workspace:`, `file:`, tgz or Git URL dependency is committed.
- AI/Runtime/Link retain only repository-specific ignore policy, output formatting options and Provider extraction code.

- [ ] Obtain explicit authorization to publish the four RC packages.
- [ ] Publish from clean Foundation `main` through the approved Trusted Publisher workflow and verify provenance/tarballs.
- [ ] Migrate AI, Runtime and Link one repository at a time using exact RC versions.
- [ ] Regenerate AI Context only through each repository's official generator and review derived diffs.
- [ ] Run each repository's focused tests followed by lint, typecheck, complete affected suites and context checks.
- [ ] Stop before commit/push/merge until those Git actions receive separate explicit authorization.
