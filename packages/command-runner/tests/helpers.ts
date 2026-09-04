import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import type { ProcessControlProvider, ProcessIdentity, TerminateProcessTreeRequest } from '@openge/forge-process-control';
import { createNodeCommandRunner, type NodeCommandRunnerOptions } from '../src/node.js';
import type { CommandSpec } from '../src/index.js';

const pids = new Set<number>();
afterEach(() => {
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 子进程已退出。 */ }
  }
  pids.clear();
});
export const fixture = fileURLToPath(new URL('./fixtures/command-fixture.mjs', import.meta.url));
export const command = (mode: string, args: readonly string[] = [], spec: Partial<CommandSpec> = {}): CommandSpec => ({
  command: process.execPath, args: [fixture, mode, ...args], ...spec,
});
export const decode = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);
export function makeRunner(overrides: Partial<NodeCommandRunnerOptions> = {}) {
  const identities = new Map<number, ProcessIdentity>();
  const terminations: TerminateProcessTreeRequest[] = [];
  const provider: ProcessControlProvider = {
    async listProcesses(request) {
      return (request?.pids ?? []).map(pid => {
        pids.add(pid);
        const identity = { pid, startToken: 'fixture-' + String(pid) };
        identities.set(pid, identity);
        return identity;
      });
    },
    async listTcpListeners() { return []; },
    async terminateProcess() { throw new Error('unexpected single-process operation'); },
    async terminateProcessTree(request) {
      terminations.push(request);
      if (request.process.startToken !== identities.get(request.process.pid)?.startToken) throw new Error('identity mismatch');
      process.kill(request.process.pid, 'SIGKILL');
      return { pid: request.process.pid, forced: true };
    },
  };
  return {
    runner: createNodeCommandRunner({
      platform: 'win32', processControl: provider, terminationPolicy: { mode: 'force' },
      identityAcquisition: { timeoutMs: 500, pollIntervalMs: 10 }, terminationTimeoutMs: 500,
      ...overrides,
    }),
    provider, terminations,
  };
}
export function trackPid(pid: number): void { pids.add(pid); }
