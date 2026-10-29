import assert from 'node:assert/strict';
import test from 'node:test';
import { createWindowsWindowHookPump } from '../../packages/process-control-node/test-window-hook-pump.mjs';

test('窗口 hook 用从不显示的自检窗口验证消息投递并释放资源', () => {
  const events = [], released = [], queue = []; let callback, hooks = 0, unhookOk = true, ancestorExists = true, classOk = true;
  const native = { struct: value => value, pointer: value => value, proto: value => value, out: value => value,
    sizeof: () => 48, register: value => { callback = value; return 7; }, unregister: value => released.push(['callback', value]),
    load: () => ({ func: (...declaration) => {
      const name = declaration.find(value => typeof value === 'string' && value !== '__stdcall');
      return (...args) => {
        if (name === 'SetWinEventHook') { hooks++; return hooks; }
        if (name === 'UnhookWinEvent') { released.push(['hook', args[0]]); return unhookOk ? 1 : 0; }
        if (name === 'GetCurrentThreadId') return 123;
        if (name === 'CreateWindowExW') { assert.equal(args[3], 0); return 88n; }
        if (name === 'DestroyWindow') { released.push(['window', args[0]]); return 1; }
        if (name === 'NotifyWinEvent') { assert.equal(args[1], 88n); queue.push(() => callback(1, args[0], args[1], args[2], args[3], 123, 100)); return; }
        if (name === 'PeekMessageW') { queue.shift()?.(); return 0; }
        if (name === 'GetAncestor') return ancestorExists ? args[0] : null;
        if (name === 'GetWindowThreadProcessId') { args[1][0] = 21; return 123; }
        if (name === 'IsWindowVisible') return 0;
        if (name === 'GetClassNameW') return classOk ? 1 : 0;
        if (name === 'GetTickCount') return 100;
        return 1;
      };
    } }) };
  const pump = createWindowsWindowHookPump(native, event => events.push(event));
  assert.equal(events.length, 0); pump.pump();
  assert.deepEqual(events, [{ type: 'ready', messageDelivery: true }]);
  callback(1, 0x8002, 99n, 0, 0, 123, 100);
  assert.equal(events[1].value.visible, true, 'SHOW 已发生，即使回调时窗口已隐藏也不能漏掉');
  assert.equal(events[1].value.eventThread, 123);
  assert.equal(events[1].value.windowThread, 123);
  ancestorExists = false; callback(1, 0x8001, 99n, 0, 0, 123, 100);
  assert.equal(events[2]?.value.event, 0x8001, 'DESTROY 时 HWND 已失效，仍须传递生命周期事件');
  callback(1, 0x8002, 99n, 0, 0, 456, 100);
  assert.deepEqual(events.at(-1), { type: 'gap', reason: 'WINDOW_DESTROYED_BEFORE_CLASSIFICATION',
    details: { event: 0x8002, hwnd: '99', eventThread: 456, eventTick: 100, eventDesktop: null, observerDesktop: null } });
  ancestorExists = true; classOk = false; callback(1, 0x8002, 100n, 0, 0, 123, 100);
  assert.equal(events.at(-1).value.consoleWindow, undefined, '类名读取失败不能证明不是控制台');
  pump.close(); pump.close();
  assert.deepEqual(released, [['window', 88n], ['hook', 1], ['hook', 2], ['callback', 7]]);
  unhookOk = false;
  const failed = createWindowsWindowHookPump(native, event => events.push(event));
  failed.close();
  assert.equal(released.filter(value => value[0] === 'callback').length, 1, '活动 hook 不能持有已释放 callback');
  assert.ok(events.some(value => value.type === 'gap' && value.reason === 'WINDOW_UNHOOK_FAILED'));
});
