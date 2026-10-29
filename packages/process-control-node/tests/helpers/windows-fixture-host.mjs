import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { loadOwnedNative } from '../../dist/owned-scope/native-loader.js';
import { createWindowsJob } from '../../dist/owned-scope/windows-job.js';

// 暂停创建私有夹具宿主，以自有Job覆盖其全部后代，不依赖外层诊断入口。
export const runWindowsFixtureHost = async ({ executable, args, cwd, timeoutMs, native, createBackend = createWindowsJob }) => {
  const paths = [executable, ...args];
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || paths.some(value => typeof value !== 'string' || !value || /["\0\r\n]/u.test(value) || value.endsWith('\\')))
    throw new Error('FIXTURE_HOST_ARGUMENTS');
  native ??= await loadOwnedNative('win32');
  const kernel = native.load('kernel32.dll');
  const startupType = native.struct({ cb: 'uint32_t', reserved: 'void *', desktop: 'str16', title: 'void *', x: 'uint32_t', y: 'uint32_t',
    width: 'uint32_t', height: 'uint32_t', xChars: 'uint32_t', yChars: 'uint32_t', fill: 'uint32_t', flags: 'uint32_t',
    show: 'uint16_t', reservedBytes: 'uint16_t', reserved2: 'void *', input: 'void *', output: 'void *', error: 'void *' });
  const processType = native.struct({ process: 'void *', thread: 'void *', pid: 'uint32_t', tid: 'uint32_t' });
  if (native.sizeof(startupType) !== 104 || native.sizeof(processType) !== 24) throw new Error('FIXTURE_HOST_ABI');
  const create = kernel.func('__stdcall', 'CreateProcessW', 'int32_t', ['str16', 'void *', 'void *', 'void *', 'int32_t', 'uint32_t', 'void *', 'str16', native.pointer(startupType), native.out(native.pointer(processType))]);
  const wait = kernel.func('__stdcall', 'WaitForSingleObject', 'uint32_t', ['void *', 'uint32_t']);
  const exitCode = kernel.func('__stdcall', 'GetExitCodeProcess', 'int32_t', ['void *', native.out(native.pointer('uint32_t'))]);
  const terminate = kernel.func('__stdcall', 'TerminateProcess', 'int32_t', ['void *', 'uint32_t']);
  const resume = kernel.func('__stdcall', 'ResumeThread', 'uint32_t', ['void *']);
  const close = kernel.func('__stdcall', 'CloseHandle', 'int32_t', ['void *']);
  const lastError = kernel.func('__stdcall', 'GetLastError', 'uint32_t', []);
  const fail = stage => Object.assign(new Error(stage), { code: 'FIXTURE_HOST_FAILED', details: { stage, nativeCode: Number(lastError()) } });
  const errors = [], info = { process: null, thread: null, pid: 0, tid: 0 };
  let backend, created = false, attached = false, ended = false, empty = false, code;
  const cleanup = async () => {
    if (created && !empty) {
      try { await backend.force(); } catch (error) { errors.push(error); }
      // attach失败时宿主仍暂停，尚不能创建后代；只终止本次CreateProcess返回的精确句柄。
      try {
        if (!attached && !ended && !terminate(info.process, 125)) throw fail('HOST_STOP');
        if (Number(wait(info.process, 1000)) !== 0) throw fail('HOST_STOP');
      } catch (error) { errors.push(error); }
      if (attached) {
        try { if (!await backend.empty(true, { deadline: performance.now() + 5000 })) throw fail('JOB_NOT_EMPTY'); }
        catch (error) { errors.push(error); }
      }
    }
    for (const handle of created ? [info.thread, info.process] : []) {
      try { if (handle && !close(handle)) throw fail('CLOSE_HOST_HANDLE'); } catch (error) { errors.push(error); }
    }
    try { await backend?.dispose(); } catch (error) { errors.push(error); }
  };
  try {
    backend = await createBackend();
    const startup = { cb: 104, reserved: null, desktop: null, title: null, x: 0, y: 0, width: 0, height: 0, xChars: 0, yChars: 0,
      fill: 0, flags: 1, show: 0, reservedBytes: 0, reserved2: null, input: null, output: null, error: null };
    const commandLine = Buffer.from(`${paths.map(value => `"${value}"`).join(' ')}\0`, 'utf16le');
    // 宿主先暂停加入自有Job，再恢复；不依赖外层验收Job，也不继承任意句柄。
    // CREATE_NEW_CONSOLE在创建边界由STARTF_USESHOWWINDOW/SW_HIDE隐藏，不先显示再隐藏。
    created = Boolean(create(executable, commandLine, null, null, 0, 0x14, null, cwd, startup, info));
    if (!created) throw fail('CREATE_HOST');
    await backend.attach(info.pid); attached = true;
    if (Number(resume(info.thread)) !== 1) throw fail('RESUME_HOST');
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const state = Number(wait(info.process, 0));
      if (state === 0) { ended = true; break; }
      if (state !== 258) throw fail('WAIT_HOST');
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw fail('HOST_DEADLINE');
      await delay(Math.min(10, remaining));
    }
    const output = [0]; if (!exitCode(info.process, output)) throw fail('HOST_EXIT_CODE');
    code = output[0]; if (code !== 0) throw Object.assign(fail('HOST_FAILED'), { exitCode: code });
    empty = await backend.empty(true, { deadline: performance.now() + 1000 });
    if (!empty) throw fail('HOST_DESCENDANTS');
  } catch (error) { errors.push(error); }
  finally { await cleanup(); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'FIXTURE_HOST_FAILED');
  return { pid: info.pid, exitCode: code, empty };
};
