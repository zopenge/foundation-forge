import { performance } from 'node:perf_hooks';
import process from 'node:process';

// 只读现有Job；活动实例保持句柄，已证明退出的实例保留历史并撤销新窗口归属资格。
export const createWindowsWindowJobSampler = (native, sink, { limit = 512, protectedPids = [], reusableProtectedPids = [], hardProtectedPids = [] } = {}) => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32768) throw new RangeError('WINDOW_MEMBER_LIMIT');
  if (!Array.isArray(protectedPids) || protectedPids.length > 64
    || protectedPids.some(pid => !Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff)) throw new RangeError('WINDOW_PROTECTED_PIDS');
  const protectedIds = new Set(protectedPids);
  if (!Array.isArray(hardProtectedPids) || hardProtectedPids.length > 64 || hardProtectedPids.some(pid => !protectedIds.has(pid))) throw new RangeError('WINDOW_HARD_PROTECTED_PIDS');
  const hardProtectedIds = new Set([process.pid, ...hardProtectedPids]);
  for (const pid of hardProtectedIds) protectedIds.add(pid);
  if (!Array.isArray(reusableProtectedPids) || reusableProtectedPids.length > 64
    || reusableProtectedPids.some(pid => !protectedIds.has(pid) || hardProtectedIds.has(pid))
    || new Set(reusableProtectedPids).size !== reusableProtectedPids.length) throw new RangeError('WINDOW_PROTECTED_PID_REUSE');
  const reusableIds = new Set(reusableProtectedPids), protectedSince = Date.now();
  const kernel = native.load('kernel32.dll'), jobs = new Map(), transitions = [], protectedPidReuses = [];
  let anchor, heldHandles = 0, peakHandles = 0, retiredInstances = 0, reobserved = 0;
  const listType = native.struct({ assigned: 'uint32_t', count: 'uint32_t', ids: native.array('uintptr_t', 4096) });
  const accountingType = native.struct({ userTime: 'int64_t', kernelTime: 'int64_t', periodUser: 'int64_t', periodKernel: 'int64_t',
    faults: 'uint32_t', total: 'uint32_t', active: 'uint32_t', terminated: 'uint32_t' });
  const timeType = native.struct({ low: 'uint32_t', high: 'uint32_t' });
  if (native.sizeof('void *') !== 8 || native.sizeof(listType) !== 32776 || native.sizeof(accountingType) !== 48)
    throw new Error('WINDOW_OBSERVER_ABI');
  const query = kernel.func('__stdcall', 'QueryInformationJobObject', 'int32_t', ['void *', 'int', native.out(native.pointer(listType)), 'uint32_t', 'void *']);
  const accounting = kernel.func('__stdcall', 'QueryInformationJobObject', 'int32_t', ['void *', 'int', native.out(native.pointer(accountingType)), 'uint32_t', 'void *']);
  const lastError = kernel.func('__stdcall', 'GetLastError', 'uint32_t', []);
  const open = kernel.func('__stdcall', 'OpenProcess', 'void *', ['uint32_t', 'int32_t', 'uint32_t']);
  const belongs = kernel.func('__stdcall', 'IsProcessInJob', 'int32_t', ['void *', 'void *', native.out(native.pointer('int32_t'))]);
  const times = kernel.func('__stdcall', 'GetProcessTimes', 'int32_t', ['void *', ...Array(4).fill(native.out(native.pointer(timeType)))]);
  const close = kernel.func('__stdcall', 'CloseHandle', 'int32_t', ['void *']);
  const wait = kernel.func('__stdcall', 'WaitForSingleObject', 'uint32_t', ['void *', 'uint32_t']);
  const openThread = kernel.func('__stdcall', 'OpenThread', 'void *', ['uint32_t', 'int32_t', 'uint32_t']);
  const threadProcess = kernel.func('__stdcall', 'GetProcessIdOfThread', 'uint32_t', ['void *']);
  const threadTimes = kernel.func('__stdcall', 'GetThreadTimes', 'int32_t', ['void *', ...Array(4).fill(native.out(native.pointer(timeType)))]);
  const windowPid = native.load('user32.dll').func('__stdcall', 'GetWindowThreadProcessId', 'uint32_t', ['void *', native.out(native.pointer('uint32_t'))]);
  const outsideProof = window => {
    const root = anchor && jobs.get(anchor.job);
    if (!root || anchor.closed || anchor.value !== root || !Number.isSafeInteger(root.rootPid) || root.failed || root.pending
      || window.consoleWindow !== false || window.consolePids?.length || protectedIds.has(window.pid)
      || !Number.isSafeInteger(window.pid) || window.pid < 1 || window.pid > 0xffffffff
      || !Number.isFinite(window.at) || window.at < anchor.at
      || !Number.isSafeInteger(window.eventThread) || window.eventThread < 1 || window.eventThread > 0xffffffff
      || window.eventThread !== window.windowThread || !/^[1-9]\d{0,19}$/u.test(window.hwnd ?? '')) return;
    const hwnd = BigInt(window.hwnd); if (hwnd > 0xffffffffffffffffn) return;
    const sameWindow = () => {
      const pid = [0]; return Number(windowPid(hwnd, pid)) === window.eventThread && pid[0] === window.pid;
    };
    if (!sameWindow()) return;
    const handle = open(0x101000, 0, window.pid); if (!handle) return;
    let proof, threadHandle, released = true;
    try {
      const created = { low: 0, high: 0 };
      // 只读该事件实例的生命周期及Job谓词，不读取外部映像、父进程或窗口内容。
      if (Number(wait(handle, 0)) !== 258) return;
      for (const [job, value] of jobs) {
        const member = [0];
        if (value.failed || value.pending || !belongs(handle, job, member) || member[0] !== 0) return;
      }
      if (!times(handle, created, {}, {}, {})) return;
      const token = (BigInt(created.high) << 32n) + BigInt(created.low);
      const createdAt = Number((token - 116444736000000000n) / 10000n);
      if (createdAt >= anchor.at || createdAt > window.at) return;
      threadHandle = openThread(0x100800, 0, window.eventThread); if (!threadHandle) return;
      const threadCreated = { low: 0, high: 0 };
      if (Number(wait(threadHandle, 0)) !== 258 || Number(threadProcess(threadHandle)) !== window.pid
        || !threadTimes(threadHandle, threadCreated, {}, {}, {})) return;
      const threadToken = (BigInt(threadCreated.high) << 32n) + BigInt(threadCreated.low);
      if (Number((threadToken - 116444736000000000n) / 10000n) > window.at
        || !sameWindow() || Number(wait(handle, 0)) !== 258 || Number(wait(threadHandle, 0)) !== 258) return;
      proof = { instance: window.instance, hwnd: window.hwnd, pid: window.pid, at: window.at,
        created: String(token), eventThread: window.eventThread, threadCreated: String(threadToken), rootPid: root.rootPid, checkedAt: Date.now() };
    } catch { sink.gap('WINDOW_OWNER_QUERY_FAILED', { pid: window.pid }); }
    finally {
      for (const value of [threadHandle, handle].filter(Boolean)) {
        try { if (!close(value)) released = false; } catch { released = false; }
      }
      if (!released) sink.gap('WINDOW_OWNER_HANDLE_CLOSE_FAILED', { pid: window.pid });
    }
    return released ? proof : undefined;
  };
  const rejectSample = (value, reason, details) => {
    value.failed = true;
    if (value.pending) {
      value.pending.record.status = 'failed';
      value.pending.record.elapsedMs = performance.now() - value.pending.since;
      if (details) value.pending.record.latest = details;
    }
    sink.gap(reason, details);
  };
  const readTotal = (job, value, stage) => {
    const result = { userTime: 0, kernelTime: 0, periodUser: 0, periodKernel: 0, faults: 0, total: 0, active: 0, terminated: 0 };
    let ok;
    try { ok = Boolean(accounting(job, 1, result, native.sizeof(accountingType), null)); }
    catch (error) {
      rejectSample(value, 'JOB_ACCOUNTING_UNCONFIRMED', { rootPid: value.rootPid, stage,
        nativeException: String(error?.message ?? error).slice(0, 160) }); return;
    }
    const nativeCode = ok ? 0 : Number(lastError());
    if (!ok || !Number.isSafeInteger(result.total) || result.total < value.confirmed || result.total > 0xffffffff
      || (value.lastTotal !== undefined && result.total < value.lastTotal)) {
      rejectSample(value, 'JOB_ACCOUNTING_UNCONFIRMED', { rootPid: value.rootPid, stage, queryOk: ok, nativeCode,
        total: result.total, previousTotal: value.lastTotal, confirmed: value.confirmed }); return;
    }
    value.lastTotal = result.total; return result.total;
  };
  const closeMember = (value, pid, handle) => {
    let closed = false;
    try { closed = Boolean(close(handle)); } catch { /* 先锁存失败，收尾不能重启pending采样。 */ }
    if (!closed) rejectSample(value, 'MEMBER_HANDLE_CLOSE_FAILED', { rootPid: value.rootPid, pid });
    return closed;
  };
  const sampleJob = (job, value) => {
    if (value.failed) return;
    for (const [pid, handle] of value.handles) {
      let state;
      try { state = Number(wait(handle, 0)); }
      catch { rejectSample(value, 'MEMBER_IDENTITY_UNCONFIRMED', { rootPid: value.rootPid, pid, operation: 'WaitForSingleObject' }); return; }
      if (state === 258) continue;
      if (state !== 0) {
        rejectSample(value, 'MEMBER_IDENTITY_UNCONFIRMED', { rootPid: value.rootPid, pid, operation: 'WaitForSingleObject', nativeCode: Number(lastError()) }); return;
      }
      try { sink.member({ ...value.identities.get(pid), retired: true }); }
      catch { rejectSample(value, 'MEMBER_IDENTITY_UNCONFIRMED', { rootPid: value.rootPid, pid, operation: 'member-retirement' }); return; }
      if (!closeMember(value, pid, handle)) return;
      heldHandles--; retiredInstances++;
      value.handles.delete(pid); value.identities.delete(pid);
    }
    const beforeTotal = readTotal(job, value, 'before'); if (value.failed) return;
    const list = { assigned: 0, count: 0, ids: Array(4096).fill(0n) };
    const queryStarted = performance.now();
    const queryOk = Boolean(query(job, 3, list, native.sizeof(listType), null));
    const nativeCode = queryOk ? 0 : Number(lastError());
    const details = { rootPid: value.rootPid, queryOk, assigned: list.assigned, count: list.count, capacity: 4096, nativeCode };
    const now = performance.now();
    if (value.pending) {
      const pending = value.pending;
      pending.record.queryCount++;
      pending.record.maxQueryMs = Math.max(pending.record.maxQueryMs, now - queryStarted);
      pending.record.maxBetweenQueriesMs = Math.max(pending.record.maxBetweenQueriesMs, queryStarted - pending.lastQueryAt);
      pending.lastQueryAt = now;
    }
    if (!queryOk || !Number.isSafeInteger(list.count) || !Number.isSafeInteger(list.assigned)
      || list.count < 0 || list.assigned < 0 || list.count > 4096 || list.assigned > 4096 || list.count > list.assigned) {
      rejectSample(value, 'JOB_MEMBERS_INCOMPLETE', details); return;
    }
    const ids = Array.from(list.ids.slice(0, list.count), Number);
    if (ids.length !== list.count || new Set(ids).size !== list.count) {
      rejectSample(value, 'JOB_MEMBERS_INCOMPLETE', { ...details, operation: 'unique-process-ids' }); return;
    }
    if (value.pending && now - value.pending.since >= 20) {
      rejectSample(value, 'JOB_MEMBERS_INCOMPLETE', { ...details, pendingMs: now - value.pending.since }); return;
    }
    if (list.count !== list.assigned && !value.pending) {
      if (transitions.length >= limit) { rejectSample(value, 'MEMBER_TRANSITION_LIMIT', details); return; }
      const record = { rootPid: value.rootPid, startedAt: new Date().toISOString(), first: details, latest: details, elapsedMs: 0,
        queryCount: 1, maxQueryMs: now - queryStarted, maxBetweenQueriesMs: 0, status: 'pending' };
      transitions.push(record); value.pending = { since: now, lastQueryAt: now, record };
    }
    if (value.pending) {
      value.pending.record.latest = details; value.pending.record.elapsedMs = now - value.pending.since;
    }
    // 先固定整批新实例，再读取归属及创建令牌，缩短列表返回到最后一个OpenProcess之间的窗口。
    const pinned = [], candidateCount = ids.filter(pid => !value.handles.has(pid)).length;
    let reservedNewPids = 0;
    for (const pid of ids) {
      if (value.handles.has(pid)) continue;
      if (protectedIds.has(pid) && (!reusableIds.has(pid) || value.jobCreatedAfterSubscription !== true || !Number.isFinite(value.jobCreatedAt)
        || value.jobCreatedAt < protectedSince || value.jobCreatedAt > Date.now())) {
        rejectSample(value, 'PROTECTED_JOB_MEMBER', { rootPid: value.rootPid, pid }); break;
      }
      if (value.confirmed + reservedNewPids >= limit && !value.seenPids.has(pid)) { rejectSample(value, 'MEMBER_LIMIT'); break; }
      if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff) {
        rejectSample(value, 'MEMBER_IDENTITY_UNCONFIRMED', { rootPid: value.rootPid, pid, operation: 'process-id' }); break;
      }
      const handle = open(0x101000, 0, pid);
      if (!handle) {
        const nativeCode = Number(lastError());
        rejectSample(value, 'MEMBER_INSTANCE_MISSED', { rootPid: value.rootPid, pid, operation: 'OpenProcess', nativeCode,
          candidateCount, pinnedBeforeFailure: pinned.length, queryElapsedMs: performance.now() - queryStarted }); break;
      }
      value.handles.set(pid, handle);
      if (!value.seenPids.has(pid)) reservedNewPids++;
      heldHandles++; peakHandles = Math.max(peakHandles, heldHandles);
      pinned.push({ pid, handle });
    }
    if (value.failed) return;
    // 未验证的固定句柄不发布为成员；任何必要身份失败仍立即停止，全部句柄由原收尾路径释放。
    for (const { pid, handle } of pinned) {
      const member = [0], created = { low: 0, high: 0 };
      const failedIdentity = (operation, nativeCode, details) => rejectSample(value, 'MEMBER_IDENTITY_UNCONFIRMED',
        { rootPid: value.rootPid, pid, operation, nativeCode, ...details });
      let inJob;
      try { inJob = Boolean(belongs(handle, job, member)); }
      catch { failedIdentity('IsProcessInJob', undefined, { nativeException: true }); break; }
      if (!inJob || member[0] !== 1) {
        failedIdentity('IsProcessInJob', inJob ? 0 : Number(lastError()), { inJob: member[0] }); break;
      }
      let readTimes;
      try { readTimes = Boolean(times(handle, created, {}, {}, {})); }
      catch { failedIdentity('GetProcessTimes', undefined, { nativeException: true }); break; }
      if (!readTimes) { failedIdentity('GetProcessTimes', Number(lastError())); break; }
      const token = (BigInt(created.high) << 32n) + BigInt(created.low);
      const identity = { pid, rootPid: value.rootPid, created: String(token), createdAt: Number((token - 116444736000000000n) / 10000n) };
      // 仅显式获准的同号成员可走此分支；固定句柄归属已证实，旧/未来实例仍禁止发布。
      const reuseCheckedAt = protectedIds.has(pid) ? Date.now() : undefined;
      if (reuseCheckedAt !== undefined && (identity.createdAt <= protectedSince || identity.createdAt > reuseCheckedAt)) {
        rejectSample(value, 'PROTECTED_JOB_MEMBER', { rootPid: value.rootPid, pid, createdAt: identity.createdAt,
          notBefore: protectedSince, checkedAt: reuseCheckedAt }); break;
      }
      const key = `${pid}:${token}`;
      if (value.seen.has(key)) {
        // 其他引用可能让退出实例暂留在列表；只在再次证明其已退出后释放，不重复累计。
        let state;
        try { state = Number(wait(handle, 0)); }
        catch { failedIdentity('retired-instance-state'); break; }
        if (state !== 0) { failedIdentity('retired-instance-state'); break; }
        if (!closeMember(value, pid, handle)) break;
        heldHandles--; reobserved++;
        value.handles.delete(pid); continue;
      }
      if (value.confirmed >= limit) { rejectSample(value, 'MEMBER_LIMIT'); break; }
      if (reuseCheckedAt !== undefined && protectedPidReuses.length >= limit) { rejectSample(value, 'PROTECTED_REUSE_LIMIT'); break; }
      // 窗口归属只依赖已固定的Job/PID/创建令牌；不读取无关的映像或父进程元数据。
      try { sink.member(identity); }
      catch { failedIdentity('member-publication'); break; }
      value.identities.set(pid, identity); value.seen.add(key); value.seenPids.add(pid);
      value.confirmed++;
      if (reuseCheckedAt !== undefined) protectedPidReuses.push({ ...identity, notBefore: protectedSince, checkedAt: reuseCheckedAt, jobCreatedAt: value.jobCreatedAt });
    }
    if (value.failed) return;
    // 必须在整批身份发布后读累计量；未确认句柄不能靠数字相等冒充已确认实例。
    if (value.identities.size !== value.handles.size) {
      rejectSample(value, 'MEMBER_IDENTITY_UNCONFIRMED', { rootPid: value.rootPid, operation: 'confirmed-instance-count' }); return;
    }
    const total = readTotal(job, value, 'after'); if (value.failed) return;
    const completedAt = performance.now();
    if (value.pending && completedAt - value.pending.since >= 20) {
      rejectSample(value, 'JOB_MEMBERS_INCOMPLETE', { ...details, pendingMs: completedAt - value.pending.since }); return;
    }
    const baseline = value.baseline;
    const covered = baseline && total - baseline.total === value.confirmed - baseline.confirmed;
    if (value.pending && (list.count === list.assigned || covered)) {
      const record = value.pending.record;
      record.elapsedMs = completedAt - value.pending.since; record.status = 'settled';
      record.resolution = list.count === list.assigned ? 'pid-list' : 'instance-delta';
      if (record.resolution === 'instance-delta') {
        record.basis = { ...baseline };
        record.coverage = { baselineTotal: baseline.total, baselineConfirmed: baseline.confirmed,
          total, confirmed: value.confirmed, added: total - baseline.total };
      }
      value.pending = undefined;
    }
    // 稳定的完整列表建立基线；已证明的新增覆盖可推进同一Job注册实例的完整性链。
    if ((list.count === list.assigned && beforeTotal === total) || (list.count !== list.assigned && covered)) {
      value.baseline = { total, confirmed: value.confirmed, beforeTotal, assigned: list.assigned, count: list.count,
        resolution: list.count === list.assigned ? 'pid-list' : 'instance-delta' };
    }
  };
  const closeJob = job => {
    const value = jobs.get(job); if (!value) return;
    if (anchor?.value === value) anchor.closed = true;
    const errors = [];
    // CloseHandle之前还有一次有效读取机会；收尾不得遗忘未收敛的采样。
    try {
      if (value.pending && !value.failed) {
        sampleJob(job, value);
        if (value.pending && !value.failed) rejectSample(value, 'JOB_MEMBERS_INCOMPLETE', value.pending.record.latest);
      }
    } catch (error) {
      errors.push(error);
      try { rejectSample(value, 'JOB_WINDOW_SAMPLING_FAILED', { rootPid: value.rootPid }); }
      catch (notification) { errors.push(notification); }
    } finally {
      // 单个原生调用或通知失败不能跳过其他实例的释放。
      for (const handle of value.handles.values()) {
        try { if (!close(handle)) sink.gap('MEMBER_HANDLE_CLOSE_FAILED'); else heldHandles--; }
        catch (error) { errors.push(error); }
      }
      jobs.delete(job);
    }
    if (errors.length) throw new AggregateError(errors, 'WINDOW_MEMBER_CLEANUP_FAILED');
  };
  return {
    assigned: (job, rootPid, jobCreatedAt, jobCreatedAfterSubscription) => {
      const value = { rootPid, jobCreatedAt, jobCreatedAfterSubscription, handles: new Map(), identities: new Map(), seen: new Set(), seenPids: new Set(), confirmed: 0, failed: false };
      jobs.set(job, value);
      anchor ??= { job, value, at: Date.now(), closed: false };
    },
    outsideProof,
    closing: closeJob,
    sample: () => {
      for (const [job, value] of jobs) {
        try { sampleJob(job, value); }
        catch { rejectSample(value, 'JOB_WINDOW_SAMPLING_FAILED', { rootPid: value.rootPid, nativeException: true }); }
        if (value.failed) break;
      }
    },
    hasPending: () => {
      for (const value of jobs.values()) if (value.pending && !value.failed) return true;
      return false;
    },
    snapshot: () => ({ memberHandleSummary: { held: heldHandles, peak: peakHandles, retired: retiredInstances, reobserved },
      protectedPidReuses: protectedPidReuses.map(value => ({ ...value })),
      pendingJobSamples: [...jobs.values()].filter(value => value.pending && !value.failed).map(value => value.rootPid),
      membershipTransitions: transitions.map(value => ({ ...value, first: { ...value.first }, latest: { ...value.latest },
        ...(value.coverage ? { coverage: { ...value.coverage }, basis: { ...value.basis } } : {}) })) }),
    close: () => {
      const errors = [];
      for (const job of jobs.keys()) { try { closeJob(job); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, 'WINDOW_MEMBER_CLEANUP_FAILED');
    },
  };
};
