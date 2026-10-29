import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { createWindowsWindowJobSampler } from '../../packages/process-control-node/test-window-job-sampler.mjs';
import { createWindowEventLedger } from '../../packages/process-control-node/test-window-events.mjs';

test('窗口采样只打开自有Job返回的成员，原生失败不透传，实例句柄保持到收尾', () => {
  const opened = [], closed = [], members = [], gaps = [], failures = []; let complete = true, belongs = true, queryOk = true;
  const library = { func: (...declaration) => {
    const name = declaration.find(value => typeof value === 'string' && value !== '__stdcall');
    return (...args) => {
      if (name === 'QueryInformationJobObject') {
        if (args[1] === 1) { args[2].total = 100000; return 1; }
        Object.assign(args[2], { assigned: 2, count: complete ? 2 : 1, ids: [10, 21] }); return queryOk ? 1 : 0;
      }
      if (name === 'GetLastError') return 1234;
      if (name === 'WaitForSingleObject') return 258;
      if (name === 'OpenProcess') { opened.push(args[2]); return args[2] + 100; }
      if (name === 'IsProcessInJob') { args[2][0] = belongs ? 1 : 0; return 1; }
      if (name === 'GetProcessTimes') { Object.assign(args[1], { high: 27111902, low: 3577643008 }); return 1; }
      if (name === 'QueryFullProcessImageNameW') { args[2].write('C:\\private\\git.exe', 'utf16le'); args[3][0] = 18; return 1; }
      if (name === 'NtQueryInformationProcess') { args[2].uniqueProcessId = args[0] - 100; args[2].parentProcessId = 10; args[4][0] = 48; return 0; }
      if (name === 'CloseHandle') closed.push(args[0]);
      return 1;
    };
  } };
  const native = { load: () => library, struct: value => value, pointer: value => value, out: value => value, inout: value => value,
    array: (_type, count) => count, sizeof: value => value?.ids ? 32776 : typeof value === 'string' ? 8 : 48,
    offsetof: (_type, field) => field === 'uniqueProcessId' ? 32 : 40 };
  const sampler = createWindowsWindowJobSampler(native, { member: value => members.push(value), gap: (value, details) => {
    gaps.push(value); if (details) failures.push(details);
  } });
  sampler.assigned(1, 10); sampler.sample(); sampler.sample();
  assert.deepEqual(opened, [10, 21]); assert.equal(members.length, 2);
  assert.deepEqual(members[1], { pid: 21, rootPid: 10, created: '116444736000000000', createdAt: 0 });
  assert.deepEqual(closed, []); sampler.closing(1); assert.deepEqual(closed, [110, 121]);
  complete = false; queryOk = false; sampler.assigned(2, 10); sampler.sample();
  assert.equal(opened.length, 2); assert.ok(gaps.includes('JOB_MEMBERS_INCOMPLETE'));
  assert.deepEqual(failures, [{ rootPid: 10, queryOk: false, assigned: 2, count: 1, capacity: 4096, nativeCode: 1234 }],
    '保留真实查询状态和字段，不能把原因不明的失败一律猜作缓冲区不足');
  sampler.closing(2); complete = true; queryOk = true; belongs = false; sampler.assigned(3, 10); sampler.sample();
  assert.equal(members.length, 2); assert.ok(gaps.includes('MEMBER_IDENTITY_UNCONFIRMED'));
  sampler.close(); assert.deepEqual(closed, [110, 121, 110, 121], '归属失败也必须释放整批已固定实例');
  assert.doesNotMatch(JSON.stringify(members), /private/u);
  belongs = true;
  const limited = createWindowsWindowJobSampler(native, { member() {}, gap: value => gaps.push(value) }, { limit: 1 });
  const before = opened.length; limited.assigned(4, 10); limited.sample();
  assert.equal(opened.length - before, 1, '显式成员上限不能被忽略');
  assert.ok(gaps.includes('MEMBER_LIMIT')); limited.close();
  queryOk = false;
  const failedQuery = createWindowsWindowJobSampler(native, { member() { assert.fail('失败查询不可打开成员'); },
    gap: (_reason, details) => failures.push(details) });
  const previousOpens = opened.length; failedQuery.assigned(5, 10); failedQuery.sample(); failedQuery.close();
  assert.equal(opened.length, previousOpens);
  assert.deepEqual(failures.at(-1), { rootPid: 10, queryOk: false, assigned: 2, count: 2, capacity: 4096, nativeCode: 1234 });
});

test('成员上限在任何原生调用前校验，完整验收最多记录有界的32768个实例', () => {
  assert.throws(() => createWindowsWindowJobSampler(undefined, {}, { limit: 0 }), RangeError);
  assert.throws(() => createWindowsWindowJobSampler(undefined, {}, { limit: 32769 }), RangeError);
});

test('完整验收可记录超过8192个历史实例的容量，仍逐一固定核验并关闭成员', () => {
  const lists = Array.from({ length: 8193 }, (_, index) => ({ assigned: 1, count: 1, ids: [index + 10] }));
  const f = transitionFixture(lists, { limit: 32768 });
  f.sampler.assigned(1, 10);
  for (let index = 0; index < lists.length; index++) f.sampler.sample();
  assert.equal(f.members.length, 8193); assert.equal(f.members.at(-1).pid, 8202);
  assert.deepEqual(f.gaps, []); assert.equal(f.opened.length, 8193);
  f.sampler.close(); assert.equal(f.closed.length, 8193);
});

// 原生边界只返回这些自有Job的固定列表，不允许透传OS调用。
const transitionFixture = (lists, options = {}, faults = {}) => {
  const opened = [], closed = [], members = [], gaps = [], calls = [], handles = new Map();
  let reads = 0, accountingReads = 0, windowReads = 0, waitReads = 0;
  const library = { func: (...declaration) => {
    const name = declaration.find(value => typeof value === 'string' && value !== '__stdcall');
    return (...args) => {
      calls.push(name);
      const intercepted = faults.beforeCall?.(name, args);
      if (intercepted !== undefined) return intercepted;
      if (name === 'GetLastError') return faults.nativeCode ?? 87;
      if (name === faults.fail) return name === 'NtQueryInformationProcess' ? -1073741558 : 0;
      if (name === 'GetWindowThreadProcessId') {
        const pair = faults.windowPairs?.[windowReads++]; args[1][0] = pair?.[0] ?? faults.windowPid ?? 31; return pair?.[1] ?? faults.windowThread ?? 7;
      }
      if (name === 'WaitForSingleObject') return args[0] === 7007 ? faults.threadWait ?? 258 : faults.waits?.[waitReads++] ?? faults.wait ?? 258;
      if (name === 'OpenThread') return 7007;
      if (name === 'GetProcessIdOfThread') return faults.threadPid ?? 31;
      if (name === 'QueryInformationJobObject') {
        if (args[1] === 1) {
          const index = accountingReads++, value = faults.accountings?.[Math.min(index, faults.accountings.length - 1)] ?? 100000;
          args[2].total = typeof value === 'number' ? value : value.total;
          return value.ok === false ? 0 : 1;
        }
        const index = reads++;
        if (faults.queryReads?.includes(index)) throw new Error('fixture last query failed');
        const { ok = true, ...list } = lists[Math.min(index, lists.length - 1)];
        Object.assign(args[2], list); return ok ? 1 : 0;
      }
      if (name === 'OpenProcess') {
        opened.push(args[2]); const handle = args[2] + 100 + (faults.uniqueHandles ? opened.length * 1000 : 0);
        handles.set(handle, args[2]); return handle;
      }
      if (name === 'IsProcessInJob') { args[2][0] = faults.insideJob === args[1] || !faults.outside ? 1 : 0; return 1; }
      if (name === 'GetProcessTimes' || name === 'GetThreadTimes') {
        const token = 116444736000000000n + BigInt(name === 'GetThreadTimes' ? faults.threadCreatedAt ?? 0 : faults.createdAt ?? 0) * 10000n;
        Object.assign(args[1], { high: Number(token >> 32n), low: Number(token & 0xffffffffn) }); return 1;
      }
      if (name === 'QueryFullProcessImageNameW') { args[2].write('C:\\private\\git.exe', 'utf16le'); args[3][0] = 18; return 1; }
      if (name === 'NtQueryInformationProcess') {
        args[2].uniqueProcessId = faults.wrongPid ? 99 : handles.get(args[0]); args[2].parentProcessId = 10;
        args[4][0] = faults.wrongLength ? 40 : 48; return 0;
      }
      if (name === 'CloseHandle') { closed.push(args[0]); if (faults.closeHandles?.includes(args[0])) throw new Error('fixture handle close failed'); }
      return 1;
    };
  } };
  const native = { load: () => library, struct: value => value, pointer: value => value, out: value => value, inout: value => value,
    array: (_type, count) => count, sizeof: value => value?.ids ? 32776 : typeof value === 'string' ? 8 : 48,
    offsetof: (_type, field) => field === 'uniqueProcessId' ? 32 : 40 };
  const sampler = createWindowsWindowJobSampler(native, { member: value => {
    if (faults.publishPid === value.pid) throw new Error('fixture member publication failed');
    members.push(value);
  }, gap: (reason, details) => gaps.push({ reason, details }) }, options);
  sampler.assigned(1, 10);
  return { sampler, opened, closed, members, gaps, calls, reads: () => reads, accountingReads: () => accountingReads };
};

test('已触发退出的自有实例及时释放句柄，活动实例继续持有，历史身份仍保留', () => {
  const f = transitionFixture([{ assigned: 2, count: 2, ids: [10, 21] }, { assigned: 1, count: 1, ids: [10] }], {},
    { waits: [258, 0], accountings: [2, 2, 2, 2] });
  f.sampler.sample(); const priorCalls = f.calls.length; f.sampler.sample();
  assert.deepEqual(f.gaps, []); assert.deepEqual(f.closed, [121]);
  assert.deepEqual(f.members.filter(value => value.retired).map(value => value.pid), [21]);
  assert.ok(f.calls.indexOf('CloseHandle', priorCalls) < f.calls.indexOf('QueryInformationJobObject', priorCalls));
  f.sampler.close(); assert.deepEqual(f.closed, [121, 110]);
});

test('PID复用按创建令牌确认新实例，退出旧实例重现不得重复增加累计确认数', () => {
  const faults = { uniqueHandles: true, createdAt: 100, waits: [258, 0, 258, 0, 0], accountings: [2, 2, 3, 3, 3, 3] };
  const f = transitionFixture([{ assigned: 2, count: 2, ids: [10, 21] }, { assigned: 2, count: 2, ids: [10, 21] },
    { assigned: 3, count: 2, ids: [10, 21] }], {}, faults);
  f.sampler.sample(); faults.createdAt = 200; f.sampler.sample(); f.sampler.sample();
  assert.deepEqual(f.gaps, []);
  assert.deepEqual(f.members.filter(value => value.pid === 21 && !value.retired).map(value => value.createdAt), [100, 200]);
  assert.equal(f.sampler.snapshot().membershipTransitions[0].coverage.confirmed, 3);
  assert.equal(f.sampler.hasPending(), false); f.sampler.close();
  assert.equal(f.closed.length, f.opened.length);
});

test('释放退出实例不重置历史容量，新增实例仍在原上限前停止', () => {
  const f = transitionFixture([{ assigned: 2, count: 2, ids: [10, 21] }, { assigned: 2, count: 2, ids: [10, 22] }],
    { limit: 2 }, { waits: [258, 0], accountings: [2, 2, 3, 3] });
  f.sampler.sample(); f.sampler.sample();
  assert.equal(f.gaps[0]?.reason, 'MEMBER_LIMIT'); assert.deepEqual(f.opened, [10, 21]);
  assert.deepEqual(f.closed, [121]); f.sampler.close(); assert.deepEqual(f.closed, [121, 110]);
});

test('实例退出信号查询失败立即停止，不能释放未证明退出的实例或继续查询Job', () => {
  const f = transitionFixture([{ assigned: 1, count: 1, ids: [10] }], {}, { waits: [0xffffffff] });
  f.sampler.sample(); f.sampler.sample();
  assert.equal(f.gaps[0]?.reason, 'MEMBER_IDENTITY_UNCONFIRMED');
  assert.equal(f.gaps[0]?.details?.operation, 'WaitForSingleObject');
  assert.equal(f.reads(), 1); assert.deepEqual(f.closed, []);
  f.sampler.close(); assert.deepEqual(f.closed, [110]);
});

test('退休句柄关闭失败仍令采集失败，不继续查询或把该实例当新身份', () => {
  let rejectClose = false;
  const f = transitionFixture([{ assigned: 1, count: 1, ids: [10] }], {}, {
    waits: [0], beforeCall: name => name === 'CloseHandle' && rejectClose ? 0 : undefined,
  });
  f.sampler.sample(); rejectClose = true; f.sampler.sample();
  assert.equal(f.gaps[0]?.reason, 'MEMBER_HANDLE_CLOSE_FAILED'); assert.equal(f.reads(), 1);
  assert.deepEqual(f.closed, []); rejectClose = false; f.sampler.close(); assert.deepEqual(f.closed, [110]);
});

test('同批退出旧实例探测不占新增历史额度，未达上限的新实例仍可确认', () => {
  const f = transitionFixture([{ assigned: 1, count: 1, ids: [10] }, { assigned: 2, count: 2, ids: [10, 20] }],
    { limit: 2 }, { waits: [0, 0], accountings: [1, 1, 2, 2] });
  f.sampler.sample(); f.sampler.sample();
  assert.deepEqual(f.gaps, []);
  assert.deepEqual(f.members.filter(value => !value.retired).map(value => value.pid), [10, 20]);
  assert.deepEqual(f.opened, [10, 10, 20]); f.sampler.close(); assert.equal(f.closed.length, f.opened.length);
});

for (const mode of ['retire-close', 'reobserved-wait', 'reobserved-close']) test(`退休路径原生抛错须锁存失败，pending收尾不可再采样：${mode}`, () => {
  let waits = 0, closes = 0;
  const f = transitionFixture(mode === 'retire-close' ? [{ assigned: 2, count: 1, ids: [10] }]
    : [{ assigned: 1, count: 1, ids: [10] }, { assigned: 2, count: 1, ids: [10] }], {}, {
    waits: [0, 0], accountings: [2, 2, 2, 2], beforeCall: name => {
      if (name === 'WaitForSingleObject' && ++waits === 2 && mode === 'reobserved-wait') throw new Error('fixture wait throw');
      if (name === 'CloseHandle' && ++closes === (mode === 'retire-close' ? 1 : 2) && mode !== 'reobserved-wait') throw new Error('fixture close throw');
    },
  });
  f.sampler.sample(); assert.doesNotThrow(() => f.sampler.sample());
  assert.equal(f.gaps[0]?.reason, mode === 'reobserved-wait' ? 'MEMBER_IDENTITY_UNCONFIRMED' : 'MEMBER_HANDLE_CLOSE_FAILED');
  const reads = f.reads(); f.sampler.close(); assert.equal(f.reads(), reads);
  assert.equal(f.closed.length, f.opened.length);
});

test('完整基线后的累计新增与已确认新实例相等，可证明数字仍不一致的列表覆盖完整', t => {
  let now = 1000; t.mock.method(performance, 'now', () => now);
  const f = transitionFixture([{ assigned: 2, count: 2, ids: [10, 20] },
    { assigned: 3, count: 2, ids: [10, 21] }, { assigned: 4, count: 2, ids: [10, 22] }], {},
  { accountings: [2, 2, 3, 3, 4, 4] });
  f.sampler.sample(); now = 1001; f.sampler.sample(); now = 1002; f.sampler.sample();
  assert.deepEqual(f.gaps, []); assert.equal(f.sampler.hasPending(), false);
  assert.deepEqual(f.members.map(value => value.pid), [10, 20, 21, 22]);
  const records = f.sampler.snapshot().membershipTransitions;
  assert.equal(records.length, 2);
  assert.equal(records[0].status, 'settled'); assert.equal(records[0].resolution, 'instance-delta');
  assert.equal(records[0].latest.assigned, 3); assert.equal(records[0].latest.count, 2, '原始不一致数字不能改写为一致');
  assert.deepEqual(records[0].coverage, { baselineTotal: 2, baselineConfirmed: 2, total: 3, confirmed: 3, added: 1 });
  assert.deepEqual(records[1].coverage, { baselineTotal: 3, baselineConfirmed: 3, total: 4, confirmed: 4, added: 1 });
  assert.deepEqual(records[0].basis, { total: 2, confirmed: 2, beforeTotal: 2, assigned: 2, count: 2, resolution: 'pid-list' });
  assert.deepEqual(records[1].basis, { total: 3, confirmed: 3, beforeTotal: 3, assigned: 3, count: 2, resolution: 'instance-delta' });
  assert.deepEqual(f.closed, []); f.sampler.close(); assert.deepEqual(f.closed, [110, 120, 121, 122]);
});

test('真实原生返回的BigUint64Array先转换为普通PID数组，再验证唯一集合', () => {
  const f = transitionFixture([{ assigned: 2, count: 2, ids: new BigUint64Array([10n, 20n]) }], {}, { accountings: [2, 2] });
  assert.doesNotThrow(() => f.sampler.sample()); f.sampler.close();
  assert.deepEqual(f.gaps, []); assert.deepEqual(f.members.map(value => value.pid), [10, 20]);
  assert.deepEqual(f.closed, [110, 120]);
});

test('漏掉一个新增实例时累计差额不能放行，原20毫秒截止和句柄收尾仍有效', t => {
  let now = 1000; t.mock.method(performance, 'now', () => now);
  const f = transitionFixture([{ assigned: 2, count: 2, ids: [10, 20] }, { assigned: 4, count: 2, ids: [10, 21] }], {},
    { accountings: [2, 2, 4, 4] });
  f.sampler.sample(); f.sampler.sample();
  assert.equal(f.sampler.hasPending(), true); assert.equal(f.members.length, 3);
  now = 1020; f.sampler.sample();
  assert.equal(f.gaps[0]?.reason, 'JOB_MEMBERS_INCOMPLETE');
  assert.equal(f.sampler.snapshot().membershipTransitions[0].status, 'failed');
  f.sampler.close(); assert.deepEqual(f.closed, [110, 120, 121]);
});

test('无完整基线或基线前后累计量改变，不能只凭当前累计量等于已知数接受差异', t => {
  t.mock.method(performance, 'now', () => 1000);
  const cases = [
    [[{ assigned: 3, count: 2, ids: [10, 20] }], [2, 2]],
    [[{ assigned: 2, count: 2, ids: [10, 20] }, { assigned: 3, count: 2, ids: [10, 21] }], [2, 3, 3, 3]],
  ];
  for (const [lists, accountings] of cases) {
    const f = transitionFixture(lists, {}, { accountings });
    for (let index = 0; index < lists.length; index++) f.sampler.sample();
    assert.equal(f.sampler.hasPending(), true); f.sampler.close();
    assert.equal(f.gaps[0]?.reason, 'JOB_MEMBERS_INCOMPLETE');
  }
});

test('不稳定的一致列表保留旧基线，后续只有补齐全部新增实例才可证明完整', t => {
  t.mock.method(performance, 'now', () => 1000);
  for (const missed of [false, true]) {
    const f = transitionFixture([{ assigned: 2, count: 2, ids: [10, 20] }, { assigned: 2, count: 2, ids: [10, 21] },
      { assigned: 4, count: 2, ids: [10, 22] }], {}, { accountings: [2, 2, 3, 4, missed ? 5 : 4, missed ? 5 : 4] });
    f.sampler.sample(); f.sampler.sample(); f.sampler.sample();
    assert.equal(f.sampler.hasPending(), missed);
    const record = f.sampler.snapshot().membershipTransitions[0];
    if (!missed) assert.deepEqual(record.coverage, { baselineTotal: 2, baselineConfirmed: 2, total: 4, confirmed: 4, added: 2 });
    f.sampler.close(); assert.equal(f.gaps.length, missed ? 1 : 0);
  }
});

test('累计量在任何连续读数间回退、无效或查询失败，都立即留下缺口', () => {
  for (const accountings of [[100, 102, 101], [2, 2, { total: 3, ok: false }], [2, 2, -1], [2, 2, 0x100000000], [1, 1]]) {
    const f = transitionFixture([{ assigned: 2, count: 2, ids: [10, 20] }], {}, { accountings });
    f.sampler.sample(); f.sampler.sample(); f.sampler.close();
    assert.equal(f.gaps[0]?.reason, 'JOB_ACCOUNTING_UNCONFIRMED');
    assert.equal(f.sampler.snapshot().membershipTransitions.some(value => value.resolution === 'instance-delta'), false);
    assert.equal(f.closed.length, f.opened.length);
  }
});

test('累计查询抛出原生参数异常时保留具体阶段，立即失败且不继续查询成员', () => {
  const f = transitionFixture([{ assigned: 1, count: 1, ids: [10] }], {}, { beforeCall: (name, args) => {
    if (name === 'QueryInformationJobObject' && args[1] === 1) throw new TypeError('fixture accounting argument');
  } });
  assert.doesNotThrow(() => f.sampler.sample()); f.sampler.close();
  assert.equal(f.gaps[0]?.reason, 'JOB_ACCOUNTING_UNCONFIRMED');
  assert.equal(f.gaps[0]?.details.stage, 'before');
  assert.equal(f.gaps[0]?.details.nativeException, 'fixture accounting argument');
  assert.deepEqual(f.opened, []); assert.equal(f.reads(), 0);
});

test('每个Job的累计量只与自身确认集合配对，兄弟Job新增不能补另一个Job的缺口', t => {
  t.mock.method(performance, 'now', () => 1000);
  const totals = new Map([[1, 2], [2, 2]]); let lists = 0;
  const f = transitionFixture([{ assigned: 2, count: 2, ids: [10, 20] }, { assigned: 2, count: 2, ids: [10, 20] },
    { assigned: 2, count: 2, ids: [30, 40] }, { assigned: 3, count: 2, ids: [10, 21] },
    { assigned: 4, count: 2, ids: [30, 41] }], {}, { beforeCall: (name, args) => {
      if (name !== 'QueryInformationJobObject') return;
      if (args[1] === 1) { args[2].total = totals.get(args[0]); return 1; }
      if (++lists === 4) totals.set(1, 3);
      if (lists === 5) totals.set(2, 4);
    } });
  f.sampler.sample(); f.sampler.assigned(2, 30); f.sampler.sample(); f.sampler.sample();
  assert.deepEqual(f.sampler.snapshot().pendingJobSamples, [30]);
  assert.equal(f.sampler.snapshot().membershipTransitions[0].resolution, 'instance-delta');
  f.sampler.close(); assert.equal(f.gaps.length, 1); assert.equal(f.gaps[0]?.details.rootPid, 30);
  assert.deepEqual(f.closed, [110, 120, 121, 130, 140, 141]);
});

test('重复PID不能冒充完整实例集合建立基线', () => {
  const f = transitionFixture([{ assigned: 2, count: 2, ids: [10, 10] }], {}, { accountings: [2, 2] });
  f.sampler.sample(); f.sampler.close();
  assert.equal(f.gaps[0]?.reason, 'JOB_MEMBERS_INCOMPLETE');
  assert.equal(f.gaps[0]?.details.operation, 'unique-process-ids'); assert.deepEqual(f.members, []);
});

test('身份发布后的最终累计查询返回超出20毫秒，即使增量相等也不能结算', t => {
  let now = 1000, accounts = 0; t.mock.method(performance, 'now', () => now);
  const f = transitionFixture([{ assigned: 2, count: 2, ids: [10, 20] }, { assigned: 3, count: 2, ids: [10, 21] }], {},
    { accountings: [2, 2, 3, 3], beforeCall: (name, args) => {
      if (name === 'QueryInformationJobObject' && args[1] === 1 && ++accounts === 4) now = 1020;
    } });
  f.sampler.sample(); f.sampler.sample(); f.sampler.close();
  assert.equal(f.gaps[0]?.reason, 'JOB_MEMBERS_INCOMPLETE'); assert.equal(f.gaps[0]?.details.pendingMs, 20);
  assert.equal(f.sampler.snapshot().membershipTransitions[0].status, 'failed');
});

test('最终累计数必须在列表及身份发布之后读取，防止先漏A再确认B的数量巧合', t => {
  t.mock.method(performance, 'now', () => 1000);
  let actualTotal = 2, lists = 0, f;
  f = transitionFixture([{ assigned: 2, count: 2, ids: [10, 20] }, { assigned: 4, count: 2, ids: [10, 21] }], {},
    { beforeCall: (name, args) => {
      if (name !== 'QueryInformationJobObject') return;
      if (args[1] === 3 && ++lists === 2) actualTotal = 4;
      if (args[1] === 1) { args[2].total = actualTotal; return 1; }
    } });
  f.sampler.sample(); actualTotal = 3; f.sampler.sample();
  assert.equal(f.members.length, 3); assert.equal(f.sampler.hasPending(), true);
  assert.equal(f.calls.at(-1), 'QueryInformationJobObject');
  f.sampler.close(); assert.equal(f.gaps[0]?.reason, 'JOB_MEMBERS_INCOMPLETE');
});

test('未确认或发布失败的固定句柄不能计入完整性证明，全部已持有实例仍须释放', () => {
  for (const faults of [{ fail: 'GetProcessTimes' }, { publishPid: 21 }]) {
    const f = transitionFixture([{ assigned: 3, count: 2, ids: [10, 21] }], {}, { ...faults, accountings: [2, 2] });
    assert.doesNotThrow(() => f.sampler.sample()); f.sampler.close();
    assert.equal(f.gaps[0]?.reason, 'MEMBER_IDENTITY_UNCONFIRMED');
    assert.equal(f.accountingReads(), 1, '确认失败后不继续读取用于证明的累计量');
    assert.deepEqual(f.closed, [110, 121]);
  }
});

test('Job注册实例关闭后，句柄值复用不能继承旧完整基线', t => {
  t.mock.method(performance, 'now', () => 1000);
  const f = transitionFixture([{ assigned: 2, count: 2, ids: [10, 20] }, { assigned: 3, count: 2, ids: [10, 21] }], {},
    { accountings: [2, 2, 3, 3] });
  f.sampler.sample(); f.sampler.closing(1); f.sampler.assigned(1, 10); f.sampler.sample();
  assert.equal(f.sampler.hasPending(), true); f.sampler.close();
  assert.equal(f.gaps[0]?.reason, 'JOB_MEMBERS_INCOMPLETE'); assert.deepEqual(f.closed, [110, 120, 110, 121]);
});

test('成功查询的计数变化有界收敛，并保留每批已证实成员到Job关闭', t => {
  let now = 1000; t.mock.method(performance, 'now', () => now);
  const f = transitionFixture([{ assigned: 3, count: 2, ids: [10, 21] }, { assigned: 2, count: 2, ids: [10, 22] }]);
  f.sampler.sample();
  assert.deepEqual(f.gaps, [], '成功查询的瞬时计数差异尚待核对，不能先制造永久失败');
  assert.deepEqual(f.opened, [10, 21]);
  assert.equal(f.sampler.snapshot().pendingJobSamples.length, 1);
  assert.equal(f.sampler.hasPending(), true);
  const flashes = [], ledger = createWindowEventLedger({ onFlash: value => flashes.push(value) });
  for (const member of f.members) ledger.member(member);
  ledger.event({ event: 0x8002, hwnd: '88', pid: 21, at: f.members[1].createdAt + 1, visible: true, consoleWindow: false });
  assert.equal(flashes.length, 1, '计数待确认不能延迟或隐藏已知成员的首次闪窗');
  now = 1010; f.sampler.sample();
  assert.deepEqual(f.gaps, []); assert.deepEqual(f.opened, [10, 21, 22]);
  assert.deepEqual(f.members.map(value => value.pid), [10, 21, 22], '前一列表中消失的实例仍须保留身份');
  assert.equal(f.sampler.snapshot().pendingJobSamples.length, 0);
  assert.equal(f.sampler.hasPending(), false);
  assert.equal(f.sampler.snapshot().membershipTransitions[0].status, 'settled');
  assert.deepEqual(f.closed, []); f.sampler.close(); assert.deepEqual(f.closed, [110, 121, 122]);
});

test('先固定整批新成员句柄，再读取身份，避免前一个成员元数据读取使后一个实例消失', () => {
  let secondPinned = false, secondGone = false;
  const f = transitionFixture([{ assigned: 2, count: 2, ids: [10, 21] }], {}, { beforeCall: (name, args) => {
    if (name === 'GetProcessTimes' && !secondPinned) secondGone = true;
    if (name === 'OpenProcess' && args[2] === 21) {
      if (secondGone) return 0;
      secondPinned = true;
    }
  } });
  f.sampler.sample(); f.sampler.close();
  assert.deepEqual(f.gaps, []);
  assert.deepEqual(f.members.map(value => value.pid), [10, 21]);
  assert.deepEqual(f.closed, [110, 121]);
  assert.deepEqual(f.calls.slice(f.calls.indexOf('OpenProcess'), f.calls.indexOf('OpenProcess') + 3),
    ['OpenProcess', 'OpenProcess', 'IsProcessInJob']);
});

test('计数变化保留查询次数、单次查询耗时及查询间隔，迟到失败也不丢诊断', t => {
  let now = 1000; t.mock.method(performance, 'now', () => now);
  const f = transitionFixture([{ assigned: 2, count: 1, ids: [10] }, { assigned: 1, count: 1, ids: [10] }], {},
    { beforeCall: (name, args) => { if (name === 'QueryInformationJobObject' && args[1] === 3) now += 2; } });
  f.sampler.sample(); now = 1010; f.sampler.sample();
  assert.deepEqual(f.gaps, []);
  const settled = f.sampler.snapshot().membershipTransitions[0];
  assert.equal(settled.queryCount, 2); assert.equal(settled.maxQueryMs, 2); assert.equal(settled.maxBetweenQueriesMs, 8);
  f.sampler.close();
  now = 2000;
  const late = transitionFixture([{ assigned: 2, count: 1, ids: [10] }, { assigned: 1, count: 1, ids: [10] }], {},
    { beforeCall: (name, args) => { if (name === 'QueryInformationJobObject' && args[1] === 3) now += 3; } });
  late.sampler.sample(); now = 2025; late.sampler.sample();
  const failed = late.sampler.snapshot().membershipTransitions[0];
  assert.equal(failed.status, 'failed'); assert.equal(failed.queryCount, 2);
  assert.equal(failed.maxQueryMs, 3); assert.equal(failed.maxBetweenQueriesMs, 22);
  assert.equal(late.gaps[0].reason, 'JOB_MEMBERS_INCOMPLETE'); late.sampler.close();
  now = 3000;
  const queryFailure = transitionFixture([{ assigned: 2, count: 1, ids: [10] }, { ok: false, assigned: 0, count: 0, ids: [] }]);
  queryFailure.sampler.sample(); now = 3005; queryFailure.sampler.sample();
  assert.equal(queryFailure.sampler.snapshot().membershipTransitions[0].queryCount, 2);
  assert.equal(queryFailure.gaps[0].reason, 'JOB_MEMBERS_INCOMPLETE'); queryFailure.sampler.close();
});

test('整批固定后身份仍严格验证，任何归属失败不发布成员并释放全部实例', () => {
  const f = transitionFixture([{ assigned: 2, count: 2, ids: [10, 21] }], {}, { fail: 'IsProcessInJob' });
  f.sampler.sample(); f.sampler.close();
  assert.equal(f.gaps[0]?.reason, 'MEMBER_IDENTITY_UNCONFIRMED');
  assert.equal(f.gaps[0]?.details.operation, 'IsProcessInJob');
  assert.deepEqual(f.members, []); assert.equal(f.calls.includes('GetProcessTimes'), false);
  assert.deepEqual(f.opened, [10, 21]); assert.deepEqual(f.closed, [110, 121]);
});

test('只对WinEvent明确报告的稳定存活实例证明在外层Job外，不读取映像或父进程', t => {
  t.mock.method(Date, 'now', () => 900);
  const window = { hwnd: '88', instance: 0, pid: 31, at: 1000, eventThread: 7, windowThread: 7, consoleWindow: false };
  const f = transitionFixture([{ assigned: 0, count: 0, ids: [] }], {}, { outside: true });
  const proof = f.sampler.outsideProof(window);
  assert.equal(proof.rootPid, 10); assert.equal(proof.pid, 31); assert.equal(proof.created, '116444736000000000');
  assert.deepEqual(f.opened, [31]); assert.deepEqual(f.closed, [7007, 131]);
  assert.equal(proof.threadCreated, '116444736000000000');
  assert.equal(f.calls.includes('QueryFullProcessImageNameW'), false); assert.equal(f.calls.includes('NtQueryInformationProcess'), false);
  f.sampler.close(); assert.deepEqual(f.gaps, []);
  assert.equal(f.sampler.outsideProof(window), undefined, '外层Job关闭后不能拿新Job的否定结果排除旧事件');
  f.sampler.assigned(1, 20);
  assert.equal(f.sampler.outsideProof(window), undefined, 'Job句柄值复用不能恢复已关闭anchor的资格');
  f.sampler.close();
});

test('自有成员、保护PID、窗口复用、过早事件、退出或原生失败均不能排除窗口', t => {
  t.mock.method(Date, 'now', () => 900);
  const window = { hwnd: '88', instance: 0, pid: 31, at: 1000, eventThread: 7, windowThread: 7, consoleWindow: false };
  const cases = [
    [{ outside: false }, {}, {}], [{ outside: true }, { protectedPids: [31] }, {}],
    [{ outside: true, windowPid: 32 }, {}, {}], [{ outside: true, windowThread: 8 }, {}, {}],
    [{ outside: true }, {}, { eventThread: 8 }], [{ outside: true }, {}, { at: 899 }],
    [{ outside: true }, {}, { consoleWindow: true }], [{ outside: true, wait: 0 }, {}, {}],
    [{ outside: true, fail: 'IsProcessInJob' }, {}, {}], [{ outside: true, fail: 'GetProcessTimes' }, {}, {}],
    [{ outside: true, fail: 'OpenProcess' }, {}, {}], [{ outside: true, fail: 'CloseHandle' }, {}, {}],
    [{ outside: true, createdAt: 1001 }, {}, {}], [{ outside: true, waits: [258, 0] }, {}, {}],
    [{ outside: true, windowPairs: [[31, 7], [32, 7]] }, {}, {}],
    [{ outside: true, createdAt: 950 }, {}, {}], [{ outside: true, threadCreatedAt: 1001 }, {}, {}],
    [{ outside: true, threadPid: 32 }, {}, {}], [{ outside: true, threadWait: 0 }, {}, {}],
    [{ outside: true, fail: 'OpenThread' }, {}, {}], [{ outside: true, fail: 'GetThreadTimes' }, {}, {}],
    [{ outside: true, fail: 'GetProcessIdOfThread' }, {}, {}], [{ outside: true, closeHandles: [7007] }, {}, {}],
  ];
  for (const [faults, options, change] of cases) {
    const f = transitionFixture([{ assigned: 0, count: 0, ids: [] }], options, faults);
    assert.equal(f.sampler.outsideProof({ ...window, ...change }), undefined);
    if (options.protectedPids) assert.deepEqual(f.opened, [], '历史UNKNOWN及宿主PID不可打开');
    if (f.opened.length && faults.fail !== 'OpenProcess') assert.ok(f.calls.includes('CloseHandle'));
    assert.equal(f.calls.includes('QueryFullProcessImageNameW'), false); f.sampler.close();
  }
});

test('属于其他当前自有Job的窗口不能按首Job的否定结果排除', t => {
  t.mock.method(Date, 'now', () => 900);
  const f = transitionFixture([{ assigned: 0, count: 0, ids: [] }], {}, { outside: true, insideJob: 2 });
  f.sampler.assigned(2, 20);
  assert.equal(f.sampler.outsideProof({ hwnd: '88', instance: 0, pid: 31, at: 1000,
    eventThread: 7, windowThread: 7, consoleWindow: false }), undefined);
  f.sampler.close();
});

test('首Job关闭后原生句柄值复用不能重启外部证明', t => {
  t.mock.method(Date, 'now', () => 900);
  const f = transitionFixture([{ assigned: 0, count: 0, ids: [] }], {}, { outside: true });
  f.sampler.closing(1); f.sampler.assigned(1, 20);
  assert.equal(f.sampler.outsideProof({ hwnd: '88', instance: 0, pid: 31, at: 1000,
    eventThread: 7, windowThread: 7, consoleWindow: false }), undefined);
  f.sampler.close();
});

test('数字相同但在事件后创建的线程实例不能证明旧窗口在Job外', t => {
  t.mock.method(Date, 'now', () => 900);
  const f = transitionFixture([{ assigned: 0, count: 0, ids: [] }], {}, { outside: true, threadCreatedAt: 1001 });
  assert.equal(f.sampler.outsideProof({ hwnd: '88', instance: 0, pid: 31, at: 1000,
    eventThread: 7, windowThread: 7, consoleWindow: false }), undefined);
  f.sampler.close();
});

test('受保护PID即使意外出现在Job列表中也不得打开', () => {
  const f = transitionFixture([{ assigned: 1, count: 1, ids: [31] }], { protectedPids: [31] });
  f.sampler.sample(); f.sampler.close();
  assert.deepEqual(f.opened, []); assert.equal(f.gaps[0]?.reason, 'PROTECTED_JOB_MEMBER');
});

test('仅显式批准的保护号码可用本轮创建时间及同一固定句柄的Job归属确认新实例', t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = transitionFixture([{ assigned: 1, count: 1, ids: [31] }], { protectedPids: [31], reusableProtectedPids: [31] }, { createdAt: 1050 });
  f.sampler.assigned(1, 10, 1001, true);
  now = 1100; f.sampler.sample();
  assert.deepEqual(f.gaps, []); assert.deepEqual(f.opened, [31]);
  assert.equal(f.members[0].createdAt, 1050);
  assert.deepEqual(f.sampler.snapshot().protectedPidReuses, [{ rootPid: 10, pid: 31, created: '116444736010500000', createdAt: 1050, notBefore: 1000, checkedAt: 1100, jobCreatedAt: 1001 }]);
  f.sampler.close(); assert.deepEqual(f.closed, [131]);
});

for (const createdAt of [900, 1000, 1101]) test(`旧、边界或未来的保护实例不能当作新成员：${createdAt}`, t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = transitionFixture([{ assigned: 1, count: 1, ids: [31] }], { protectedPids: [31], reusableProtectedPids: [31] }, { createdAt });
  f.sampler.assigned(1, 10, 1001, true);
  now = 1100; f.sampler.sample();
  assert.deepEqual(f.opened, [31]); assert.deepEqual(f.members, []);
  assert.equal(f.gaps[0].reason, 'PROTECTED_JOB_MEMBER');
  assert.deepEqual(f.sampler.snapshot().protectedPidReuses, []);
  f.sampler.close(); assert.deepEqual(f.closed, [131]);
});

test('复用许可不能开放窗口外部候选，Job归属失败不读取创建令牌', t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = transitionFixture([{ assigned: 1, count: 1, ids: [31] }], { protectedPids: [31], reusableProtectedPids: [31] }, { outside: true, createdAt: 1050 });
  f.sampler.assigned(1, 10, 1001, true);
  now = 1100;
  assert.equal(f.sampler.outsideProof({ pid: 31, consoleWindow: false, consolePids: [], at: 1100 }), undefined);
  assert.deepEqual(f.opened, []);
  f.sampler.sample();
  assert.equal(f.calls.includes('GetProcessTimes'), false);
  assert.equal(f.gaps[0].reason, 'MEMBER_IDENTITY_UNCONFIRMED');
  f.sampler.close(); assert.deepEqual(f.closed, [131]);
});

test('复用号码必须为保护集合的子集且不能包含当前观察进程，在原生加载前校验', () => {
  for (const reusableProtectedPids of [[32], [0], [process.pid]]) {
    const protectedPids = [31, process.pid];
    assert.throws(() => createWindowsWindowJobSampler(undefined, {}, { protectedPids, reusableProtectedPids }), RangeError);
  }
  assert.throws(() => createWindowsWindowJobSampler(undefined, {}, { protectedPids: [31], reusableProtectedPids: [31], hardProtectedPids: [31] }), RangeError);
});

test('复用许可还需实际观察本轮Job创建，不能为任意旧Job重新登记后套用', t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  for (const jobCreatedAt of [undefined, 999, 1200]) {
    const f = transitionFixture([{ assigned: 1, count: 1, ids: [31] }], { protectedPids: [31], reusableProtectedPids: [31] }, { createdAt: 1050 });
    f.sampler.assigned(1, 10, jobCreatedAt); now = 1100; f.sampler.sample();
    assert.deepEqual(f.opened, []); assert.deepEqual(f.members, []); assert.equal(f.gaps[0].reason, 'PROTECTED_JOB_MEMBER');
    f.sampler.close(); now = 1000;
  }
});

test('时间在范围内仍须订阅之后创建的来源证明，不能用同毫秒或时钟回拨掩盖旧Job', t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = transitionFixture([{ assigned: 1, count: 1, ids: [31] }], { protectedPids: [31], reusableProtectedPids: [31] }, { createdAt: 1050 });
  f.sampler.assigned(1, 10, 1000, false); now = 1100; f.sampler.sample();
  assert.deepEqual(f.opened, []); assert.equal(f.gaps[0].reason, 'PROTECTED_JOB_MEMBER'); f.sampler.close();
});

for (const mode of ['job', 'outside']) test(`sampler默认硬保护自身PID，不依赖observer预先补数组：${mode}`, () => {
  const f = transitionFixture([{ assigned: 1, count: 1, ids: [process.pid] }], {}, { windowPid: process.pid });
  if (mode === 'job') {
    f.sampler.sample(); assert.deepEqual(f.members, []); assert.equal(f.gaps[0].reason, 'PROTECTED_JOB_MEMBER');
  } else f.sampler.outsideProof({ hwnd: '88', pid: process.pid, at: Date.now(), eventThread: 7, windowThread: 7, consoleWindow: false, consolePids: [] });
  assert.deepEqual(f.opened, []);
  if (mode === 'outside') assert.deepEqual(f.calls, []);
  f.sampler.close();
});

for (const operation of ['IsProcessInJob', 'GetProcessTimes', 'OpenProcess']) test(`pending保护候选原生抛错必须锁存失败，收尾只释放句柄：${operation}`, t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const f = transitionFixture([{ assigned: 2, count: 1, ids: [31] }], { protectedPids: [31], reusableProtectedPids: [31] },
    { wait: 0, beforeCall: name => { if (name === operation) throw new Error('fixture native throw'); } });
  f.sampler.assigned(1, 10, 1001, true); now = 1100;
  assert.doesNotThrow(() => f.sampler.sample());
  const reads = f.reads(), waits = f.calls.filter(value => value === 'WaitForSingleObject').length;
  assert.deepEqual(f.members, []); assert.equal(f.gaps.length, 1);
  f.sampler.close();
  assert.equal(f.reads(), reads); assert.equal(f.calls.filter(value => value === 'WaitForSingleObject').length, waits);
  assert.deepEqual(f.members, []); assert.equal(f.closed.length, f.opened.length);
});

test('计数持续不一致、容量不足或收尾时仍待确认均不能通过', t => {
  let now = 1000; t.mock.method(performance, 'now', () => now);
  const f = transitionFixture([{ assigned: 3, count: 2, ids: [10, 21] }]);
  f.sampler.sample(); now = 1020; f.sampler.sample();
  assert.equal(f.gaps[0]?.reason, 'JOB_MEMBERS_INCOMPLETE');
  assert.equal(f.sampler.snapshot().membershipTransitions[0].status, 'failed');
  f.sampler.close(); assert.deepEqual(f.closed, [110, 121]);
  const pending = transitionFixture([{ assigned: 3, count: 2, ids: [10, 21] }]);
  pending.sampler.sample(); pending.sampler.close();
  assert.equal(pending.gaps[0]?.reason, 'JOB_MEMBERS_INCOMPLETE', '关闭不能丢弃尚未收敛的采样');
  const overflow = transitionFixture([{ assigned: 4097, count: 2, ids: [10, 21] }]);
  overflow.sampler.sample(); overflow.sampler.close();
  assert.equal(overflow.gaps[0]?.reason, 'JOB_MEMBERS_INCOMPLETE'); assert.deepEqual(overflow.opened, []);
});

test('只有期限内确认一致的最后读取才允许关闭未完成采样', t => {
  let now = 1000; t.mock.method(performance, 'now', () => now);
  const lists = [{ assigned: 3, count: 2, ids: [10, 21] }, { assigned: 1, count: 1, ids: [10] }];
  const normal = transitionFixture(lists); normal.sampler.sample(); now = 1010; normal.sampler.closing(1);
  assert.deepEqual(normal.gaps, []); assert.equal(normal.reads(), 2);
  assert.equal(normal.sampler.snapshot().membershipTransitions[0].status, 'settled');
  assert.deepEqual(normal.closed, [110, 121]);
  now = 2000;
  const late = transitionFixture(lists); late.sampler.sample(); now = 2021; late.sampler.sample(); late.sampler.close();
  assert.equal(late.gaps[0]?.reason, 'JOB_MEMBERS_INCOMPLETE');
  assert.equal(late.gaps[0].details.pendingMs, 21, '晚到的一致列表不能抹掉超出观察宽限的缺口');
});

test('待确认期间原生失败立即拒绝，计数变化证据也受原有额度约束', t => {
  let now = 1000; t.mock.method(performance, 'now', () => now);
  const failed = transitionFixture([{ assigned: 2, count: 1, ids: [10] }, { assigned: 2, count: 1, ids: [10], ok: false }]);
  failed.sampler.sample(); now = 1001; failed.sampler.sample(); failed.sampler.close();
  assert.equal(failed.gaps[0]?.reason, 'JOB_MEMBERS_INCOMPLETE'); assert.equal(failed.gaps[0].details.queryOk, false);
  assert.deepEqual(failed.opened, [10]); assert.deepEqual(failed.closed, [110]);
  const bounded = transitionFixture([{ assigned: 2, count: 1, ids: [10] }, { assigned: 1, count: 1, ids: [10] },
    { assigned: 2, count: 1, ids: [10] }], { limit: 1 });
  bounded.sampler.sample(); bounded.sampler.sample(); bounded.sampler.sample(); bounded.sampler.close();
  assert.equal(bounded.gaps[0]?.reason, 'MEMBER_TRANSITION_LIMIT');
  assert.equal(bounded.sampler.snapshot().membershipTransitions.length, 1);
});

test('最后查询或一个句柄关闭抛错，仍尝试释放全部成员及其余Job', () => {
  const query = transitionFixture([{ assigned: 3, count: 2, ids: [10, 21] }], {}, { queryReads: [1] });
  query.sampler.sample();
  assert.throws(() => query.sampler.close(), AggregateError);
  assert.deepEqual(query.closed, [110, 121], '最后查询异常也须释放此前固定的实例');
  const close = transitionFixture([{ assigned: 2, count: 2, ids: [10, 21] }], {}, { uniqueHandles: true, closeHandles: [1110] });
  close.sampler.sample(); close.sampler.assigned(2, 10); close.sampler.sample();
  assert.throws(() => close.sampler.close(), AggregateError);
  assert.deepEqual(close.closed, [1110, 2121, 3110, 4121], '单个句柄异常不能跳过本Job或后续Job');
});

test('已确认的Job和创建令牌足以关联可见窗口，不再读取受拒的映像及父进程元数据', () => {
  const f = transitionFixture([{ assigned: 1, count: 1, ids: [21] }], {}, { fail: 'QueryFullProcessImageNameW', nativeCode: 5 });
  f.sampler.sample(); f.sampler.close();
  assert.deepEqual(f.gaps, []);
  assert.deepEqual(f.members, [{ pid: 21, rootPid: 10, created: '116444736000000000', createdAt: 0 }]);
  assert.equal(f.calls.includes('QueryFullProcessImageNameW'), false);
  assert.equal(f.calls.includes('NtQueryInformationProcess'), false);
  const flashes = [], ledger = createWindowEventLedger({ onFlash: value => flashes.push(value) });
  ledger.member(f.members[0]);
  ledger.event({ event: 0x8002, hwnd: '88', pid: 21, at: 1, visible: true, consoleWindow: false });
  assert.equal(flashes.length, 1); assert.equal(flashes[0].member.pid, 21);
  assert.deepEqual(f.closed, [121]);
});

test('成员身份缺口保留具体原生步骤和返回码，未确认归属前不读取其他身份字段', () => {
  const cases = [
    [{ fail: 'OpenProcess' }, 'OpenProcess', 87, 'MEMBER_INSTANCE_MISSED'],
    [{ fail: 'IsProcessInJob' }, 'IsProcessInJob', 87],
    [{ outside: true }, 'IsProcessInJob', 0],
    [{ fail: 'GetProcessTimes' }, 'GetProcessTimes', 87],
    [{ fail: 'OpenProcess', nativeCode: 5 }, 'OpenProcess', 5, 'MEMBER_INSTANCE_MISSED'],
    [{ fail: 'IsProcessInJob', nativeCode: 5 }, 'IsProcessInJob', 5],
    [{ fail: 'GetProcessTimes', nativeCode: 5 }, 'GetProcessTimes', 5],
    [{ invalidPid: 0 }, 'process-id', undefined],
  ];
  for (const [faults, operation, nativeCode, reason = 'MEMBER_IDENTITY_UNCONFIRMED'] of cases) {
    const f = transitionFixture([{ assigned: 1, count: 1, ids: [faults.invalidPid ?? 10] }], {}, faults);
    f.sampler.sample(); f.sampler.close();
    assert.equal(f.gaps[0]?.reason, reason);
    assert.equal(f.gaps[0]?.details?.operation, operation);
    assert.equal(f.gaps[0]?.details?.nativeCode, nativeCode);
    assert.equal(f.gaps[0]?.details?.pid, faults.invalidPid ?? 10);
    assert.equal(f.members.length, 0);
    if (operation === 'IsProcessInJob') assert.equal(f.calls.includes('GetProcessTimes'), false);
    assert.doesNotMatch(JSON.stringify(f.gaps), /private/u);
  }
});
