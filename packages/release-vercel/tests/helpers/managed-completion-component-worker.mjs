import { Execution } from '../../dist/node/execution.js';
import { installReadQueryComponentExecution } from './component-command-runtime.mjs';

// 只读查询真实执行但不重复受管日志；业务任务、真实退出及回执窗口沿用原worker。
const restore = installReadQueryComponentExecution(Execution);
try { await import('../../package-consumer/completion-worker.mjs'); } finally { restore(); }
