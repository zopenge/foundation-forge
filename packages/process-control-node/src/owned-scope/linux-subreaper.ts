import { readFile } from 'node:fs/promises';
import { ProcessControlError, processControlErrorCodes, type ProcessIdentity, type ReadProcessIdentityRequest } from '@openge/forge-process-control';
import { createPosixProcessIdentityReader } from '../provider.js';
import type { ScopeBackend } from './backend.js';
import { loadLinuxScopeNative } from './linux-native.js';
import type { SupervisorPort } from './supervisor.js';

async function startTicks(pid: number): Promise<string> {
  const text = await readFile(`/proc/${String(pid)}/stat`, 'utf8');
  const value = text.slice(text.lastIndexOf(')') + 2).split(' ')[19];
  if (text.length > 65_536 || value === undefined || !/^\d+$/u.test(value)) throw Error('ROOT_STAT');
  return value;
}
const defaultIo = { load: loadLinuxScopeNative, ticks: startTicks, readIdentity: (request: ReadProcessIdentityRequest) => createPosixProcessIdentityReader().readIdentity(request) };
export async function createLinuxSubreaper(port: SupervisorPort, io = defaultIo): Promise<ScopeBackend> {
  const native = await io.load();
  let fd: number | undefined, actual: ProcessIdentity | undefined, provenEmpty = false, rootExited = false;
  return {
    attach: async pid => {
      if (fd !== undefined) throw Error('ATTACH_STATE');
      // spawn 返回后先同步固定实例；未验证的 fd 只可关闭，不能接收终止信号。
      const handle = native.open(pid);
      if (handle.fd < 0) throw Error('ROOT_PIDFD');
      try {
        port.assertRootInstance(pid);
        const before = await io.ticks(pid), observed = await io.readIdentity({ pid, signal: port.startupSignal });
        if (observed.status !== 'FOUND' || before !== await io.ticks(pid) || !native.signal(handle.fd, 0).ok) throw Error('ROOT_INSTANCE');
        port.assertRootInstance(pid); actual = observed.identity; fd = handle.fd;
      } catch (error) { native.close(handle.fd); throw error; }
    },
    bind: async identity => {
      if (!actual || fd === undefined || identity.pid !== actual.pid || identity.startToken !== actual.startToken || !native.signal(fd, 0).ok) {
        throw new ProcessControlError(processControlErrorCodes.scopeBinding, { reason: 'ROOT_IDENTITY' });
      }
    },
    empty: async exited => {
      if (exited) { rootExited = true; return provenEmpty; }
      const result = await port.rpc('inspect'); provenEmpty = result.empty === true; return provenEmpty;
    },
    force: async () => {
      if (rootExited) return;
      try {
        const result = await port.rpc('stop'); provenEmpty = result.empty === true;
        if (!provenEmpty) throw Error('CHILDREN_UNKNOWN');
        await port.rpc('finish');
      } catch (error) {
        // IPC 失效时请求自有 helper 收尾；不能用宿主进程差集代替后代归属。
        if (fd !== undefined) native.signal(fd, 15);
        throw error;
      }
    },
    dispose: async () => {
      if (fd !== undefined) {
        try { if (!rootExited) native.signal(fd, 9); } finally { native.close(fd); fd = undefined; }
      }
    },
  };
}

export async function createLinuxReaper(directClosed: () => boolean, timeoutMs: number) {
  const native = await loadLinuxScopeNative(); native.establish();
  const empty = () => {
    if (!directClosed()) return false;
    for (let attempts = 0; attempts < 4096; attempts++) {
      const result = native.reap();
      if (result.pid > 0 || (result.pid < 0 && result.errno === 4)) continue;
      if (result.pid === 0) return false;
      if (result.errno === 10) return true;
      throw Error('WAIT_UNKNOWN');
    }
    throw Error('REAP_LIMIT');
  };
  return {
    empty,
    async stop(): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      do {
        if (empty()) return true;
        const text = await readFile(`/proc/self/task/${String(process.pid)}/children`, 'utf8');
        if (text.length > 65_536) throw Error('CHILDREN_LIMIT');
        const children = text.trim() ? text.trim().split(/\s+/u) : [];
        if (children.length > 4096 || children.some(value => !/^[1-9]\d*$/u.test(value))) throw Error('CHILDREN_INVALID');
        for (const value of children) {
          const pid = Number(value), opened = native.open(pid);
          if (opened.fd < 0) { if (opened.errno === 3) continue; throw Error('CHILD_PIDFD'); }
          try {
            let status: string;
            try { status = await readFile(`/proc/${value}/status`, 'utf8'); }
            catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue; throw error; }
            if (status.length > 65_536 || /^PPid:\s+(\d+)$/mu.exec(status)?.[1] !== String(process.pid)) continue;
            const sent = native.signal(opened.fd, 9);
            if (!sent.ok && sent.errno !== 3) throw Error('CHILD_SIGNAL');
          } finally { native.close(opened.fd); }
        }
        await new Promise(accept => setTimeout(accept, 10));
      } while (Date.now() < deadline);
      return empty();
    },
  };
}
