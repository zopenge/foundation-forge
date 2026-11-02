import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export default async function setup() {
  if (!['linux', 'win32'].includes(process.platform)) return;
  const reader = process.platform === 'win32'
    ? (await import('../../../packages/process-control-node/dist/index.js')).createWindowsNativeProcessIdentityReader()
    : undefined;
  // 池已报告管道关闭失败后，先按真实身份等待夹具后代自行退出，再允许 CLI 收尾。
  return async () => {
    const identity = JSON.parse(await readFile(process.env.FORGE_FINITE_PIPE_READY, 'utf8'));
    const token = reader ? /^\/Date\(\d+\)\/$/u : /^\d+$/u;
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !token.test(identity.startToken))
      throw new Error('invalid finite pipe identity');
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      let exited;
      try {
        if (reader) {
          const observed = await reader.readIdentity({ pid: identity.pid });
          if (observed.status === 'FOUND' && observed.identity.startToken !== identity.startToken)
            throw new Error('finite pipe identity changed');
          exited = observed.status === 'ABSENT';
        } else {
          const stat = await readFile(`/proc/${identity.pid}/stat`, 'utf8');
          const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          if (fields[19] !== identity.startToken) throw new Error('finite pipe identity changed');
          exited = fields[0] === 'Z';
        }
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
