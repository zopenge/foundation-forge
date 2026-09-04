export class CaptureBuffer {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;
  truncated = false;
  constructor(private readonly limit: number) {}
  append(chunk: Uint8Array): void {
    const count = Math.min(chunk.byteLength, this.limit - this.length);
    if (count > 0) this.chunks.push(Uint8Array.from(chunk.subarray(0, count)));
    this.length += count;
    if (count < chunk.byteLength) this.truncated = true;
  }
  bytes(): Uint8Array {
    const result = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }
}
