import type { NodeCommandRunnerOptions } from './options.js';

export class TimerScope {
  private readonly timeouts = new Set<ReturnType<typeof globalThis.setTimeout>>();
  private readonly intervals = new Set<ReturnType<typeof globalThis.setInterval>>();
  constructor(private readonly options: NodeCommandRunnerOptions) {}
  timeout(callback: () => void, milliseconds: number): void {
    const handle = (this.options.setTimeout ?? globalThis.setTimeout)(() => {
      this.timeouts.delete(handle);
      callback();
    }, milliseconds);
    this.timeouts.add(handle);
  }
  interval(callback: () => void, milliseconds: number): void {
    this.intervals.add((this.options.setInterval ?? globalThis.setInterval)(callback, milliseconds));
  }
  delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => this.timeout(resolve, milliseconds));
  }
  clear(): void {
    for (const handle of this.timeouts) (this.options.clearTimeout ?? globalThis.clearTimeout)(handle);
    for (const handle of this.intervals) (this.options.clearInterval ?? globalThis.clearInterval)(handle);
    this.timeouts.clear();
    this.intervals.clear();
  }
}
