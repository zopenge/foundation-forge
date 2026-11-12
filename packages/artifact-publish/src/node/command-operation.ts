import { isAbsolute } from 'node:path';
import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import { normalizeCommandSpec } from '@openge/forge-command-runner';
import type { CommandResult, CommandRunner, RunningCommand } from '@openge/forge-command-runner';
import type { ArtifactPublicationTarget } from '../contracts.js';
import { operationCapabilities } from '../operations/binding.js';
import type { ArtifactOperationCapability, ArtifactOperationTransport } from '../operations/contracts.js';
import { ArtifactOperationError } from '../operations/errors.js';
import { snapshotTarget } from '../validation.js';

export interface CommandArtifactOperationOptions {
  readonly target: ArtifactPublicationTarget;
  readonly capability: ArtifactOperationCapability;
  readonly command: {
    readonly command: string;
    readonly args?: readonly string[];
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
  };
  readonly maxOutputBytesPerStream: number;
  readonly observationKey: string;
  readonly runner: CommandRunner;
  readonly observation: Pick<ArtifactOperationTransport, 'observe' | 'close'>;
}

const closedScope = (result: CommandResult, binding: string) => result.ownedScope?.status === 'closed'
  && result.ownedScope.reason === 'normal' && result.ownedScope.empty === true && result.ownedScope.binding === binding;

export async function createCommandArtifactOperation(input: CommandArtifactOperationOptions): Promise<ArtifactOperationTransport> {
  if (!input || !input.command || typeof input.command.cwd !== 'string' || typeof input.command.command !== 'string'
    || !isAbsolute(input.command.cwd) || !isAbsolute(input.command.command)
    || !operationCapabilities.includes(input.capability) || typeof input.observationKey !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.observationKey)
    || !Number.isSafeInteger(input.maxOutputBytesPerStream) || input.maxOutputBytesPerStream < 1
    || input.maxOutputBytesPerStream > 16_777_216 || !input.command.environment
    || Object.keys(input.command.environment).some(key => /^FORGE_ARTIFACT_(?:REQUEST_ID|FINGERPRINT|SOURCE_COMMIT|CONTENT_MANIFEST_SHA256|GIT_REVISION)$/iu.test(key))
    || typeof input.runner?.start !== 'function' || typeof input.observation?.observe !== 'function'
    || typeof input.observation?.close !== 'function') throw new ArtifactOperationError('INVALID_BINDING');
  let spec;
  let target;
  try {
    target = Object.freeze(snapshotTarget(input.target));
    spec = normalizeCommandSpec({ command: input.command.command, args: input.command.args ?? [], cwd: input.command.cwd,
      environment: { mode: 'replace', values: input.command.environment },
      output: { mode: 'capture', maxBytesPerStream: input.maxOutputBytesPerStream, overflow: 'fail' } });
  } catch { throw new ArtifactOperationError('INVALID_BINDING'); }
  const capability = input.capability;
  const observer = input.observation;
  const runner = input.runner;
  // 只持久化指纹；命令参数、环境值及捕获输出不进入诊断和回执。
  const configurationSha256 = (await calculateBytesIntegrity(new TextEncoder().encode(JSON.stringify({
    command: spec.command, args: spec.args, cwd: spec.cwd,
    environment: Object.entries(spec.environment?.values ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
    output: spec.output, observationKey: input.observationKey,
  })))).sha256;
  let running: RunningCommand | undefined;
  let pending: Promise<CommandResult> | undefined;
  let attempted = false;
  let confirmedClosed = true;
  let disposed = false;
  const transport: ArtifactOperationTransport = {
    target, capability, configurationSha256,
    async execute(binding, context) {
      if (disposed || attempted) throw new ArtifactOperationError('TRANSPORT_CLOSED');
      context.signal.throwIfAborted();
      attempted = true;
      confirmedClosed = false;
      running = runner.start({ ...spec, environment: { mode: 'replace', values: {
        ...spec.environment?.values,
        FORGE_ARTIFACT_REQUEST_ID: binding.requestId, FORGE_ARTIFACT_FINGERPRINT: binding.fingerprint,
        FORGE_ARTIFACT_CONTENT_MANIFEST_SHA256: binding.content.manifestSha256,
        ...(binding.provenance ? { FORGE_ARTIFACT_GIT_REVISION: binding.provenance.gitRevision } : {}),
      } }, timeoutMs: context.timeoutMilliseconds, signal: context.signal,
      ownedScope: { start: 'automatic', binding: binding.fingerprint } });
      // start() 的身份 Promise 也由此适配器接住，避免失败路径上的未处理拒绝。
      void running.pid.catch(() => {});
      void running.identity.catch(() => {});
      pending = running.result;
      void pending.then(result => { confirmedClosed = closedScope(result, binding.fingerprint); }, () => {});
      const result = await pending;
      if (!confirmedClosed || result.exitCode !== 0 || result.terminationReason !== 'exit'
        || result.stdoutTruncated || result.stderrTruncated || result.diagnostics.length > 0) {
        throw new ArtifactOperationError('PROVIDER_FAILED');
      }
      return { state: 'accepted' };
    },
    async observe(binding, reference, context) {
      if (disposed) throw new ArtifactOperationError('TRANSPORT_CLOSED');
      return observer.observe(binding, reference, context);
    },
    async close(options) {
      disposed = true;
      // 两类资源同时开始收尾；失联命令不能阻止观察客户端收到关闭请求。
      const closeObservation = Promise.resolve().then(() => observer.close(options));
      void closeObservation.catch(() => {});
      if (running && !confirmedClosed) {
        try { await running.terminate('abort'); await pending; } catch { /* 关闭证据仍由原 result 决定。 */ }
      }
      let observationClosure;
      try { observationClosure = await closeObservation; }
      catch { return { status: 'unconfirmed', activeRequests: confirmedClosed ? null : 1 }; }
      const activeRequests = observationClosure.activeRequests === null ? null
        : observationClosure.activeRequests + (confirmedClosed ? 0 : 1);
      return { status: confirmedClosed && observationClosure.status === 'closed' && activeRequests === 0 ? 'closed' : 'unconfirmed', activeRequests };
    },
  };
  return Object.freeze(transport);
}
