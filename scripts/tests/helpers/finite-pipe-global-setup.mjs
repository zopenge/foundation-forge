import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export default function setup() {
  if (process.platform !== 'linux') return;
  // Linux subreaper 在 CLI 关闭后立即检查空集合；先等待本夹具后代自行退出。
  return async () => {
    const identity = JSON.parse(await readFile(process.env.FORGE_FINITE_PIPE_READY, 'utf8'));
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !/^\d+$/u.test(identity.startToken))
      throw new Error('invalid finite pipe identity');
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      let exited;
      try {
        const stat = await readFile(`/proc/${identity.pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (fields[19] !== identity.startToken) throw new Error('finite pipe identity changed');
        exited = fields[0] === 'Z';
      } catch (error) { if (error.code !== 'ENOENT') throw error; exited = true; }
      if (exited) {
        await writeFile(process.env.FORGE_FINITE_PIPE_DRAINED, JSON.stringify(identity));
        return;
      }
      await delay(10);
    }
    throw new Error('finite pipe descendant did not exit naturally');
  };
}
