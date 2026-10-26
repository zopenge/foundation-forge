import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { it } from 'vitest';

it('kills its own worker while a detached application remains in the outer owned scope', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},100)'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref(); await writeFile(process.env.FIXTURE_READY, JSON.stringify({ pid: child.pid }));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { await readFile(process.env.FIXTURE_KILL); process.kill(process.pid, 'SIGKILL'); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(10);
  }
  throw new Error('fixture controller did not request crash');
});
