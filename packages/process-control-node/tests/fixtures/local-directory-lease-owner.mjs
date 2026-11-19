import process from 'node:process';
import { acquireLocalDirectoryLease } from '@openge/forge-process-control-node';

process.once('disconnect', () => process.exit(1));
process.once('message', async ({ directory, options, mutexName }) => {
  try {
    if (mutexName) {
      // 独立探针复用旧协议的内核对象名称。句柄由 OS 在本用例进程退出时回收。
      const koffi = (await import('koffi')).default;
      const create = koffi.load('kernel32.dll').func('void * __stdcall CreateMutexW(void *attributes, int32_t owner, str16 name)');
      if (!create(null, 1, mutexName)) throw new Error('fixture mutex unavailable');
    } else {
      const lease = await acquireLocalDirectoryLease(directory, options);
      await lease.assertOwned();
    }
    process.send?.({ ready: true });
  } catch (error) {
    process.stderr.write(String(error)); process.exitCode = 1; process.disconnect();
  }
});
