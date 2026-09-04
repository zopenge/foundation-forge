import type { ProcessIdentity } from '@openge/forge-process-control';
import type { NodeCommandRunnerOptions } from './options.js';
import { TimerScope } from './timers.js';

type IdentityResult = { readonly type: 'identified'; readonly identity: ProcessIdentity }
  | { readonly type: 'exited' }
  | { readonly type: 'unavailable'; readonly cause?: unknown };

export async function acquireProcessIdentity(pid: number, exited: AbortSignal, options: NodeCommandRunnerOptions): Promise<IdentityResult> {
  const scope = new TimerScope(options);
  const controller = new AbortController();
  const timeout = scope.delay(options.identityAcquisition.timeoutMs).then(() => ({ type: 'deadline' as const }));
  let stop!: () => void;
  const stopped = new Promise<{ readonly type: 'exited' }>(resolve => {
    stop = () => { controller.abort(); scope.clear(); resolve({ type: 'exited' }); };
    exited.addEventListener('abort', stop, { once: true });
    if (exited.aborted) stop();
  });
  let cause: unknown;
  try {
    while (true) {
      const observation = Promise.resolve().then(() => options.processControl.listProcesses({ pids: [pid], signal: controller.signal }))
        .then(processes => ({ type: 'processes' as const, processes }), (error: unknown) => ({ type: 'error' as const, error }));
      const result = await Promise.race([observation, timeout, stopped]);
      if (result.type === 'exited') return result;
      if (result.type === 'deadline') return { type: 'unavailable', ...(cause === undefined ? {} : { cause }) };
      if (result.type === 'processes') {
        const match = result.processes.find(value => value.pid === pid && typeof value.startToken === 'string' && value.startToken.length > 0);
        if (match !== undefined) return { type: 'identified', identity: Object.freeze({ pid: match.pid, startToken: match.startToken, ...(match.command === undefined ? {} : { command: match.command }) }) };
      } else cause = result.error;
      const retry = await Promise.race([scope.delay(options.identityAcquisition.pollIntervalMs).then(() => ({ type: 'retry' as const })), timeout, stopped]);
      if (retry.type === 'exited') return retry;
      if (retry.type === 'deadline') return { type: 'unavailable', ...(cause === undefined ? {} : { cause }) };
    }
  } finally { exited.removeEventListener('abort', stop); controller.abort(); scope.clear(); }
}
