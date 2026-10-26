import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { recordTestWorkerEvent } from './test-worker-events.mjs';
import { createTestWorkerBudget, testWorkerLimit } from './test-worker-budget.mjs';

// 仅适配 Vitest 公开 PoolWorker 传输接口；测试执行、隔离及覆盖率仍由原 forks worker 负责。
export const createHiddenVitestPool = ({ workers = testWorkerLimit(), forkCommand = fork, record = recordTestWorkerEvent } = {}) => {
  const capacity = createTestWorkerBudget({ limit: workers });
  return {
  name: 'forge-hidden-forks',
  createPoolWorker(options) {
    let child, closed, starting, stopping, exited = false, stopRequested = false;
    const output = options.project.vitest.logger.outputStream;
    const errors = options.project.vitest.logger.errorStream;
    const current = () => {
      if (!child) throw new Error('Vitest worker is not running');
      return child;
    };
    return {
      name: 'forge-hidden-forks', cacheFs: true,
      on: (event, listener) => { current().on(event, listener); },
      off: (event, listener) => { current().off(event, listener); },
      send: message => { current().send(message); },
      deserialize: value => value,
      async start() {
        starting ??= new Promise((acceptStart, rejectStart) => {
          // Vitest 会先复用调度编号再等待旧 worker 停机；实际 OS 槽位必须等父侧 exit 才归还。
          void capacity.run({ name: 'vitest fork', workers: 1 }, async () => {
            exited = false; stopping = undefined; stopRequested = false;
            child = forkCommand(resolve(options.distPath, 'workers/forks.js'), [], {
              env: options.env, execArgv: options.execArgv, stdio: 'pipe', serialization: 'advanced', windowsHide: true,
            });
            const worker = child;
            const observation = { kind: 'vitest', pid: worker.pid, jobId: options.env.FORGE_CHECK_JOB_ID,
              path: options.env.FORGE_CHECK_WORKER_EVENTS };
            let observed = false, startupError;
            const ended = new Promise((acceptExit, rejectExit) => {
              worker.once('spawn', () => { observed = true; record('start', observation); });
              worker.once('error', error => { startupError = error; });
              // 强杀也有父侧 exit；意外死亡停止本 pool 尚未启动的任务。
              worker.once('exit', () => {
                exited = true;
                if (observed) record('finish', observation);
                if (stopRequested) acceptExit(); else rejectExit(new Error('Vitest worker exited before teardown'));
              });
              worker.once('close', () => { if (!observed) rejectExit(startupError ?? new Error('Vitest worker did not start')); });
            });
            closed = new Promise(accept => { worker.once('close', accept); });
            for (const [source, target] of [[worker.stdout, output], [worker.stderr, errors]]) {
              if (source) { target.setMaxListeners(target.getMaxListeners() + 1); source.pipe(target); }
            }
            acceptStart();
            await ended;
          }).catch(rejectStart);
        });
        await starting;
      },
      async stop() {
        if (!child) return;
        stopping ??= (async () => {
          const worker = child;
          stopRequested = true;
          let timer, deadline, failure;
          try {
            if (worker.pid !== undefined && !exited && worker.exitCode === null && worker.signalCode === null) {
              // 沿用 Vitest forks 的 500ms 升级期限，只终止持有句柄的本 worker。
              timer = setTimeout(() => { if (!exited) worker.kill('SIGKILL'); }, 500);
              worker.kill();
            }
            // 使用原项目的 teardownTimeout；管道被后代持有时失败交给外层 Job 回收。
            await Promise.race([closed, new Promise((_accept, reject) => {
              deadline = setTimeout(() => { reject(new Error('Vitest worker output did not close after termination')); }, options.project.config.teardownTimeout);
            })]);
          } catch (error) {
            failure = error;
            capacity.stop(error);
            options.project.vitest.state.catchError(error, 'Worker teardown');
            process.exitCode = 1;
            throw error;
          } finally {
            clearTimeout(timer); clearTimeout(deadline);
            for (const [source, target] of [[worker.stdout, output], [worker.stderr, errors]]) {
              if (source) { source.unpipe(target); target.setMaxListeners(target.getMaxListeners() - 1); if (failure) source.destroy(); }
            }
            child = undefined; starting = undefined;
          }
        })();
        await stopping;
      },
    };
  },
  };
};
