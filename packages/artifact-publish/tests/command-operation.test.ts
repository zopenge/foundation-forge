import process from 'node:process';
import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner, CommandSpec } from '@openge/forge-command-runner';
import { bindArtifactOperation, performArtifactOperation } from '../src/index.js';
import { createCommandArtifactOperation } from '../src/node.js';
import type { ArtifactOperationJournal, ArtifactOperationRecord } from '../src/index.js';

const target = { provider: 'cli', namespace: 'static', endpoint: 'https://cli.invalid' };
const command = { command: process.execPath, args: ['--version'], cwd: process.cwd(), environment: { EXPLICIT_SECRET: 'never-in-receipt' } };
const options = { timeoutMilliseconds: 1_000, closeTimeoutMilliseconds: 100 };
function store(): ArtifactOperationJournal {
  let record: ArtifactOperationRecord | undefined;
  return { async load() { return record; }, async compareAndSet({ expectedRevision, next }) {
    if ((record?.revision ?? 0) !== expectedRevision) return 'conflict';
    record = next; return 'stored';
  } };
}

function runner(result: (spec: CommandSpec) => CommandResult, inspect: (spec: CommandSpec) => void = () => {}): CommandRunner {
  const start: CommandRunner['start'] = spec => {
    inspect(spec);
    return { pid: Promise.resolve(1), identity: Promise.resolve(null), result: Promise.resolve(result(spec)), async terminate() {} };
  };
  return { start, run: spec => start(spec).result };
}
const normal = (spec: CommandSpec): CommandResult => ({ identity: { pid: 1, startToken: 'fixture' },
  exitCode: 0, signal: null, durationMs: 1, terminationReason: 'exit', diagnostics: [],
  stdout: new TextEncoder().encode('never-in-receipt'), stderr: new Uint8Array(),
  ownedScope: { status: 'closed', reason: 'normal', empty: true, rootIdentity: { pid: 1, startToken: 'fixture' },
    scopeId: 'scope-1', binding: spec.ownedScope?.binding ?? '', observedAt: '2026-01-01T00:00:00Z' } });

async function setup(client: CommandRunner) {
  const adapter = await createCommandArtifactOperation({ target, capability: 'deployment-create', command,
    maxOutputBytesPerStream: 1024, observationKey: 'static-v1', runner: client,
    observation: {
      async observe(binding) { return { state: 'pending', fingerprint: binding.fingerprint, reference: 'dep-1' }; },
      async close() { return { status: 'closed', activeRequests: 0 }; },
    } });
  const binding = await bindArtifactOperation({ requestId: 'command-1', target, capability: 'deployment-create',
    configurationSha256: adapter.configurationSha256, sourceCommit: 'a'.repeat(40),
    inputs: [{ name: 'static', sha256: 'b'.repeat(64), byteLength: 1 }] });
  return { adapter, binding };
}

describe('explicit command operation adapter', () => {
  it('requires bounded capture, replacement environment and an exact owned scope while exit zero only means accepted', async () => {
    const { adapter, binding } = await setup(runner(normal, spec => {
      expect(spec.output).toEqual({ mode: 'capture', maxBytesPerStream: 1024, overflow: 'fail' });
      expect(spec.environment?.mode).toBe('replace');
      expect(spec.environment?.values?.EXPLICIT_SECRET).toBe('never-in-receipt');
      expect(spec.environment?.values?.FORGE_ARTIFACT_REQUEST_ID).toBe('command-1');
      expect(spec.ownedScope?.binding).toMatch(/^[a-f0-9]{64}$/u);
      expect(spec.signal).toBeInstanceOf(AbortSignal);
    }));
    const receipt = await performArtifactOperation(adapter, binding, store(), options);
    expect(receipt.outcome).toBe('pending');
    expect(receipt.record.writeState).toBe('accepted');
    expect(receipt.closure.status).toBe('closed');
    expect(JSON.stringify(receipt)).not.toContain('never-in-receipt');
  });

  it.each(['exit', 'output-overflow', 'timeout', 'scope'])('does not promote a %s failure to rejection or remote success', async kind => {
    const { adapter, binding } = await setup(runner(spec => {
      const value = normal(spec);
      if (kind === 'scope') return { ...value, ownedScope: { ...value.ownedScope, status: 'unknown', reason: 'provider-failed', scopeId: 'scope-1', binding: binding.fingerprint, observedAt: 'now' } };
      return { ...value, exitCode: 1, terminationReason: kind === 'exit' ? 'exit' : kind === 'timeout' ? 'timeout' : 'output-overflow' };
    }));
    await expect(performArtifactOperation(adapter, binding, store(), options)).rejects.toMatchObject({ code: 'PROVIDER_FAILED', receipt: { record: { writeState: 'unknown' } } });
  });

  it('binds the exact command inputs, environment and observation adapter version', async () => {
    const first = await setup(runner(normal));
    const second = await createCommandArtifactOperation({ target, capability: 'deployment-create',
      command: { ...command, args: ['--help'] }, maxOutputBytesPerStream: 1024, observationKey: 'static-v1', runner: runner(normal),
      observation: { async observe(binding) { return { state: 'unknown', fingerprint: binding.fingerprint }; },
        async close() { return { status: 'closed', activeRequests: 0 }; } } });
    expect(first.adapter.configurationSha256).not.toBe(second.configurationSha256);
    await expect(performArtifactOperation(second, first.binding, store(), options)).rejects.toMatchObject({ code: 'BINDING_MISMATCH' });
    await first.adapter.close({ timeoutMilliseconds: 100 });
  });

  it('returns structured validation failures for malformed native path inputs', async () => {
    for (const path of [null, undefined, 42]) {
      await expect(Reflect.apply(createCommandArtifactOperation, undefined, [{ target, capability: 'deployment-create',
        command: { ...command, cwd: path }, maxOutputBytesPerStream: 1024, observationKey: 'v1', runner: runner(normal),
        observation: { async observe() { throw Error('unreachable'); }, async close() { return { status: 'closed', activeRequests: 0 }; } },
      }])).rejects.toMatchObject({ name: 'ArtifactOperationError', code: 'INVALID_BINDING' });
    }
  });

  it('starts closing observation resources even if the command ignores cancellation', async () => {
    let finish: ((value: CommandResult) => void) | undefined;
    const pending = new Promise<CommandResult>(resolve => { finish = resolve; });
    let started: (() => void) | undefined, lastSpec: CommandSpec | undefined;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const client: CommandRunner = { start(spec) { lastSpec = spec; started?.(); return {
      pid: Promise.resolve(1), identity: Promise.resolve(null), result: pending, async terminate() {},
    }; }, async run() { return pending; } };
    let closed = 0;
    const adapter = await createCommandArtifactOperation({ target, capability: 'deployment-create', command,
      maxOutputBytesPerStream: 1024, observationKey: 'v1', runner: client,
      observation: { async observe() { throw Error('unreachable'); }, async close() { closed++; return { status: 'closed', activeRequests: 0 }; } } });
    const binding = await bindArtifactOperation({ requestId: 'cancel-1', target, capability: 'deployment-create', sourceCommit: 'a'.repeat(40),
      configurationSha256: adapter.configurationSha256, inputs: [{ name: 'static', sha256: 'b'.repeat(64), byteLength: 1 }] });
    const controller = new AbortController();
    const operation = performArtifactOperation(adapter, binding, store(), { ...options, closeTimeoutMilliseconds: 20, signal: controller.signal });
    const outcome = expect(operation).rejects.toMatchObject({ code: 'OPERATION_ABORTED', receipt: { closure: { status: 'unconfirmed' } } });
    try {
      await ready; controller.abort(); await outcome;
      expect(closed).toBe(1);
    } finally { if (lastSpec) finish?.(normal(lastSpec)); }
  });
});
