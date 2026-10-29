import type { Execution } from '../../src/node/execution.js';

export function readOnlyGit(args: readonly string[]): boolean;
export function installReadQueryComponentExecution(execution: typeof Execution): () => void;
