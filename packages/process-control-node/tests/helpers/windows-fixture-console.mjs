import { loadOwnedNative } from '../../dist/owned-scope/native-loader.js';

// 只附加本次显式自有宿主；借用标准句柄只恢复，不关闭，不查找其他控制台。
export const fixtureConsole = async ({ ownerPid, native } = {}) => {
  if (ownerPid !== undefined && (!Number.isSafeInteger(ownerPid) || ownerPid < 1 || ownerPid >= 0xffffffff)) throw new Error('FIXTURE_CONSOLE_OWNER');
  native ??= await loadOwnedNative('win32');
  const kernel = native.load('kernel32.dll'), user = native.load('user32.dll');
  const window = kernel.func('void * __stdcall GetConsoleWindow()');
  const get = kernel.func('void * __stdcall GetStdHandle(uint32_t kind)');
  const set = kernel.func('int32_t __stdcall SetStdHandle(uint32_t kind, void *handle)');
  const type = kernel.func('uint32_t __stdcall GetFileType(void *handle)');
  const kinds = [0xfffffff6, 0xfffffff5, 0xfffffff4], original = kinds.map(kind => get(kind));
  if (ownerPid !== undefined) {
    if (window()) throw new Error('FIXTURE_ALREADY_ATTACHED');
    if (!kernel.func('int32_t __stdcall AttachConsole(uint32_t pid)')(ownerPid)) throw new Error('FIXTURE_CONSOLE_ATTACH');
    let failed = false;
    for (const [index, kind] of kinds.entries()) if (!set(kind, original[index])) failed = true;
    if (failed) throw new Error('FIXTURE_STANDARD_HANDLE_RESTORE');
  }
  const hwnd = window();
  if (!hwnd) throw new Error('FIXTURE_CONSOLE_ABSENT');
  const visible = Boolean(user.func('int32_t __stdcall IsWindowVisible(void *hwnd)')(hwnd));
  if (visible) throw new Error('FIXTURE_CONSOLE_VISIBLE');
  const preservedStandardHandles = kinds.every((kind, index) => String(get(kind)) === String(original[index]));
  if (!preservedStandardHandles) throw new Error('FIXTURE_STANDARD_HANDLES_CHANGED');
  return { hwnd: String(hwnd), visible, preservedStandardHandles, stdoutPipe: type(get(kinds[1])) === 3, stderrPipe: type(get(kinds[2])) === 3 };
};
