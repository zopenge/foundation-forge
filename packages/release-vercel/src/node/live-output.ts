import { redact } from './errors.js';

interface StreamState { readonly decoder: TextDecoder; remainingInput: number; remainingOutput: number; pending: string }
export class LiveOutput {
  private readonly streams: Record<'stdout' | 'stderr', StreamState>;
  constructor(maxBytes: number, readonly emit: (text: string) => void) {
    const stream = (): StreamState => ({ decoder: new TextDecoder(), remainingInput: maxBytes, remainingOutput: maxBytes, pending: '' });
    this.streams = { stdout: stream(), stderr: stream() };
  }
  write(stream: 'stdout' | 'stderr', bytes: Uint8Array): void {
    const state = this.streams[stream];
    const accepted = bytes.subarray(0, state.remainingInput);
    state.remainingInput -= accepted.byteLength;
    state.pending += state.decoder.decode(accepted, { stream: true });
    const last = Math.max(state.pending.lastIndexOf('\n'), state.pending.lastIndexOf('\r'));
    if (last >= 0) { this.flush(state, state.pending.slice(0, last + 1)); state.pending = state.pending.slice(last + 1); }
    if (state.remainingInput === 0) { this.flush(state, state.pending); state.pending = ''; }
  }
  finish(): void {
    for (const state of Object.values(this.streams)) {
      this.flush(state, state.pending); state.pending = '';
    }
  }
  private flush(state: StreamState, text: string): void {
    const bytes = new TextEncoder().encode(redact(text));
    const accepted = bytes.subarray(0, state.remainingOutput);
    state.remainingOutput -= accepted.byteLength;
    const output = new TextDecoder().decode(accepted, { stream: true });
    if (output) this.emit(output);
  }
}
