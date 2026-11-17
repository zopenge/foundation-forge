import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { record, ReleaseError } from './errors.js';
import type { ManagedPaths } from './managed-state-contracts.js';

const reasons = ['IO_OBSERVATION', 'DIRECTORY_REPLACED', 'OBSERVATION_DEADLINE', 'OBSERVATION_FAILED',
  'ROOT_REPLACED', 'LINK_REPLACED', 'ENTRY_LIMIT', 'EXTERNAL_LINK', 'LINK_TARGET_UNKNOWN', 'LINK_ANCESTOR_TYPE',
  'LINK_RESOLUTION_LIMIT', 'ANCHOR_TYPE', 'FILE_TYPE', 'SIZE_OVERFLOW', 'VOLUME_SIZE', 'CHECKOUT_UNCONFIRMED'] as const;
const operations = ['lstat', 'stat', 'realpath', 'readlink', 'opendir', 'readdir', 'scandir', 'statfs'] as const;
const ioCodes = ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'] as const;
const member = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && values.some(entry => entry === value);
type Boundary = 'failure-latch' | 'scan-catch';
type Operation = typeof operations[number] | 'directory-validation' | 'link-validation' | 'root-validation' | 'unknown';
type Role = 'checkout-payload' | 'checkout-metadata' | 'managed-control' | 'protected-root' | 'unknown';
interface FailureContext { readonly path?: string | undefined; readonly operation?: 'directory-validation' | undefined }
interface FailureWitness {
  readonly observedOffsetMs: number;
  readonly boundary: Boundary;
  readonly operation: Operation;
  readonly role: Role;
  readonly reason: typeof reasons[number] | 'OTHER';
  readonly ioCode?: typeof ioCodes[number] | 'OTHER';
}
export interface ScanFailureWitnessSnapshot {
  readonly first?: FailureWitness;
  readonly blocking?: { readonly relation: 'first' } | (FailureWitness & { readonly relation: 'later' });
  readonly selection?: 'first' | 'different' | 'unwitnessed';
}
const within = (root: string, path: string) => {
  const child = relative(root, path);
  return child === '' || !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`);
};
function argumentRole(paths: ManagedPaths, path: string | undefined): Role {
  if (!path || !isAbsolute(path)) return 'unknown';
  if ([paths.sourceRoot, paths.slotRoot, paths.checkoutRoot].some(root => relative(root, path) === '')) return 'protected-root';
  if (within(resolve(paths.checkoutRoot, '.git'), path)) return 'checkout-metadata';
  if (within(paths.checkoutRoot, path)) return 'checkout-payload';
  // 仅识别既有精确文件及其原子临时路径；其他槽条目不能推断为控制面。
  const atomic = [paths.anchorPath, paths.statePath,
    ...['terminal.json', 'latest-check.json', 'latest-publish.json'].map(name => resolve(paths.slotRoot, name))];
  const control = [paths.ownershipPath, paths.lockPath, paths.recoveryLockPath, ...atomic];
  return control.some(target => relative(target, path) === '')
    || atomic.some(target => relative(resolve(dirname(target), `.${target.slice(dirname(target).length + 1)}.next`), path) === '') ? 'managed-control' : 'unknown';
}

/** 只保存原失败边界的有限见证；起点来自该轮已有时钟，成功路径不读取新时钟。 */
export class ScanFailureWitness {
  private firstError: unknown;
  private firstWitness: FailureWitness | undefined;
  private blockerError: unknown;
  private blockerWitness: FailureWitness | undefined;
  private outgoingError: unknown;
  private outgoingRelation: 'first' | 'different' | undefined;
  constructor(private readonly origin: number) {}

  private capture(error: unknown, paths: ManagedPaths, context: FailureContext, boundary: Boundary): FailureWitness {
    const observedOffsetMs = performance.now() - this.origin;
    try {
      const raw = record(error), details = error instanceof ReleaseError ? error.details : {};
      // 每项只读取一次，避免getter在校验后改变值或将任意内容带入输出。
      const reasonValue = details.reason, syscallValue = raw.syscall, pathValue = raw.path;
      const contextOperation = context.operation, contextPath = context.path;
      const reason = error instanceof ReleaseError ? member(reasons, reasonValue) ? reasonValue : 'OTHER' : 'IO_OBSERVATION';
      const semantic = reason === 'DIRECTORY_REPLACED' ? 'directory-validation'
        : ['LINK_REPLACED', 'EXTERNAL_LINK', 'LINK_TARGET_UNKNOWN', 'LINK_ANCESTOR_TYPE', 'LINK_RESOLUTION_LIMIT'].includes(reason) ? 'link-validation'
          : reason === 'ROOT_REPLACED' ? 'root-validation' : undefined;
      const contextualOperation = contextOperation === 'directory-validation' ? contextOperation : undefined;
      const argument = typeof pathValue === 'string' && isAbsolute(pathValue) ? pathValue
        : semantic || contextualOperation ? contextPath : undefined;
      const ioCode = error instanceof ReleaseError ? details.ioCode : raw.code;
      return { observedOffsetMs, boundary, operation: member(operations, syscallValue) ? syscallValue : semantic ?? contextualOperation ?? 'unknown',
        role: reason === 'ROOT_REPLACED' ? 'protected-root' : argumentRole(paths, argument), reason,
        ...(ioCode === undefined ? {} : { ioCode: member(ioCodes, ioCode) ? ioCode : 'OTHER' }) };
    } catch {
      // 诊断字段本身不可读时也不能替换原权威错误。
      return { observedOffsetMs, boundary, operation: 'unknown', role: 'unknown', reason: 'OTHER' };
    }
  }
  first(error: unknown, paths: ManagedPaths, context: FailureContext = {}, boundary: Boundary = 'failure-latch'): void {
    if (this.firstWitness) return;
    this.firstError = error;
    this.firstWitness = this.blockerWitness && Object.is(error, this.blockerError) ? this.blockerWitness : this.capture(error, paths, context, boundary);
  }
  block(error: unknown, paths: ManagedPaths, context: FailureContext = {}): void {
    if (this.blockerWitness) return;
    this.blockerError = error;
    this.blockerWitness = this.firstWitness && Object.is(error, this.firstError) ? this.firstWitness : this.capture(error, paths, context, 'failure-latch');
  }
  selected(original: unknown, outgoing: unknown, paths: ManagedPaths): void {
    // 根/anchor/volume等错误可能绕过visit首错锁存；只记录实际抵达scan catch的较晚边界。
    this.first(original, paths, {}, 'scan-catch');
    this.outgoingError = outgoing;
    this.outgoingRelation = Object.is(original, this.firstError) ? 'first' : 'different';
  }
  snapshot(selectedError?: unknown, rejected = false): ScanFailureWitnessSnapshot {
    return {
      ...(this.firstWitness ? { first: { ...this.firstWitness } } : {}),
      ...(this.blockerWitness ? { blocking: Object.is(this.blockerError, this.firstError) ? { relation: 'first' as const }
        : { relation: 'later' as const, ...this.blockerWitness } } : {}),
      ...(rejected ? { selection: !this.firstWitness ? 'unwitnessed' as const : this.outgoingRelation !== undefined && Object.is(selectedError, this.outgoingError) ? this.outgoingRelation
        : Object.is(selectedError, this.firstError) ? 'first' as const : 'different' as const } : {}),
    };
  }
}
