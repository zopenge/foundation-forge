import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import type { ReleaseConfig } from '../../src/contracts.js';
import { Execution } from '../../src/node/execution.js';

export type ScriptedInput =
  | { readonly method: 'git'; readonly args: Parameters<Execution['git']> }
  | { readonly method: 'run'; readonly args: Parameters<Execution['run']> }
  | { readonly method: 'streamGit'; readonly args: readonly [readonly string[], readonly number[]] };
export type ScriptedCall = ScriptedInput & { readonly result: string | Error };

/** 组件边界只消费完整参数脚本；未知、乱序或多余调用立即失败，绝不透传真实命令。 */
export class ScriptedExecution extends Execution {
  private position = 0;
  readonly observed: ScriptedInput[] = [];
  constructor(private readonly script: {
    readonly cwd: string; readonly config: ReleaseConfig; readonly calls: readonly ScriptedCall[];
    readonly signal?: AbortSignal; readonly onCall?: (input: ScriptedInput) => void;
  }) {
    super(script.cwd, script.config, script.signal, []);
  }
  private take(input: ScriptedInput): string {
    const next = this.script.calls[this.position];
    if (!next) throw new Error(`unexpected execution call ${String(this.position)}: ${JSON.stringify(input)}`);
    const { result, ...expected } = next;
    deepStrictEqual(input, expected, `execution call ${String(this.position)}`);
    this.position++; this.observed.push(input); this.script.onCall?.(input);
    if (result instanceof Error) throw result;
    return result;
  }
  override async git(...args: Parameters<Execution['git']>): Promise<string> {
    return this.take({ method: 'git', args });
  }
  override async run(...args: Parameters<Execution['run']>): Promise<string> {
    return this.take({ method: 'run', args });
  }
  override async streamGit(args: readonly string[], consume: (chunk: Uint8Array) => void,
    allowedExitCodes: readonly number[] = [0]): Promise<void> {
    const output = this.take({ method: 'streamGit', args: [args, allowedExitCodes] });
    consume(Buffer.from(output));
  }
  assertConsumed(): void {
    strictEqual(this.position, this.script.calls.length, 'unconsumed execution calls');
  }
}
