import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import type { ReleaseStep } from '../src/index.js';
import { Execution } from '../src/node/execution.js';

const limits = { commandMs: 5000, deploymentMs: 1000, pollMs: 20, requestMs: 1000, maxOutputBytes: 4096 };
it('classifies a real noninteractive CLI authentication failure without exposing credentials', async () => {
  const steps: ReleaseStep[] = [];
  const execution = new Execution(resolve(import.meta.dirname, '../../..'), { limits }, undefined, steps);
  await expect(execution.run('vercel-api', { command: 'node', args: ['-e', 'console.error("No existing credentials. Please login. token=HIDDEN");process.exit(1)'] }, 'VERCEL_API')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  expect(JSON.stringify(steps)).not.toContain('HIDDEN');
});
it('terminates the real timed-out child process before returning its report', async () => {
  const steps: ReleaseStep[] = [];
  const execution = new Execution(resolve(import.meta.dirname, '../../..'), { limits }, undefined, steps);
  await expect(execution.run('timeout', { command: 'node', args: ['-e', 'console.log(process.pid);setInterval(()=>{},1000)'], timeoutMs: 1000 }, 'CHECK_FAILED')).rejects.toMatchObject({ code: 'COMMAND_TIMEOUT' });
  const pid = Number(steps[0]?.stdout?.trim()); expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
});
it('redacts credentials split across actual process writes in live output', async () => {
  const steps: ReleaseStep[] = []; const chunks: string[] = [];
  const execution = new Execution(resolve(import.meta.dirname, '../../..'), { limits }, undefined, steps);
  await execution.run('login-fixture', { command: 'node', args: ['-e', 'process.stdout.write("token=HID");setTimeout(()=>process.stdout.write("DEN\\nOpen https://example.invalid/device\\n"),100)'] }, 'AUTH_REQUIRED', undefined, undefined, true, text => chunks.push(text));
  expect(chunks.join('')).not.toContain('HID'); expect(chunks.join('')).toContain('Open https://example.invalid/device');
  expect(chunks.join('')).toContain('token=[REDACTED]\nOpen');
});
it('bounds live forwarding as well as captured output', async () => {
  const steps: ReleaseStep[] = []; const chunks: string[] = [];
  const execution = new Execution(resolve(import.meta.dirname, '../../..'), { limits }, undefined, steps);
  await execution.run('login-fixture', { command: 'node', args: ['-e', 'process.stdout.write(("visible line\\n").repeat(10000))'] }, 'AUTH_REQUIRED', undefined, undefined, true, text => chunks.push(text));
  expect(Buffer.byteLength(chunks.join(''))).toBeLessThanOrEqual(limits.maxOutputBytes);
  expect(chunks.join('')).toContain('visible line'); expect(steps[0]?.truncated).toBe(true);
});
