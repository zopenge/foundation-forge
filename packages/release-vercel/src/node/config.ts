import type { ReleaseCheck, ReleaseConfig } from '../contracts.js';
import { record, ReleaseError } from './errors.js';

function invalid(field: string): never { throw new ReleaseError('CONFIG_INVALID', { field }); }
function object(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  const result = record(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(result).some(key => !keys.includes(key)) || keys.some(key => !(key in result))) invalid(field);
  return result;
}
function text(value: unknown, field: string, pattern = /./u): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048
    || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || !pattern.test(value)) invalid(field);
  return value;
}
function integer(value: unknown, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value <= 0 || value > maximum) invalid(field);
  return value;
}
function commands(value: unknown, field: string): readonly ReleaseCheck[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) invalid(field);
  return value.map((item: unknown) => {
    const itemRecord = record(item);
    if (Object.keys(itemRecord).some(key => !['command', 'args', 'timeoutMs'].includes(key))) invalid(field);
    const command = text(itemRecord.command, `${field}.command`);
    if (command.startsWith('-') || /\.(?:cmd|bat)$/iu.test(command)) invalid(`${field}.command`);
    if (itemRecord.args !== undefined && (!Array.isArray(itemRecord.args) || itemRecord.args.length > 128
      || itemRecord.args.some((arg: unknown) => typeof arg !== 'string' || arg.length > 8192 || arg.includes(String.fromCharCode(0))))) invalid(`${field}.args`);
    return { command, ...(itemRecord.args === undefined ? {} : { args: [...itemRecord.args as string[]] }),
      ...(itemRecord.timeoutMs === undefined ? {} : { timeoutMs: integer(itemRecord.timeoutMs, 3_600_000, `${field}.timeoutMs`) }) };
  });
}
export function validateReleaseConfig(value: unknown): ReleaseConfig {
  const root = object(value, ['schemaVersion', 'git', 'vercel', 'checks', 'acceptance', 'buildInfo', 'limits'], 'config');
  if (root.schemaVersion !== 1) invalid('schemaVersion');
  const git = object(root.git, ['remote', 'repository', 'developmentBranch', 'releaseBranch'], 'git');
  const branch = (value: unknown, field: string) => {
    const result = text(value, field, /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u);
    if (result.includes('..') || result.includes('//') || result.includes('@{') || result.endsWith('.')
      || result.endsWith('/') || result.endsWith('.lock') || result.split('/').some(part => part.startsWith('.'))) invalid(field);
    return result;
  };
  const developmentBranch = branch(git.developmentBranch, 'git.developmentBranch');
  const releaseBranch = branch(git.releaseBranch, 'git.releaseBranch');
  if (developmentBranch === releaseBranch) invalid('git.releaseBranch');
  const vercel = object(root.vercel, ['teamId', 'projectId', 'productionUrl'], 'vercel');
  const productionUrl = text(vercel.productionUrl, 'vercel.productionUrl');
  let url: URL; try { url = new URL(productionUrl); } catch { return invalid('vercel.productionUrl'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || url.pathname !== '/' || productionUrl.replace(/\/$/u, '') !== url.origin) invalid('vercel.productionUrl');
  const build = object(root.buildInfo, ['path', 'revisionField'], 'buildInfo');
  const path = text(build.path, 'buildInfo.path', /^\/[a-zA-Z0-9/_.-]+$/u);
  if (path.startsWith('//') || path.split('/').includes('..')) invalid('buildInfo.path');
  const limits = object(root.limits, ['commandMs', 'deploymentMs', 'pollMs', 'requestMs', 'maxOutputBytes'], 'limits');
  const deploymentMs = integer(limits.deploymentMs, 3_600_000, 'limits.deploymentMs');
  return { schemaVersion: 1,
    git: { remote: text(git.remote, 'git.remote', /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u),
      repository: text(git.repository, 'git.repository'), developmentBranch, releaseBranch },
    vercel: { teamId: text(vercel.teamId, 'vercel.teamId', /^team_[a-zA-Z0-9]+$/u),
      projectId: text(vercel.projectId, 'vercel.projectId', /^prj_[a-zA-Z0-9]+$/u), productionUrl },
    checks: commands(root.checks, 'checks'), acceptance: commands(root.acceptance, 'acceptance'),
    buildInfo: { path, revisionField: text(build.revisionField, 'buildInfo.revisionField', /^[a-zA-Z][a-zA-Z0-9_]*$/u) },
    limits: { commandMs: integer(limits.commandMs, 3_600_000, 'limits.commandMs'), deploymentMs,
      pollMs: integer(limits.pollMs, deploymentMs, 'limits.pollMs'), requestMs: integer(limits.requestMs, 300_000, 'limits.requestMs'),
      maxOutputBytes: integer(limits.maxOutputBytes, 1_048_576, 'limits.maxOutputBytes') } };
}
