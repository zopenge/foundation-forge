import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SourceSecretRule, SourceSnapshotPolicyInput, SourceTextPackOptions } from '../content-contracts.js';
import { SourceSnapshotError } from '../errors.js';
import type { SourceSnapshotCliConfig, SourceSnapshotCliContext, SourceSnapshotCliOutcome, SourceSnapshotStorageLayoutOptions, SourceSnapshotStoreBudget } from './contracts.js';
import { verifyRepositorySnapshotFreeze } from './pipeline.js';
import { prepareRepositorySnapshot, type PreparedRepositorySnapshotPlan } from './prepared-pipeline.js';
import { inspectSourceSnapshotRetention, pruneSourceSnapshots } from './retention.js';
import { publishPreparedSourceSnapshot, verifyPublishedSourceSnapshot } from './publish.js';
import { readPublishedSourceSnapshotText, unpackPublishedSourceSnapshot } from './read.js';

type Command = 'plan' | 'export' | 'verify' | 'status' | 'prune' | 'read' | 'unpack';
interface ParsedArgs {
  readonly command: Command; readonly configPath: string; readonly json: boolean; readonly dryRun: boolean;
  readonly targetRoot?: string; readonly ownerId?: string; readonly snapshotId?: string;
  readonly path?: string; readonly outputRoot?: string;
}
interface LoadedConfig extends SourceSnapshotCliConfig { readonly configPath: string; }

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SourceSnapshotError('INVALID_INPUT', { field: 'config' });
  return value as Record<string, unknown>;
};
const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new SourceSnapshotError('INVALID_INPUT', { field });
  return value;
};
const resolveFrom = (base: string, value: string): string => isAbsolute(value) ? resolve(value) : resolve(base, value);
const packOptions = (value: unknown): SourceTextPackOptions => {
  const input = record(value);
  const fields = ['targetObjectBytes','maxObjectBytes','maxObjectCount','maxObjectBytesTotal'] as const;
  const output: Record<(typeof fields)[number], number> = { targetObjectBytes: 0, maxObjectBytes: 0, maxObjectCount: 0, maxObjectBytesTotal: 0 };
  for (const field of fields) { const current = input[field]; if (!Number.isSafeInteger(current) || (current as number) < 0) throw new SourceSnapshotError('INVALID_INPUT', { field: `pack.${field}` }); output[field] = current as number; }
  const textFormatVersion = input.textFormatVersion;
  if (textFormatVersion !== undefined && textFormatVersion !== 1 && textFormatVersion !== 2) throw new SourceSnapshotError('INVALID_INPUT', { field: 'pack.textFormatVersion' });
  return { ...output, ...(textFormatVersion === undefined ? {} : { textFormatVersion }) };
};
const storeBudgetOptions = (value: unknown): SourceSnapshotStoreBudget => {
  const input = record(value);
  const fields = ['maxManagedFiles','maxManagedBytes'] as const;
  const output: Record<(typeof fields)[number], number> = { maxManagedFiles: 0, maxManagedBytes: 0 };
  for (const field of fields) { const current = input[field]; if (!Number.isSafeInteger(current) || (current as number) < 0) throw new SourceSnapshotError('INVALID_INPUT', { field: `storeBudget.${field}` }); output[field] = current as number; }
  return output;
};
const parseArgs = (argv: readonly string[], cwd: string): ParsedArgs => {
  const [rawCommand, ...tokens] = argv;
  const commands: readonly Command[] = ['plan','export','verify','status','prune','read','unpack'];
  if (!commands.includes(rawCommand as Command)) throw new SourceSnapshotError('INVALID_INPUT', { field: 'command' });
  let configPath = resolve(cwd, 'source-snapshot.config.mjs'); let json = false; let dryRun = false;
  let targetRoot: string | undefined; let ownerId: string | undefined; let snapshotId: string | undefined;
  let path: string | undefined; let outputRoot: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]; if (token === '--') continue;
    if (token === '--json') { json = true; continue; }
    if (token === '--dry-run') { dryRun = true; continue; }
    const next = (): string => { const value = tokens[++index]; if (value === undefined || value.startsWith('--')) throw new SourceSnapshotError('INVALID_INPUT', { field: token }); return value; };
    if (token === '--config') { configPath = resolve(cwd, next()); continue; }
    if (token === '--target-root') { targetRoot = resolve(cwd, next()); continue; }
    if (token === '--owner-id') { ownerId = next(); continue; }
    if (token === '--snapshot-id') { snapshotId = next(); continue; }
    if (token === '--path') { path = next(); continue; }
    if (token === '--output') { outputRoot = resolve(cwd, next()); continue; }
    throw new SourceSnapshotError('INVALID_INPUT', { field: 'argument', value: token });
  }
  if (dryRun && rawCommand !== 'prune') throw new SourceSnapshotError('INVALID_INPUT', { field: 'dryRun' });
  return {
    command: rawCommand as Command, configPath, json, dryRun,
    ...(targetRoot === undefined ? {} : { targetRoot }),
    ...(ownerId === undefined ? {} : { ownerId }),
    ...(snapshotId === undefined ? {} : { snapshotId }),
    ...(path === undefined ? {} : { path }),
    ...(outputRoot === undefined ? {} : { outputRoot }),
  };
};

const loadConfig = async (configPath: string): Promise<LoadedConfig> => {
  const metadata = await stat(configPath);
  if (!metadata.isFile()) throw new SourceSnapshotError('INVALID_INPUT', { field: 'configPath' });
  const module = await import(`${pathToFileURL(configPath).href}?snapshot=${metadata.mtimeMs}`) as Record<string, unknown>;
  const value = record(module.default); const base = dirname(configPath);
  const groupForPath = typeof module.groupForPath === 'function' ? module.groupForPath : value.groupForPath;
  if (typeof groupForPath !== 'function') throw new SourceSnapshotError('INVALID_INPUT', { field: 'groupForPath' });
  const storage = value.storage === undefined ? undefined : record(value.storage) as SourceSnapshotStorageLayoutOptions;
  const storeBudget = value.storeBudget === undefined ? undefined : storeBudgetOptions(value.storeBudget);
  const retention = value.retention === undefined ? undefined : record(value.retention) as LoadedConfig['retention'];
  const additionalSecretRules = value.additionalSecretRules;
  if (additionalSecretRules !== undefined && !Array.isArray(additionalSecretRules)) throw new SourceSnapshotError('INVALID_INPUT', { field: 'additionalSecretRules' });
  const normalizedRules = additionalSecretRules as readonly SourceSecretRule[] | undefined;
  const submoduleHeadPolicy = value.submoduleHeadPolicy;
  if (submoduleHeadPolicy !== undefined && submoduleHeadPolicy !== 'require-gitlink' && submoduleHeadPolicy !== 'allow-checked-out') throw new SourceSnapshotError('INVALID_INPUT', { field: 'submoduleHeadPolicy' });
  return {
    configPath, projectId: requiredString(value.projectId, 'projectId'), policyVersion: requiredString(value.policyVersion, 'policyVersion'),
    sourceRoot: resolveFrom(base, requiredString(value.sourceRoot, 'sourceRoot')),
    ...(submoduleHeadPolicy === undefined ? {} : { submoduleHeadPolicy }),
    targetRoot: resolveFrom(base, requiredString(value.targetRoot, 'targetRoot')),
    lockPath: resolveFrom(base, requiredString(value.lockPath, 'lockPath')), ownerId: requiredString(value.ownerId, 'ownerId'),
    policy: record(value.policy) as SourceSnapshotPolicyInput, pack: packOptions(value.pack),
    groupForPath: groupForPath as LoadedConfig['groupForPath'],
    ...(normalizedRules === undefined ? {} : { additionalSecretRules: normalizedRules }),
    ...(storage === undefined ? {} : { storage }), ...(storeBudget === undefined ? {} : { storeBudget }),
    ...(retention === undefined ? {} : { retention }),
  };
};
const storageOptions = (config: LoadedConfig): SourceSnapshotStorageLayoutOptions => config.storage ?? {};
const planOptions = (config: LoadedConfig, publishedAt: number) => ({
  sourceRoot: config.sourceRoot, projectId: config.projectId, policyVersion: config.policyVersion, publishedAt,
  policy: config.policy, pack: config.pack, groupForPath: config.groupForPath,
  ...(config.submoduleHeadPolicy === undefined ? {} : { submoduleHeadPolicy: config.submoduleHeadPolicy }),
  ...(config.additionalSecretRules === undefined ? {} : { additionalSecretRules: config.additionalSecretRules }),
});
const retentionOptions = (config: LoadedConfig, now: number) => ({
  targetRoot: config.targetRoot, ownerId: config.ownerId, now, ...storageOptions(config),
  ...(config.retention?.keepCount === undefined ? {} : { keepCount: config.retention.keepCount }),
  ...(config.retention?.orphanGraceMs === undefined ? {} : { orphanGraceMs: config.retention.orphanGraceMs }),
});
const safePlanSummary = (plan: PreparedRepositorySnapshotPlan) => ({
  status: plan.status, publishAllowed: plan.publishAllowed,
  snapshotId: plan.manifest?.snapshotId ?? null,
  repositoryCount: plan.inventory.summary.repositoryCount, candidateCount: plan.inventory.summary.candidateCount,
  includedCount: plan.includedPaths.length,
  excludedCount: plan.decisions.filter(value => value.decision.action === 'exclude').length,
  reviewCount: plan.reviewEntries.length, secretFindingCount: plan.secretFindings.length,
  contentIssueCount: plan.contentIssues.length, inventoryIssueCount: plan.inventory.issues.length,
  includedPaths: plan.includedPaths, reviewEntries: plan.reviewEntries,
  secretFindings: plan.secretFindings, contentIssues: plan.contentIssues, inventoryIssues: plan.inventory.issues,
});
const emit = (write: (value: string) => void, value: unknown, json: boolean): void => {
  if (json) write(`${JSON.stringify(value, null, 2)}\n`);
  else write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
};
const outcome = (exitCode: 0 | 1 | 2, result: Readonly<Record<string, unknown>>): SourceSnapshotCliOutcome => Object.freeze({ exitCode, result: Object.freeze(result) });

export const runSourceSnapshotCli = async (argv: readonly string[] = process.argv.slice(2), context: SourceSnapshotCliContext = {}): Promise<SourceSnapshotCliOutcome> => {
  const cwd = resolve(context.cwd ?? process.cwd());
  const stdout = context.stdout ?? (value => process.stdout.write(value));
  const stderr = context.stderr ?? (value => process.stderr.write(value));
  const now = context.now ?? Date.now;
  try {
    const args = parseArgs(argv, cwd);
    if (args.command === 'read') {
      const result = await readPublishedSourceSnapshotText({
        targetRoot: requiredString(args.targetRoot, 'targetRoot'), ownerId: requiredString(args.ownerId, 'ownerId'),
        ...(args.snapshotId === undefined ? {} : { snapshotId: args.snapshotId }), path: requiredString(args.path, 'path'),
      });
      const summary = { status: 'READ', ...result }; emit(stdout, summary, args.json); return outcome(0, summary);
    }
    if (args.command === 'unpack') {
      const result = await unpackPublishedSourceSnapshot({
        targetRoot: requiredString(args.targetRoot, 'targetRoot'), ownerId: requiredString(args.ownerId, 'ownerId'),
        ...(args.snapshotId === undefined ? {} : { snapshotId: args.snapshotId }), outputRoot: requiredString(args.outputRoot, 'outputRoot'),
      });
      const summary = { ...result }; emit(stdout, summary, args.json); return outcome(0, summary);
    }
    const config = await loadConfig(args.configPath); const timestamp = now();
    if (args.command === 'plan') {
      const prepared = await prepareRepositorySnapshot({ ...planOptions(config, timestamp), workRoot: dirname(config.lockPath) });
      try {
        const result = safePlanSummary(prepared.plan); emit(stdout, result, args.json); return outcome(prepared.plan.publishAllowed ? 0 : 2, result);
      } finally { await prepared.dispose(); }
    }
    if (args.command === 'export') {
      const prepared = await prepareRepositorySnapshot({ ...planOptions(config, timestamp), workRoot: dirname(config.lockPath) });
      try {
        if (!prepared.plan.publishAllowed || prepared.plan.manifest === null) {
          const summary = safePlanSummary(prepared.plan); emit(stdout, summary, args.json); return outcome(2, summary);
        }
        const freeze = await verifyRepositorySnapshotFreeze(planOptions(config, timestamp), prepared.plan.freeze);
        if (!freeze.ok) throw new SourceSnapshotError('SOURCE_CHANGED', { inventoryChanged: freeze.inventoryChanged, changedPaths: freeze.changedPaths });
        const publication = await publishPreparedSourceSnapshot({ manifest: prepared.plan.manifest, objects: prepared.objects }, { ...planOptions(config, timestamp), targetRoot: config.targetRoot, lockPath: config.lockPath, ownerId: config.ownerId, ...storageOptions(config), ...(config.storeBudget === undefined ? {} : { storeBudget: config.storeBudget }) });
        const summary = { status: publication.status, snapshotId: publication.snapshotId, objectCount: publication.objectCount, sourceFileCount: publication.sourceFileCount, writtenObjects: publication.writtenObjects, reusedObjects: publication.reusedObjects };
        emit(stdout, summary, args.json); return outcome(0, summary);
      } finally { await prepared.dispose(); }
    }
    if (args.command === 'verify') {
      const result = await verifyPublishedSourceSnapshot({ targetRoot: config.targetRoot, ownerId: config.ownerId, ...storageOptions(config) });
      const summary = { ...result }; emit(stdout, summary, args.json); return outcome(0, summary);
    }
    if (args.command === 'status') {
      const result = await inspectSourceSnapshotRetention(retentionOptions(config, timestamp));
      const summary = { ...result }; emit(stdout, summary, args.json); return outcome(0, summary);
    }
    const result = await pruneSourceSnapshots({ ...retentionOptions(config, timestamp), lockPath: config.lockPath, dryRun: args.dryRun });
    const summary = { ...result }; emit(stdout, summary, args.json); return outcome(0, summary);
  } catch (error) {
    const code = error instanceof SourceSnapshotError ? error.code : (error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'UNEXPECTED_ERROR');
    const message = error instanceof SourceSnapshotError ? error.code : error instanceof Error ? error.message : String(error);
    const result = { status: 'FAILED', error: Object.freeze({ code, message }) };
    stderr(`[${code}] ${message}\n`); return outcome(1, result);
  }
};
