import { expect, test } from 'vitest';
import { loadOwnedNative } from '../dist/owned-scope/native-loader.js';
import { createWindowsOwnedProcessScopeProvider, createWindowsProcessIdentityReader } from '../dist/index.js';
import { createLinuxOwnedProcessScopeProvider } from '../dist/index.js';

test.runIf(process.platform === 'win32').each(['SetInformationJobObject', 'AssignProcessToJobObject', 'QueryInformationJobObject'])('fails closed at the native %s boundary', async operation => {
  const native = await loadOwnedNative('win32'), original = native.load;
  native.load = (...args) => {
    const lib = original(...args);
    return new Proxy(lib, { get(target, key) {
      if (key !== 'func') return Reflect.get(target, key);
      return (...declaration) => {
        const fn = Reflect.apply(target.func, target, declaration);
        if (!declaration.some(value => typeof value === 'string' && value.includes(operation))) return fn;
        return new Proxy(fn, { apply(target, receiver, args) {
          if (operation !== 'QueryInformationJobObject' || args[1] === 1) return false;
          return Reflect.apply(target, receiver, args);
        } });
      };
    } });
  };
  const scope = createWindowsOwnedProcessScopeProvider().start({ command: process.execPath, args: ['-e', 'process.exit(0)'], environment: process.env,
    binding: 'native-failure', startupTimeoutMs: 3000, terminationTimeoutMs: 3000 });
  try {
    if (operation === 'QueryInformationJobObject') {
      const value = await createWindowsProcessIdentityReader().readIdentity({pid:await scope.rootPid});
      if(value.status!=='FOUND')throw Error('fixture root absent');
      await scope.bind(value.identity); await scope.authorize();
    } else await expect(scope.rootPid).rejects.toMatchObject({code:'PROCESS_SCOPE_UNKNOWN'});
    expect((await scope.completion).closure.status).toBe('unknown');
  } finally { await scope.dispose(); native.load = original; }
});
test.runIf(process.platform === 'linux')('rejects missing glibc pidfd exports before creating a job', async () => {
  const native = await loadOwnedNative('linux'), original = native.load;
  native.load = (...args) => {
    const lib = original(...args);
    return new Proxy(lib, { get(target, key) {
      if (key !== 'func') return Reflect.get(target, key);
      return (...declaration) => {
        if (declaration.some(value => typeof value === 'string' && value.includes('pidfd_open'))) throw Error('missing native symbol');
        return Reflect.apply(target.func, target, declaration);
      };
    } });
  };
  const scope = createLinuxOwnedProcessScopeProvider().start({ command: process.execPath, args: ['-e', 'process.exit(99)'], environment: process.env, binding: 'missing-symbol', startupTimeoutMs: 3000, terminationTimeoutMs: 3000 });
  try {
    await expect(scope.rootPid).rejects.toMatchObject({ code: 'PROCESS_SCOPE_UNSUPPORTED' });
    expect((await scope.completion).closure).toMatchObject({ status: 'unknown' });
  } finally { await scope.dispose(); native.load = original; }
});
test.runIf(process.platform === 'win32')('requires matching Job membership while a completed process accounting update settles', async () => {
  const native = await loadOwnedNative('win32'), original = native.load; let lagged = false;
  native.load = (...args) => {
    const lib = original(...args);
    return new Proxy(lib, { get(target, key) {
      if (key !== 'func') return Reflect.get(target, key);
      return (...declaration) => {
        const fn = Reflect.apply(target.func, target, declaration);
        if (!declaration.some(value => typeof value === 'string' && value.includes('QueryInformationJobObject'))) return fn;
        return new Proxy(fn, { apply(target, receiver, args) {
          const result = Reflect.apply(target, receiver, args);
          if (result && args[1] === 1 && args[2].active === 1 && !lagged) { args[2].active = 2; lagged = true; }
          return result;
        } });
      };
    } });
  };
  const scope = createWindowsOwnedProcessScopeProvider().start({ command: process.execPath, args: ['-e', 'process.exit(0)'], environment: process.env, binding: 'accounting-update', startupTimeoutMs: 3000, terminationTimeoutMs: 3000 });
  try {
    const observed = await createWindowsProcessIdentityReader().readIdentity({ pid: await scope.rootPid });
    if (observed.status !== 'FOUND') throw Error('fixture root absent');
    await scope.bind(observed.identity); await scope.authorize();
    expect(await scope.completion).toMatchObject({ closure: { status: 'closed', empty: true } }); expect(lagged).toBe(true);
  } finally { await scope.dispose(); native.load = original; }
});
import process from 'node:process';
