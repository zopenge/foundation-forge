import { ProcessControlError, processControlErrorCodes } from '@openge/forge-process-control';
import { loadOwnedNative } from './native-loader.js';

/** 只调用 glibc 已导出的接口，不猜测 syscall 编号，也不在维护者进程设置 subreaper。 */
export async function loadLinuxScopeNative() {
  try {
    const k = await loadOwnedNative('linux'), lib = k.load('libc.so.6');
    const set = lib.func('int prctl(int option, uintptr_t value, uintptr_t arg3, uintptr_t arg4, uintptr_t arg5)');
    const get = lib.func('prctl', 'int', ['int', k.out(k.pointer('int')), 'uintptr_t', 'uintptr_t', 'uintptr_t']);
    const wait = lib.func('waitpid', 'int', ['int', k.out(k.pointer('int')), 'int']);
    const open = lib.func('int pidfd_open(int pid, unsigned int flags)');
    const signal = lib.func('int pidfd_send_signal(int fd, int signal, void *info, unsigned int flags)');
    const close = lib.func('int close(int fd)');
    const state = [0];
    if (get(37, state, 0, 0, 0) !== 0) throw Error('SUBREAPER_PROBE');
    const own = Number(open(process.pid, 0));
    if (own < 0) throw Error('PIDFD_PROBE');
    let signaled = false, closed = false;
    try { signaled = signal(own, 0, null, 0) === 0; }
    finally { closed = close(own) === 0; }
    if (!signaled || !closed) throw Error('PIDFD_SIGNAL_PROBE');
    return {
      establish() {
        const value = [0];
        if (set(36, 1, 0, 0, 0) !== 0 || get(37, value, 0, 0, 0) !== 0 || value[0] !== 1) throw Error('SUBREAPER_SETUP');
      },
      reap(): { pid: number; errno: number } { const status = [0], pid = Number(wait(-1, status, 1)); return { pid, errno: pid < 0 ? k.errno() : 0 }; },
      open(pid: number): { fd: number; errno: number } { const fd = Number(open(pid, 0)); return { fd, errno: fd < 0 ? k.errno() : 0 }; },
      signal(fd: number, value: number): { ok: boolean; errno: number } { const ok = signal(fd, value, null, 0) === 0; return { ok, errno: ok ? 0 : k.errno() }; },
      close(fd: number) { if (close(fd) !== 0) throw Error('PIDFD_CLOSE'); },
    };
  } catch {
    throw new ProcessControlError(processControlErrorCodes.scopeUnsupported, { reason: 'LINUX_GLIBC_SCOPE' });
  }
}
