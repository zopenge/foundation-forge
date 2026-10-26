import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

test('process profiling preserves callback, promisified and synchronous command results without logging arguments', async () => {
  const temporary = fileURLToPath(new URL('../../../.tmp/', import.meta.url));
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(resolve(temporary, 'process-profile-test-'));
  try {
    const source = `
      import { execFile, spawn, spawnSync } from 'node:child_process';
      import { promisify } from 'node:util';
      const args = ['-e', 'process.stdout.write("argument-not-logged")'];
      const callback = await new Promise((resolve, reject) => execFile(process.execPath, args,
        (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
      const pending = promisify(execFile)(process.execPath, args);
      const promised = await pending;
      const synchronous = spawnSync(process.execPath, args, { encoding: 'utf8' });
      const spawned = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args); let stdout = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.once('error', reject); child.once('close', code => resolve({ stdout, code }));
      });
      process.stdout.write(JSON.stringify({ pid: process.pid, callback, promised,
        child: Number.isInteger(pending.child?.pid), synchronous: synchronous.stdout,
        status: synchronous.status, spawned }));
    `;
    const result = await promisify(execFile)(process.execPath, [
      '--import', new URL('../evaluation/profile-process-commands.mjs', import.meta.url).href,
      '--input-type=module', '-e', source,
    ], { env: { ...process.env, NODE_OPTIONS: '', FORGE_CHECK_PROFILE_DIRECTORY: root }, windowsHide: true });
    const observed = JSON.parse(result.stdout);
    expect(observed).toMatchObject({
      callback: { stdout: 'argument-not-logged', stderr: '' },
      promised: { stdout: 'argument-not-logged', stderr: '' },
      child: true, synchronous: 'argument-not-logged', status: 0,
      spawned: { stdout: 'argument-not-logged', code: 0 },
    });
    const contents = await readFile(resolve(root, `commands-${observed.pid}.jsonl`), 'utf8');
    expect(contents).not.toContain('argument-not-logged');
    const rows = contents.trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(4);
    expect(rows.find(row => row.method === 'spawn')).toMatchObject({ exitCode: 0, exitMilliseconds: expect.any(Number) });
    expect(rows.every(row => row.exitCode === 0 && row.milliseconds >= 0)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
