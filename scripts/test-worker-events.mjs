import { appendFileSync } from 'node:fs';

// 只记录测试执行边界；应用、Git和原生监督辅助进程不冒充测试worker。
export const recordTestWorkerEvent = (type, { kind, jobId = process.env.FORGE_CHECK_JOB_ID, pid = process.pid, path = process.env.FORGE_CHECK_WORKER_EVENTS } = {}) => {
  if (path) appendFileSync(path, `${JSON.stringify({ type, kind, jobId, pid, at: new Date().toISOString() })}\n`);
};

