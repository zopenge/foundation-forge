import { spawn } from 'node:child_process';
import type { TestContext } from 'vitest';

export function liveTerminationChild(context: TestContext, additionalSignal?: AbortSignal) {
  context.signal.throwIfAborted(); additionalSignal?.throwIfAborted();
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal, ...(additionalSignal ? [additionalSignal] : [])]);
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'],
    { shell: false, windowsHide: true, signal, killSignal: 'SIGKILL', stdio: ['pipe', 'ignore', 'pipe'] });
  let error: Error | undefined;
  const onError = (value: Error) => { error = value; };
  child.on('error', onError);
  // AbortError 只说明已请求停止；清理必须等待真实 close，不能以 error 代替。
  const closed = new Promise<void>(resolve => { child.once('close', () => {
    child.removeListener('error', onError); resolve();
  }); });
  let disposal: Promise<void> | undefined;
  const dispose = () => {
    disposal ??= (async () => { controller.abort(); await closed; })();
    return disposal;
  };
  context.onTestFinished(dispose, 5000);
  return { child, closed, signal, dispose, error: () => error };
}
