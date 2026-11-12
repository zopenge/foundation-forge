import { spawn } from 'node:child_process';
import { expect, test } from 'vitest';
import { observeChildClose } from './helpers/child-close.js';

test('fixture cancellation records its error but waits for actual process closure', async context => {
  const controller = new AbortController();
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { windowsHide: true,
    stdio: ['pipe', 'ignore', 'ignore'], signal: AbortSignal.any([context.signal, controller.signal]) });
  let closed = false;
  const actualClose = new Promise<void>(accept => child.once('close', () => { closed = true; accept(); }));
  const outcome = observeChildClose(child);
  try {
    controller.abort(new Error('fixture cancellation'));
    expect(await outcome).toMatchObject({ error: { code: 'ABORT_ERR' } });
    expect(closed).toBe(true);
  } finally { controller.abort(); await actualClose; }
}, 15_000);
