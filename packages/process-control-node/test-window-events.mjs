// 仅供仓库的显式 Windows 取证入口使用，不进入公共包。
export const createWindowEventLedger = ({ onFlash = () => {}, onGap = () => {}, limit = 512 } = {}) => {
  const members = new Map(), records = new Map(), memberOrder = new Map(), windows = new Map(), history = [], gaps = new Set(), visible = new Map(), outside = new Map();
  const identityKey = value => `${value.rootPid}:${value.pid}:${value.created}`;
  let events = 0, notified = false;
  const addGap = reason => { if (!gaps.has(reason)) { gaps.add(reason); onGap(reason); } };
  const associate = window => {
    if (!window.visible) return;
    // 只查这个窗口的候选PID；按首次登记次序保持原有选择，不遍历全部成员。
    let member;
    for (const pid of [window.pid, ...window.consolePids]) {
      const candidate = members.get(pid);
      if (candidate && !candidate.retired && candidate.createdAt <= window.at
        && (!member || memberOrder.get(identityKey(candidate)) < memberOrder.get(identityKey(member)))) member = candidate;
    }
    if (!member) return;
    const captured = visible.get(window.instance);
    if (captured) { captured.window.consolePids = [...window.consolePids]; return; }
    const value = { member, window: { hwnd: window.hwnd, instance: window.instance, pid: window.pid,
      at: window.at, event: window.event, consoleWindow: window.consoleWindow, consolePids: [...window.consolePids],
      ...(window.windowClass !== undefined ? { windowClass: window.windowClass } : {}) } };
    visible.set(window.instance, value);
    if (outside.delete(window.instance)) addGap('WINDOW_OWNERSHIP_CONTRADICTED');
    if (!notified) { notified = true; onFlash(value); }
  };
  return {
    member: value => {
      const key = identityKey(value);
      if (records.get(key)?.retired && !value.retired) { addGap('MEMBER_IDENTITY_REACTIVATED'); return; }
      if (records.size >= limit && !records.has(key)) { addGap('MEMBER_OVERFLOW'); return; }
      if (!memberOrder.has(key)) memberOrder.set(key, memberOrder.size);
      records.set(key, value);
      if (value.retired && identityKey(members.get(value.pid) ?? {}) !== key) return;
      members.set(value.pid, value);
      if (value.retired) return;
      for (const window of history) associate(window);
    },
    event: value => {
      if (++events > limit) { addGap('EVENT_OVERFLOW'); return; }
      if (!value.hwnd || value.hwnd === '0') return;
      if (value.event === 0x8001) { windows.delete(value.hwnd); return; }
      if (value.event === 0x8000) windows.delete(value.hwnd);
      let window = windows.get(value.hwnd);
      if (!window) {
        window = { hwnd: value.hwnd, instance: history.length, consolePids: new Set() };
        history.push(window); windows.set(value.hwnd, window);
      }
      if (value.consolePid) window.consolePids.add(value.consolePid);
      // 保留首次可见时点，随后 hide/destroy 不能抹去曾经闪窗的事实。
      if (!window.visible) Object.assign(window, { pid: value.pid, at: value.at, event: value.event,
        visible: value.visible, consoleWindow: value.consoleWindow,
        ...(typeof value.windowClass === 'string' ? { windowClass: value.windowClass.slice(0, 128) } : {}),
        ...(Number.isFinite(value.observedAt) ? { observedAt: value.observedAt } : {}),
        ...(Number.isSafeInteger(value.eventThread) ? { eventThread: value.eventThread } : {}),
        ...(Number.isSafeInteger(value.windowThread) ? { windowThread: value.windowThread } : {}),
        ...(Number.isFinite(value.eventTick) ? { eventTick: value.eventTick } : {}) });
      associate(window);
    },
    gap: addGap,
    outside: proof => {
      const window = history[proof.instance];
      if (!window?.visible || visible.has(proof.instance) || window.consoleWindow !== false
        || window.hwnd !== proof.hwnd || window.pid !== proof.pid || window.at !== proof.at) return;
      outside.set(proof.instance, { instance: proof.instance, hwnd: proof.hwnd, pid: proof.pid, at: proof.at,
        created: proof.created, eventThread: proof.eventThread, threadCreated: proof.threadCreated, rootPid: proof.rootPid, checkedAt: proof.checkedAt });
    },
    snapshot: () => ({ members: [...records.values()], visibleWindows: [...visible.values()],
      outsideJobWindows: [...outside.values()],
      unattributedWindows: history.filter(value => value.visible && !visible.has(value.instance) && !outside.has(value.instance)).map(value => ({
        hwnd: value.hwnd, instance: value.instance, pid: value.pid, at: value.at, event: value.event, consoleWindow: value.consoleWindow,
        ...(value.windowClass !== undefined ? { windowClass: value.windowClass } : {}),
        ...(value.observedAt !== undefined ? { observedAt: value.observedAt } : {}),
        ...(value.eventThread !== undefined ? { eventThread: value.eventThread } : {}),
        ...(value.windowThread !== undefined ? { windowThread: value.windowThread } : {}),
        ...(value.eventTick !== undefined ? { eventTick: value.eventTick } : {}), consolePids: [...value.consolePids],
      })),
      gaps: [...new Set([...gaps, ...history.filter(value => value.visible && !visible.has(value.instance) && !outside.has(value.instance))
        .map(value => value.consoleWindow ? 'UNATTRIBUTED_VISIBLE_CONSOLE' : 'UNATTRIBUTED_VISIBLE_WINDOW')])] }),
  };
};
