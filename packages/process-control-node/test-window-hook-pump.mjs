import { Buffer } from 'node:buffer';

// 单独 Worker 的线程消息队列，避免被被测进程的同步命令阻塞。
export const createWindowsWindowHookPump = (native, send) => {
  const user = native.load('user32.dll'), kernel = native.load('kernel32.dll');
  const msgType = native.struct({ hwnd: 'void *', message: 'uint32_t', wParam: 'uintptr_t', lParam: 'intptr_t',
    time: 'uint32_t', x: 'int32_t', y: 'int32_t', private: 'uint32_t' });
  if (native.sizeof(msgType) !== 48) throw new Error('WINDOW_HOOK_ABI');
  const eventType = native.proto('void __stdcall ForgeWindowEvent(void *, uint32_t, void *, int32_t, int32_t, uint32_t, uint32_t)');
  const hook = user.func('__stdcall', 'SetWinEventHook', 'void *', ['uint32_t', 'uint32_t', 'void *', native.pointer(eventType), 'uint32_t', 'uint32_t', 'uint32_t']);
  const unhook = user.func('__stdcall', 'UnhookWinEvent', 'int32_t', ['void *']);
  const peek = user.func('__stdcall', 'PeekMessageW', 'int32_t', [native.out(native.pointer(msgType)), 'void *', 'uint32_t', 'uint32_t', 'uint32_t']);
  const translate = user.func('__stdcall', 'TranslateMessage', 'int32_t', [native.pointer(msgType)]);
  const dispatch = user.func('__stdcall', 'DispatchMessageW', 'intptr_t', [native.pointer(msgType)]);
  const visible = user.func('__stdcall', 'IsWindowVisible', 'int32_t', ['void *']);
  const ancestor = user.func('__stdcall', 'GetAncestor', 'void *', ['void *', 'uint32_t']);
  const windowPid = user.func('__stdcall', 'GetWindowThreadProcessId', 'uint32_t', ['void *', native.out(native.pointer('uint32_t'))]);
  const className = user.func('__stdcall', 'GetClassNameW', 'int32_t', ['void *', 'void *', 'int32_t']);
  const tick = kernel.func('__stdcall', 'GetTickCount', 'uint32_t', []);
  const thread = kernel.func('__stdcall', 'GetCurrentThreadId', 'uint32_t', [])();
  const threadDesktop = user.func('__stdcall', 'GetThreadDesktop', 'void *', ['uint32_t']);
  const objectName = user.func('__stdcall', 'GetUserObjectInformationW', 'int32_t', ['void *', 'int', 'void *', 'uint32_t', native.out(native.pointer('uint32_t'))]);
  const desktopName = tid => {
    const handle = threadDesktop(tid), buffer = Buffer.alloc(1024), size = [0];
    if (!handle || !objectName(handle, 2, buffer, buffer.length, size) || size[0] < 2 || size[0] > buffer.length) return null;
    return buffer.toString('utf16le', 0, size[0]).replace(/\0$/u, '');
  };
  const notify = user.func('__stdcall', 'NotifyWinEvent', 'void', ['uint32_t', 'void *', 'int32_t', 'int32_t']);
  const createWindow = user.func('__stdcall', 'CreateWindowExW', 'void *', ['uint32_t', 'str16', 'str16', 'uint32_t',
    'int32_t', 'int32_t', 'int32_t', 'int32_t', 'void *', 'void *', 'void *', 'void *']);
  const destroyWindow = user.func('__stdcall', 'DestroyWindow', 'int32_t', ['void *']);
  const hooks = []; let callback, controlWindow, closed = false, ready = false;
  const close = () => {
    if (closed) return; closed = true;
    if (controlWindow && !destroyWindow(controlWindow)) send({ type: 'gap', reason: 'WINDOW_CONTROL_DISPOSE_FAILED' });
    let released = true;
    for (const handle of hooks) if (!unhook(handle)) { released = false; send({ type: 'gap', reason: 'WINDOW_UNHOOK_FAILED' }); }
    if (callback && released) native.unregister(callback);
  };
  try {
    controlWindow = createWindow(0, 'STATIC', '', 0, 0, 0, 0, 0, null, null, null, null);
    if (!controlWindow || visible(controlWindow)) throw new Error('WINDOW_HIDDEN_CONTROL_FAILED');
    callback = native.register((_hook, event, hwnd, object, child, eventThread, eventTick) => {
      try {
        if (hwnd === controlWindow && event === 0x8002 && object === 0x3fff && child === 0 && eventThread === thread) {
          if (!ready) { ready = true; send({ type: 'ready', messageDelivery: true }); } return;
        }
        if (!hwnd || (event >= 0x8000 && (object !== 0 || child !== 0))) return;
        if (event >= 0x8000 && event !== 0x8001) {
          const root = ancestor(hwnd, 2);
          if (!root && event === 0x8002) send({ type: 'gap', reason: 'WINDOW_DESTROYED_BEFORE_CLASSIFICATION',
            details: { event, hwnd: String(hwnd), eventThread, eventTick, eventDesktop: desktopName(eventThread), observerDesktop: desktopName(thread) } });
          if (root !== hwnd) return;
        }
        const pid = [0], windowThread = Number(windowPid(hwnd, pid));
        const name = Buffer.alloc(512), length = className(hwnd, name, 256);
        const elapsed = (Number(tick()) - eventTick) >>> 0;
        if (elapsed > 15_000) { send({ type: 'gap', reason: 'WINDOW_EVENT_DELAY' }); return; }
        send({ type: 'window', value: { event, hwnd: String(hwnd), pid: pid[0], at: Date.now() - elapsed, observedAt: Date.now(), eventTick, eventThread, windowThread,
          windowClass: length > 0 ? name.toString('utf16le', 0, length * 2).slice(0, 128) : '',
          visible: event === 0x8002 || Boolean(visible(hwnd)), consoleWindow: event === 0x4006 || event === 0x4007 ? true
            : length > 0 ? name.toString('utf16le', 0, length * 2) === 'ConsoleWindowClass' : undefined,
          ...(event === 0x4006 ? { consolePid: object >>> 0 } : {}) } });
      } catch { send({ type: 'gap', reason: 'WINDOW_CALLBACK_FAILED' }); }
    }, native.pointer(eventType));
    // 控制台 start/end 提供实际应用 PID，可关联窗口宿主 conhost 的不同 PID。
    for (const [first, last] of [[0x4006, 0x4007], [0x8000, 0x8003]]) {
      const handle = hook(first, last, null, callback, 0, 0, 0);
      if (!handle) throw new Error('WINDOW_HOOK_FAILED'); hooks.push(handle);
    }
    // 自检对象始终无 WS_VISIBLE，不调用 ShowWindow；NULL HWND 不能验证真实投递。
    notify(0x8002, controlWindow, 0x3fff, 0);
  } catch (error) { close(); throw error; }
  return { close, pump: () => {
    if (closed) return;
    const message = {}; let count = 0;
    while (count < 32 && peek(message, null, 0, 0, 1)) { translate(message); dispatch(message); count++; }
    if (count === 32) send({ type: 'gap', reason: 'WINDOW_MESSAGE_BACKLOG' });
  } };
};
