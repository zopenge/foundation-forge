import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const inspectOwnConsole = manifest => {
  if (process.platform !== 'win32') return { pid: process.pid, visible: null };
  const koffi = createRequire(pathToFileURL(manifest))('koffi');
  const handle = koffi.load('kernel32.dll').func('void * __stdcall GetConsoleWindow()')();
  return { pid: process.pid, visible: Boolean(handle && koffi.load('user32.dll').func('int __stdcall IsWindowVisible(void *)')(handle)) };
};
