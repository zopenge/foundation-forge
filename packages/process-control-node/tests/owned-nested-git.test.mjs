import { Buffer } from 'node:buffer';
import { basename } from 'node:path';
import process from 'node:process';
import { expect, test } from 'vitest';
import { loadOwnedNative } from '../dist/owned-scope/native-loader.js';
import { createWindowsOwnedProcessScopeProvider, createWindowsProcessIdentityReader } from '../dist/index.js';

// 透传真实 Win32 调用；断言仅保留自有 Job 成员的状态和文件名，不记录参数、完整路径或环境。
async function observeMembers() {
  const native = await loadOwnedNative('win32'), original = native.load;
  const kernel = original('kernel32.dll');
  const image = kernel.func('__stdcall', 'QueryFullProcessImageNameW', 'int32_t', ['void *', 'uint32_t', 'void *', native.inout(native.pointer('uint32_t'))]);
  const handles = new Map(), members = [];
  native.load = (...args) => {
    const lib = original(...args), func = lib.func.bind(lib);
    return new Proxy(lib, { get(target, key) {
      if (key !== 'func') return Reflect.get(target, key);
      return (...declaration) => {
        const fn = func(...declaration), named = name => declaration.some(value => typeof value === 'string' && value.includes(name));
        return (...values) => {
          const result = fn(...values);
          if (named('OpenProcess') && result && values[0] === (0x1000 | 0x100000)) handles.set(result, { pid: values[2] });
          const row = handles.get(values[0]);
          if (row && named('IsProcessInJob')) row.belongs = result ? values[2][0] : null;
          if (row && named('WaitForSingleObject')) row.wait = Number(result);
          if (row && named('GetExitCodeProcess')) {
            row.exitCode = result ? values[1][0] : null;
            if (row.exitCode === 259) {
              const buffer = Buffer.alloc(65536), size = [32768];
              row.image = image(values[0], 0, buffer, size) ? basename(buffer.toString('utf16le', 0, size[0] * 2)) : null;
            }
          }
          if (row && named('CloseHandle')) { members.push(row); handles.delete(values[0]); }
          return result;
        };
      };
    } });
  };
  return { members, restore: () => { native.load = original; } };
}

test.runIf(process.platform === 'win32' && process.arch === 'x64').each([true, false])('closes a Node command after synchronous nested Git (windowsHide=%s)', async windowsHide => {
  const observation = await observeMembers();
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      observation.members.length = 0;
      const output = [];
      const scope = createWindowsOwnedProcessScopeProvider().start({ command: process.execPath,
        args: ['-e', 'process.stdout.write(require("node:child_process").execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8",windowsHide:process.argv[1] === "true"}).trim())', String(windowsHide)],
        environment: process.env, binding: 'nested-git', startupTimeoutMs: 10_000, terminationTimeoutMs: 5000 }, event => {
        if (event.stream === 'stdout') output.push(Buffer.from(event.chunk));
      });
      try {
        const value = await createWindowsProcessIdentityReader().readIdentity({ pid: await scope.rootPid });
        if (value.status !== 'FOUND') throw Error('fixture root absent');
        await scope.bind(value.identity); await scope.authorize();
        const result = await scope.completion;
        expect(result, JSON.stringify({ attempt, windowsHide, members: observation.members })).toMatchObject({
          exitCode: 0, closure: { status: 'closed', reason: 'normal', empty: true },
        });
        expect(Buffer.concat(output).toString('utf8')).toMatch(/^[a-f0-9]{40,64}$/u);
      } finally { await scope.dispose(); }
    }
  } finally { observation.restore(); }
}, 180_000);
