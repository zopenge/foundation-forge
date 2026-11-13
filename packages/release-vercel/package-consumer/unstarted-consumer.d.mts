import type { ReleaseReport } from '../src/contracts.js';

export function verifyUnstartedConsumer(options: { cwd: string; binary: string; sha: string;
  execute: (cwd: string, command: string, args: string[]) => string }):
  Promise<() => Promise<{ failed: ReleaseReport; retired: ReleaseReport } | undefined>>;
