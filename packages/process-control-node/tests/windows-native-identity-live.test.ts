import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, onTestFailed, test } from 'vitest';
import type { OwnedProcessScope } from '@openge/forge-process-control';
import { createWindowsNativeProcessIdentityReader, createWindowsProcessIdentityReader } from '../src/index.js';
import { createWindowsOwnedProcessScopeProvider } from '../dist/index.js';
import { loadOwnedNative } from '../src/owned-scope/native-loader.js';
import { readIdentityPair } from './helpers/identity-read-pair.js';
import { startIdentityCommand } from './helpers/identity-command.js';

const supported = process.platform === 'win32' && process.arch === 'x64', scopes: OwnedProcessScope[] = [];
afterEach(async () => { for (const scope of scopes.splice(0)) await scope.dispose(); });
test.runIf(supported)('matches the public command reader for this known live process', async context => {
  const controller = new AbortController(), signal = AbortSignal.any([context.signal, controller.signal]);
  const commands: ReturnType<typeof startIdentityCommand>[] = [];
  const commandReader = createWindowsProcessIdentityReader({ runner: request => {
    const command = startIdentityCommand(request); commands.push(command); return command.completion;
  } });
  const pair = readIdentityPair([createWindowsNativeProcessIdentityReader(), commandReader], process.pid, signal);
  const drain = async () => { await pair.then(() => {}, () => {}); };
  context.onTestFinished(async () => { controller.abort(); await drain(); });
  onTestFailed(async () => {
    controller.abort(); await drain();
    process.stderr.write(`${JSON.stringify({ kind: 'WINDOWS_NATIVE_IDENTITY_PARITY', commands: commands.map(command => command.events) })}\n`);
  });
  const [native, command] = await pair;
  expect(native).toMatchObject({ status: 'FOUND', identity: { pid: process.pid } });
  expect(native).toEqual(command);
  expect(commands).toHaveLength(1); expect(commands[0]?.events.at(-1)?.phase).toBe('close');
});
test.runIf(supported)('binds a real owned scope with the native identity and retains independent Job closure', async () => {
  const scope = createWindowsOwnedProcessScopeProvider().start({ command: process.execPath, args: ['-e', 'process.exit(0)'], environment: process.env,
    binding: 'native-identity', startupTimeoutMs: 10_000, terminationTimeoutMs: 10_000 }); scopes.push(scope);
  const observed = await createWindowsNativeProcessIdentityReader().readIdentity({ pid: await scope.rootPid });
  expect(observed.status).toBe('FOUND'); if (observed.status !== 'FOUND') throw new Error('owned root not found');
  await scope.bind(observed.identity); await scope.authorize();
  expect(await scope.completion).toMatchObject({ exitCode: 0, closure: { status: 'closed', reason: 'normal', empty: true, rootIdentity: observed.identity } });
});
test.runIf(supported)('does not resurrect an exited process whose timestamp handle is still retained', async () => {
  const k = await loadOwnedNative('win32'), lib = k.load('kernel32.dll'), time = k.struct({ low: 'uint32_t', high: 'uint32_t' });
  const open = lib.func('void * __stdcall OpenProcess(uint32_t access, int32_t inherit, uint32_t pid)');
  const close = lib.func('int32_t __stdcall CloseHandle(void *handle)');
  const times = lib.func('__stdcall', 'GetProcessTimes', 'int32_t', ['void *', k.out(k.pointer(time)), k.out(k.pointer(time)), k.out(k.pointer(time)), k.out(k.pointer(time))]);
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume();process.stdin.once("end",()=>process.exit(259))'],
    { shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  const closed = once(child, 'close').then(([code]) => ({ code }), (error: unknown) => ({ error }));
  let handle: bigint | null = null;
  try {
    await once(child, 'spawn'); if (!child.pid || !child.stdin) throw new Error('fixture child unavailable');
    const reader = createWindowsNativeProcessIdentityReader();
    expect(await reader.readIdentity({ pid: child.pid })).toMatchObject({ status: 'FOUND', identity: { pid: child.pid } });
    handle = open(0x00101000, 0, child.pid); expect(handle).toBeTruthy(); child.stdin.end();
    expect(await closed).toEqual({ code: 259 });
    const created = { low: 0, high: 0 }, exited = { low: 0, high: 0 }, kernel = { low: 0, high: 0 }, user = { low: 0, high: 0 };
    expect(times(handle, created, exited, kernel, user)).toBeTruthy();
    expect(await reader.readIdentity({ pid: child.pid })).toEqual({ status: 'ABSENT' });
  } finally {
    try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; }
    finally { if (handle) expect(close(handle)).toBeTruthy(); }
  }
});
