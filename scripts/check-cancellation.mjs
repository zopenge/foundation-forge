import { existsSync, mkdirSync, mkdtempSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const controlKey = 'FORGE_CHECK_CANCEL_FILE';

// 仅供 check 链共用的文件取消门闩；不创建进程、不替代 Job，也不处理强杀父进程。
export const openCheckCancellation = ({
  env = process.env, events = process,
  io = { existsSync, mkdirSync, mkdtempSync, unwatchFile, watchFile, writeFileSync },
} = {}) => {
  const parent = resolve(repositoryRoot, '.tmp/check-controls');
  const inherited = env[controlKey];
  if (!inherited) io.mkdirSync(parent, { recursive: true });
  const path = inherited ?? resolve(io.mkdtempSync(resolve(parent, 'run-')), 'cancel');
  const contained = relative(resolve(repositoryRoot, '.tmp'), resolve(path));
  if (!isAbsolute(path) || !contained || contained.startsWith('..') || isAbsolute(contained)) throw new Error('check cancellation file escaped its owned directory');
  const controller = new globalThis.AbortController();
  const reason = Object.assign(new Error('check cancelled'), { code: 'FORGE_CHECK_CANCELLED' });
  const poll = () => {
    try { if (io.existsSync(path)) controller.abort(reason); }
    catch (error) { controller.abort(error); }
  };
  const cancel = () => {
    try { io.writeFileSync(path, 'cancel\n', { flag: 'a' }); }
    catch (error) { controller.abort(error); throw error; }
    poll();
  };
  const onSignal = () => {
    try { cancel(); } catch { /* controller 保留写入失败，入口按失败收尾。 */ }
  };
  env[controlKey] = path;
  io.watchFile(path, { interval: 50, persistent: false }, poll);
  events.on('SIGINT', onSignal); events.on('SIGTERM', onSignal);
  poll();
  return { path, signal: controller.signal, cancel,
    assertRunning: () => { poll(); controller.signal.throwIfAborted(); },
    close: () => {
      io.unwatchFile(path, poll);
      events.removeListener('SIGINT', onSignal); events.removeListener('SIGTERM', onSignal);
      if (inherited === undefined && env[controlKey] === path && !Reflect.deleteProperty(env, controlKey))
        throw new TypeError(`Cannot delete property '${controlKey}'`);
    },
  };
};
