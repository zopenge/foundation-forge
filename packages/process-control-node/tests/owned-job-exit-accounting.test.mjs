import { expect, test } from 'vitest';
import process from 'node:process';
import { loadOwnedNative } from '../dist/owned-scope/native-loader.js';
import { createWindowsOwnedProcessScopeProvider, createWindowsProcessIdentityReader } from '../dist/index.js';

test.runIf(process.platform === 'win32').each(['terminated', 'removed', 'removed-with-peer', 'exit-status-before-signal', 'exit-259', 'active', 'exit-query-failed', 'wait-failed', 'wrong-job', 'close-failed', 'inaccessible', 'incomplete', 'unresolved'])('verifies a %s member before synchronizing delayed Job accounting', async mode => {
  const native = await loadOwnedNative('win32'), original = native.load;
  const stalePid = 1_073_741_823, staleHandle = 1073741823n;
  const peerPid = stalePid - 1, peerHandle = staleHandle - 1n;
  const withPeer = mode === 'removed-with-peer';
  const missing = ['removed', 'removed-with-peer', 'inaccessible', 'unresolved'].includes(mode);
  let lagged = false, inserted = false, inspected = false;
  let peerChecks = 0, peerWaits = 0;
  native.load = (...args) => {
    const lib = original(...args), func = lib.func.bind(lib);
    return new Proxy(lib, { get(target, key) {
      if (key !== 'func') return Reflect.get(target, key);
      return (...declaration) => {
        const fn = func(...declaration), named = name => declaration.some(value => typeof value === 'string' && value.includes(name));
        return (...values) => {
          if (named('OpenProcess') && values[2] === stalePid) { inspected = true; return missing ? null : staleHandle; }
          if (named('GetLastError') && inspected && missing) return mode === 'inaccessible' ? 5 : 87;
          if (named('OpenProcess') && values[2] === peerPid) return peerHandle;
          if (named('IsProcessInJob') && values[0] === peerHandle) { peerChecks++; values[2][0] = 1; return true; }
          if (named('WaitForSingleObject') && values[0] === peerHandle) return ++peerWaits === 1 ? 258 : 0;
          if (named('GetExitCodeProcess') && values[0] === peerHandle) { values[1][0] = 259; return true; }
          if (named('CloseHandle') && values[0] === peerHandle) return true;
          if (named('IsProcessInJob') && values[0] === staleHandle) { values[2][0] = mode === 'wrong-job' ? 0 : 1; return true; }
          if (named('WaitForSingleObject') && values[0] === staleHandle) return ['active', 'exit-status-before-signal', 'exit-query-failed'].includes(mode) ? 258 : mode === 'wait-failed' ? 0xFFFFFFFF : 0;
          if (named('GetExitCodeProcess') && values[0] === staleHandle) { values[1][0] = ['active', 'exit-259'].includes(mode) ? 259 : 0; return mode !== 'exit-query-failed'; }
          if (named('CloseHandle') && values[0] === staleHandle) return mode !== 'close-failed';
          const result = fn(...values);
          if (named('QueryInformationJobObject') && result) {
            if (values[1] === 1 && values[2].active === 1 && (!lagged || (withPeer && peerWaits < 2))) {
              values[2].active = withPeer && !lagged ? 3 : 2; lagged = true;
            } else if (values[1] === 3 && lagged) {
              const list = values[2];
              if (!inserted || mode === 'unresolved') {
                list.ids[list.count++] = BigInt(stalePid); list.assigned++; inserted = true;
                if (mode === 'incomplete') list.assigned++;
              }
              if (withPeer && peerWaits === 0) { list.ids[list.count++] = BigInt(peerPid); list.assigned++; }
            }
          }
          return result;
        };
      };
    } });
  };
  const scope = createWindowsOwnedProcessScopeProvider().start({ command: process.execPath, args: ['-e', 'process.exit(0)'], environment: process.env,
    binding: `exit-accounting-${mode}`, startupTimeoutMs: 3000, terminationTimeoutMs: 3000 });
  try {
    const observed = await createWindowsProcessIdentityReader().readIdentity({ pid: await scope.rootPid });
    if (observed.status !== 'FOUND') throw Error('fixture root absent');
    await scope.bind(observed.identity); await scope.authorize();
    const normal = ['terminated', 'removed', 'removed-with-peer', 'exit-status-before-signal', 'exit-259'].includes(mode);
    expect(await scope.completion).toMatchObject({ exitCode: 0, closure: normal
      ? { status: 'closed', reason: 'normal', empty: true } : { status: 'unknown' } });
    expect({ lagged, inserted, inspected }).toEqual({ lagged: true, inserted: true, inspected: mode !== 'incomplete' });
    if (withPeer) expect({ peerChecks, peerWaits }).toEqual({ peerChecks: 1, peerWaits: 2 });
  } finally { await scope.dispose(); native.load = original; }
});
