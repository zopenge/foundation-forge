import { createWindowsOwnedProcessScopeProvider, createLinuxOwnedProcessScopeProvider, createWindowsProcessIdentityReader, createPosixProcessIdentityReader } from '../../dist/index.js';
const windows = process.platform === 'win32';
const provider = windows ? createWindowsOwnedProcessScopeProvider() : createLinuxOwnedProcessScopeProvider();
const reader = windows ? createWindowsProcessIdentityReader() : createPosixProcessIdentityReader();
const scope = provider.start({ command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)', process.argv[2]],
  environment: process.env, binding: 'owner-crash', startupTimeoutMs: 5000, terminationTimeoutMs: 5000 });
const observed = await reader.readIdentity({ pid: await scope.rootPid });
if (observed.status !== 'FOUND') throw Error('missing fixture supervisor');
await scope.bind(observed.identity); await scope.authorize();
process.send?.({ root: observed.identity });
await scope.completion;
import process from 'node:process';
