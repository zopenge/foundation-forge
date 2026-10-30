import assert from 'node:assert/strict';
import test from 'node:test';
import { createWindowEventLedger } from '../../packages/process-control-node/test-window-events.mjs';

const member = { pid: 21, rootPid: 10, created: '123', createdAt: 100, image: 'git.exe', parentPid: 20 };
const shown = { event: 0x8002, hwnd: '99', pid: 30, at: 120, visible: true, consoleWindow: true };

test('退出身份保留历史但不再归属新窗口，迟到窗口必须保持未确认', () => {
  const flashes = [], ledger = createWindowEventLedger({ onFlash: value => flashes.push(value) });
  ledger.member(member); ledger.member({ ...member, retired: true });
  ledger.event({ ...shown, pid: 21, consoleWindow: false });
  assert.equal(flashes.length, 0); assert.equal(ledger.snapshot().members.length, 1);
  assert.equal(ledger.snapshot().members[0].retired, true);
  assert.deepEqual(ledger.snapshot().gaps, ['UNATTRIBUTED_VISIBLE_WINDOW']);
});

test('PID复用保存两个身份，仅新实例能归属新窗口，容量按历史实例计算', () => {
  const flashes = [], ledger = createWindowEventLedger({ onFlash: value => flashes.push(value), limit: 2 });
  ledger.member(member); ledger.member({ ...member, retired: true });
  ledger.member({ ...member, created: '456', createdAt: 140 });
  ledger.event({ ...shown, pid: 21, at: 150, consoleWindow: false });
  assert.equal(flashes[0].member.created, '456'); assert.equal(ledger.snapshot().members.length, 2);
  ledger.member({ ...member, created: '789', createdAt: 160 });
  assert.ok(ledger.snapshot().gaps.includes('MEMBER_OVERFLOW'));
});

test('退出更新不能抹掉已捕获闪窗，旧身份的迟到更新不能覆盖复用后的新身份', () => {
  const ledger = createWindowEventLedger(); ledger.member(member);
  ledger.event({ ...shown, pid: 21, consoleWindow: false }); ledger.member({ ...member, retired: true });
  assert.equal(ledger.snapshot().visibleWindows.length, 1);
  ledger.member({ ...member, created: '456', createdAt: 140 }); ledger.member({ ...member, retired: true });
  ledger.event({ ...shown, hwnd: '100', pid: 21, at: 150, consoleWindow: false });
  assert.equal(ledger.snapshot().visibleWindows[1].member.created, '456');
});

test('退休身份的旧活动更新不能重新取得窗口归属资格', () => {
  const ledger = createWindowEventLedger(); ledger.member(member); ledger.member({ ...member, retired: true });
  ledger.member(member); ledger.event({ ...shown, pid: 21, consoleWindow: false });
  assert.equal(ledger.snapshot().visibleWindows.length, 0);
  assert.equal(ledger.snapshot().members[0].retired, true);
  assert.ok(ledger.snapshot().gaps.includes('MEMBER_IDENTITY_REACTIVATED'));
});

test('窗口关联只读取相关PID的身份，不扫描其余成员', () => {
  const flashes = [], ledger = createWindowEventLedger({ onFlash: value => flashes.push(value), limit: 2048 });
  for (let pid = 1000; pid < 2000; pid++) ledger.member({ pid, get createdAt() { throw new Error('unrelated identity must not be read'); } });
  ledger.member(member);
  ledger.event({ ...shown, pid: 21, consoleWindow: false });
  assert.equal(flashes.length, 1); assert.equal(flashes[0].member.pid, 21);
});

test('PID索引仍按成员首次登记顺序选择关联，并拒绝晚于窗口创建的身份', () => {
  for (const order of [[21, 30], [30, 21]]) {
    const flashes = [], ledger = createWindowEventLedger({ onFlash: value => flashes.push(value) });
    for (const pid of order) ledger.member({ ...member, pid });
    ledger.member({ ...member, pid: order[0], image: 'updated' });
    ledger.event({ ...shown, event: 0x4006, visible: false, consolePid: 21 }); ledger.event(shown);
    assert.equal(flashes[0].member.pid, order[0]);
  }
  const flashes = [], ledger = createWindowEventLedger({ onFlash: value => flashes.push(value) });
  ledger.member({ ...member, createdAt: 121 }); ledger.member({ ...member, pid: 30 });
  ledger.event({ ...shown, event: 0x4006, visible: false, consolePid: 21 }); ledger.event(shown);
  assert.equal(flashes[0].member.pid, 30);
});

test('隐藏窗口不读取成员创建时间，等待真实可见事件才关联', () => {
  const ledger = createWindowEventLedger();
  ledger.member({ pid: 21, get createdAt() { throw new Error('hidden window must not read identity'); } });
  ledger.event({ ...shown, pid: 21, visible: false });
});

test('窗口事件按自有身份和控制台进程事件关联，早于身份到达也不漏报', () => {
  const flashes = [], ledger = createWindowEventLedger({ onFlash: value => flashes.push(value) });
  ledger.event(shown); ledger.event({ ...shown, event: 0x4006, consolePid: 21 });
  assert.equal(flashes.length, 0);
  ledger.member(member);
  assert.equal(flashes.length, 1); assert.equal(flashes[0].member.pid, 21);
  assert.equal(flashes[0].window.pid, 30); assert.equal(flashes[0].member.image, 'git.exe');
  ledger.event({ ...shown, at: 130 }); assert.equal(flashes.length, 1);
  assert.equal(ledger.snapshot().visibleWindows.length, 1); assert.deepEqual(ledger.snapshot().gaps, []);
});

test('外层Job外的实例证明按窗口生命周期保存，矛盾或HWND复用仍捕获闪窗', () => {
  const flashes = [], ledger = createWindowEventLedger({ onFlash: value => flashes.push(value) });
  ledger.event({ ...shown, consoleWindow: false });
  ledger.outside({ ...ledger.snapshot().unattributedWindows[0], created: '123', rootPid: 10, checkedAt: 125 });
  assert.deepEqual(ledger.snapshot().gaps, []); assert.equal(ledger.snapshot().outsideJobWindows.length, 1);
  ledger.member({ ...member, pid: 30 });
  assert.equal(flashes.length, 1); assert.ok(ledger.snapshot().gaps.includes('WINDOW_OWNERSHIP_CONTRADICTED'));
  const reused = createWindowEventLedger();
  reused.event({ ...shown, consoleWindow: false });
  reused.outside({ ...reused.snapshot().unattributedWindows[0], created: '123', rootPid: 10, checkedAt: 125 });
  reused.event({ ...shown, event: 0x8001, visible: false });
  reused.event({ ...shown, event: 0x8000, pid: 21, visible: false }); reused.member(member);
  reused.event({ ...shown, pid: 21, at: 130 });
  assert.equal(reused.snapshot().visibleWindows.length, 1);
});

test('已归属闪窗保留窗口类和控制台关联PID，仍不保存标题或应用内容', () => {
  const ledger = createWindowEventLedger();
  ledger.event({ ...shown, event: 0x4006, visible: false, consolePid: 21, windowClass: 'ConsoleWindowClass' });
  ledger.member(member);
  ledger.event({ ...shown, windowClass: 'ConsoleWindowClass', title: 'private-title', body: 'private-body' });
  const report = ledger.snapshot();
  assert.equal(report.visibleWindows[0].window.consoleWindow, true);
  assert.equal(report.visibleWindows[0].window.windowClass, 'ConsoleWindowClass');
  assert.deepEqual(report.visibleWindows[0].window.consolePids, [21]);
  assert.doesNotMatch(JSON.stringify(report), /private-title|private-body/u);
  ledger.event({ ...shown, event: 0x4006, consolePid: 22 });
  assert.deepEqual(ledger.snapshot().visibleWindows[0].window.consolePids, [21, 22]);
});

test('未知可见控制台、事件溢出及身份缺失不能变成无闪窗通过', () => {
  const ledger = createWindowEventLedger({ limit: 2 });
  ledger.event(shown);
  assert.deepEqual(ledger.snapshot().gaps, ['UNATTRIBUTED_VISIBLE_CONSOLE']);
  ledger.event({ ...shown, hwnd: '100' }); ledger.event({ ...shown, hwnd: '101' });
  assert.ok(ledger.snapshot().gaps.includes('EVENT_OVERFLOW'));
  assert.deepEqual(ledger.snapshot().visibleWindows, []);
});

test('PID 相同但事件早于创建时间不可归属；隐藏窗口不计为闪窗', () => {
  const ledger = createWindowEventLedger(); ledger.member(member);
  ledger.event({ ...shown, pid: 21, at: 99, consoleWindow: false });
  ledger.event({ ...shown, hwnd: '100', pid: 21, visible: false, consoleWindow: false });
  assert.deepEqual(ledger.snapshot().visibleWindows, []);
  ledger.event({ ...shown, hwnd: '100', pid: 21, consoleWindow: false });
  assert.equal(ledger.snapshot().visibleWindows.length, 1);
});

test('未知窗口仅保留有界诊断元数据，不能保存标题或其他应用内容', () => {
  const ledger = createWindowEventLedger();
  ledger.event({ ...shown, consoleWindow: false, windowClass: 'NativeClass', observedAt: 125, eventTick: 10,
    title: 'private-content', argv: 'private-argv', body: 'private-body' });
  ledger.gap('MEMBER_QUERY_FAILED');
  assert.doesNotMatch(JSON.stringify(ledger.snapshot()), /private-content|private-argv|private-body/u);
  assert.deepEqual(ledger.snapshot().unattributedWindows, [{ hwnd: '99', instance: 0, pid: 30, at: 120, event: 0x8002,
    consoleWindow: false, windowClass: 'NativeClass', observedAt: 125, eventTick: 10, consolePids: [] }]);
  assert.deepEqual(ledger.snapshot().gaps, ['MEMBER_QUERY_FAILED', 'UNATTRIBUTED_VISIBLE_WINDOW']);
});

test('HWND 销毁后复用是新窗口实例，旧的可见状态不能遮蔽新成员闪窗', () => {
  const ledger = createWindowEventLedger(); ledger.member(member);
  ledger.event({ ...shown, at: 50, consoleWindow: false });
  ledger.event({ ...shown, at: 60, event: 0x8001, visible: false });
  ledger.event({ ...shown, pid: 21, at: 110, event: 0x8000, visible: false });
  ledger.event({ ...shown, pid: 21, at: 120 });
  assert.equal(ledger.snapshot().visibleWindows.length, 1);
  assert.equal(ledger.snapshot().visibleWindows[0].member.pid, 21);
});
