import { Execution } from '../../dist/node/execution.js';
import { installReadQueryComponentExecution } from './component-command-runtime.mjs';

// 公共入口、真实协调器与受管变更命令均保留；仅把重复只读查询降为组件命令。
const restore = installReadQueryComponentExecution(Execution);
try { await import('./managed-worker.mjs'); } finally { restore(); }
