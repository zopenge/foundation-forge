import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { OwnedProcessScope } from '@openge/forge-process-control';
import { createWindowsOwnedProcessScopeProvider, createWindowsProcessIdentityReader, createWindowsProcessControl } from '../dist/index.js';

const scopes: OwnedProcessScope[] = [], roots: string[] = [];
afterEach(async () => { for (const scope of scopes.splice(0)) await scope.dispose(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const supported = process.platform === 'win32' && process.arch === 'x64';
async function start(args: string[], command = process.execPath) {
  const scope = createWindowsOwnedProcessScopeProvider().start({ command, args, environment: process.env,
    binding: 'fixture-command', startupTimeoutMs: 10_000, terminationTimeoutMs: 10_000 }); scopes.push(scope);
  const pid = await scope.rootPid, observed = await createWindowsProcessIdentityReader().readIdentity({ pid });
  if (observed.status !== 'FOUND') throw new Error('fixture supervisor missing');
  await scope.bind(observed.identity); return scope;
}
async function fixture() {
  const base = resolve(import.meta.dirname, '../../../.tmp/owned-scope-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'w-')); roots.push(root); return root;
}
test.runIf(supported)('does not run before authorization and closes a short command with real Job evidence', async () => {
  const root = await fixture(), marker = resolve(root, 'started');
  const scope = await start(['-e', 'require("node:fs").appendFileSync(process.argv[1],"once")', marker]);
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  await scope.authorize(); await scope.authorize();
  expect(await scope.completion).toMatchObject({ exitCode: 0, closure: { status: 'closed', reason: 'normal', empty: true, binding: 'fixture-command' } });
  expect(await readFile(marker, 'utf8')).toBe('once');
});
test.runIf(supported)('keeps a fast detached descendant from becoming a normal close', async () => {
  const root = await fixture(), output = resolve(root, 'writer');
  const writer = 'require("node:fs").appendFileSync(process.argv[1],"start");setInterval(()=>require("node:fs").appendFileSync(process.argv[1],"x"),25)';
  const parent = `const c=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(writer)},process.argv[1]],{stdio:"ignore",detached:true});c.unref();`;
  const scope = await start(['-e', parent, output]); await scope.authorize();
  expect(await scope.completion).toMatchObject({ closure: { status: 'unknown', reason: 'descendants-remained', empty: true } });
});
test.runIf(supported)('can dispose an unbound scope without executing its job', async () => {
  const root = await fixture(), marker = resolve(root, 'forbidden');
  const scope = createWindowsOwnedProcessScopeProvider().start({ command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],"bad")', marker],
    environment: process.env, binding: 'unbound', startupTimeoutMs: 10_000, terminationTimeoutMs: 10_000 }); scopes.push(scope);
  await scope.rootPid; await scope.dispose(); await scope.dispose();
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await scope.completion).closure.status).toBe('unknown');
});
test.runIf(supported)('owns multiple generations even when both parents exit immediately', async () => {
  const writer = 'setInterval(()=>{},1000)';
  const detach = (body: string) => `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(body)}],{detached:true,stdio:'ignore'});c.unref()`;
  const scope = await start(['-e', detach(detach(writer))]); await scope.authorize();
  expect((await scope.completion).closure).toMatchObject({ status: 'unknown', reason: 'descendants-remained', empty: true });
});
test.runIf(supported)('does not execute supervisor preloads but preserves the declared job environment', async () => {
  const root = await fixture(), preload = resolve(root, 'preload.cjs'), marker = resolve(root, 'preloaded');
  await writeFile(preload, `require('node:fs').appendFileSync(${JSON.stringify(marker)},'job')`);
  const scope = createWindowsOwnedProcessScopeProvider().start({ command: process.execPath, args: ['-e', 'process.exit(0)'], environment: { ...process.env, NODE_OPTIONS: `--require=${preload}` },
    binding: 'preload', startupTimeoutMs: 10_000, terminationTimeoutMs: 10_000 }); scopes.push(scope);
  const pid = await scope.rootPid, observed = await createWindowsProcessIdentityReader().readIdentity({ pid });
  if (observed.status !== 'FOUND') throw new Error('fixture root missing');
  await scope.bind(observed.identity); await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  await scope.authorize(); expect((await scope.completion).closure.status).toBe('closed'); expect(await readFile(marker, 'utf8')).toBe('job');
});
test.runIf(supported)('rejects a mismatched identity and leaves an unrelated process alive', async () => {
  const external = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { shell: false, windowsHide: true, stdio: 'ignore' });
  const reader = createWindowsProcessIdentityReader();
  if (!external.pid) throw new Error('fixture did not spawn');
  const independent = await reader.readIdentity({ pid: external.pid });
  if (independent.status !== 'FOUND') throw new Error('fixture independent identity missing');
  try {
    const scope = await start(['-e', 'process.exit(0)']);
    await expect(scope.bind({ pid: await scope.rootPid, startToken: 'wrong-instance' })).rejects.toMatchObject({ code: 'PROCESS_SCOPE_BINDING' });
    await expect(scope.authorize()).rejects.toThrow();
    await scope.dispose();
    expect(await reader.readIdentity({ pid: independent.identity.pid })).toEqual(independent);
  } finally { await createWindowsProcessControl({ listenerBackend: 'netstat' }).terminateProcessTree({ process: independent.identity, policy: { mode: 'force' } }); }
});
test.runIf(supported)('does not reuse the boot deadline as the authorized job lifetime', async () => {
  const scope = createWindowsOwnedProcessScopeProvider().start({ command: process.execPath, args: ['-e', 'setTimeout(()=>process.exit(0),3200)'], environment: process.env,
    binding: 'job-lifetime', startupTimeoutMs: 3000, terminationTimeoutMs: 3000 }); scopes.push(scope);
  const value = await createWindowsProcessIdentityReader().readIdentity({ pid: await scope.rootPid });
  if (value.status !== 'FOUND') throw Error('fixture root absent');
  await scope.bind(value.identity); await scope.authorize();
  expect(await scope.completion).toMatchObject({ exitCode: 0, closure: { status: 'closed' } });
}, 10_000);
test.runIf(supported)('closes real Git launcher commands without exempting console processes', async () => {
  const oid = execFileSync('git', ['rev-parse', 'HEAD:package.json'], { encoding: 'utf8', windowsHide: true }).trim();
  for (const args of [['--version'], ['cat-file', 'blob', oid], ['ls-tree', '-rz', 'HEAD']]) {
    const scope = await start(args, 'git'); await scope.authorize();
    expect(await scope.completion).toMatchObject({ exitCode: 0, closure: { status: 'closed', empty: true } });
  }
}, 15_000);
test.runIf(supported)('drains both output pipes before reporting scope completion', async () => {
  const bytes = { stdout: 0, stderr: 0 };
  const scope = createWindowsOwnedProcessScopeProvider().start({ command: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(262144));process.stderr.write("y".repeat(262144))'], environment: process.env,
    binding: 'output-drain', startupTimeoutMs: 5000, terminationTimeoutMs: 5000 }, event => { bytes[event.stream] += event.chunk.byteLength; }); scopes.push(scope);
  const observed = await createWindowsProcessIdentityReader().readIdentity({ pid: await scope.rootPid });
  if (observed.status !== 'FOUND') throw Error('fixture root absent');
  await scope.bind(observed.identity); await scope.authorize();
  expect((await scope.completion).closure.status).toBe('closed'); expect(bytes).toEqual({ stdout: 262144, stderr: 262144 });
}, 10_000);
test.runIf(supported)('closes real clone launchers after their owned processes have terminated', async () => {
  const root = await fixture(), source = resolve(root, 'source with spaces');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'dev', source);
  git('-C', source, 'config', 'user.name', 'Fixture'); git('-C', source, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(resolve(source, 'source.txt'), 'committed fixture\n');
  git('-C', source, 'add', 'source.txt'); git('-C', source, 'commit', '-m', 'fixture');
  for (let i = 0; i < 4; i++) {
    const scope = await start(['clone', '--no-checkout', '--no-local', '--template=', '--', source, resolve(root, `clone-${String(i)}`)], 'git');
    await scope.authorize();
    expect(await scope.completion).toMatchObject({ exitCode: 0, closure: { status: 'closed', reason: 'normal', empty: true } });
  }
}, 15_000);
