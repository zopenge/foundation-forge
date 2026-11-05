import { expect, it, vi } from 'vitest';
import { completionDeadline } from './helpers/completion-deadline.js';

it('fires the original completion deadline only when its full interval advances', () => {
  const deadline = completionDeadline(1000), observed: string[] = [];
  try {
    deadline.timers.setTimeout((value: string) => observed.push(value), 1000, 'expired');
    deadline.advance(999); expect(observed).toEqual([]);
    deadline.advance(1); expect(observed).toEqual(['expired']);
    deadline.advance(1000); expect(observed).toEqual(['expired']);
  } finally { deadline.dispose(); }
});

it('preserves ordinary real timers and clears a controlled deadline without firing it', async () => {
  const deadline = completionDeadline(1000), observed: string[] = [];
  try {
    const handle = deadline.timers.setTimeout(() => observed.push('cancelled'), 1000);
    deadline.timers.clearTimeout(handle);
    await new Promise<void>(accept => deadline.timers.setTimeout(accept, 0));
    deadline.advance(1000); expect(observed).toEqual([]);
  } finally { deadline.dispose(); }
});

it('rejects invalid clock movement and disposes pending deadlines', () => {
  const deadline = completionDeadline(1000), observed: string[] = [];
  for (const value of [-1, Infinity, NaN]) expect(() => deadline.advance(value)).toThrow('INVALID_COMPLETION_CLOCK');
  deadline.timers.setTimeout(() => observed.push('disposed'), 1000);
  deadline.dispose(); deadline.advance(1000); expect(observed).toEqual([]);
});

it('leaves equal shutdown deadlines on the ordinary timer while controlling one command deadline', async () => {
  vi.useFakeTimers();
  const deadline = completionDeadline(5000, { once: true }), observed: string[] = [];
  try {
    deadline.timers.setTimeout(() => observed.push('command'), 5000);
    deadline.timers.setTimeout(() => observed.push('shutdown'), 5000);
    await vi.advanceTimersByTimeAsync(5000); expect(observed).toEqual(['shutdown']);
    deadline.advance(4999); expect(observed).toEqual(['shutdown']);
    deadline.advance(1); expect(observed).toEqual(['shutdown', 'command']);
  } finally { deadline.dispose(); vi.clearAllTimers(); vi.useRealTimers(); }
});
