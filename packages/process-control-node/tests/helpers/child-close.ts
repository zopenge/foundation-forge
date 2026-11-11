import type { ChildProcess } from 'node:child_process';

export const observeChildClose = (child: Pick<ChildProcess, 'once'>): Promise<{ code: number | null; error?: unknown }> => new Promise(accept => {
  let failure: { error: unknown } | undefined;
  child.once('error', error => { failure = { error }; });
  // error 仅记录原因；只有 close 才能证明进程及其 stdio 已关闭。
  child.once('close', code => { accept({ code, ...failure }); });
});
