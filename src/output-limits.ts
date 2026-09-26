import { StringDecoder } from 'node:string_decoder';

/** UTF-8 diagnostic delivery budget per worker, shared by both streams. */
export class DiagnosticLimiter {
  private windowStart: number;
  private remaining: number;
  private forwardedBytes = 0;
  private droppedBytes = 0;

  constructor(
    private readonly limit: number,
    private readonly deliver: (stream: 'stdout' | 'stderr', text: string) => void,
    private readonly now = () => performance.now(),
  ) {
    this.windowStart = now();
    this.remaining = limit;
  }

  write(stream: 'stdout' | 'stderr', text: string): void {
    const now = this.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.remaining = this.limit;
    }
    const data = Buffer.from(text, 'utf8');
    let offset = 0;
    while (offset < data.length && this.remaining > 0) {
      const size = Math.min(8192, this.remaining, data.length - offset);
      // Do not emit half of a multi-byte character or exceed the byte budget.
      const chunk = new StringDecoder('utf8').write(data.subarray(offset, offset + size));
      const bytes = Buffer.byteLength(chunk);
      if (!bytes) break;
      offset += bytes;
      this.remaining -= bytes;
      this.forwardedBytes += bytes;
      try {
        this.deliver(stream, chunk);
      } catch {
        // Diagnostic consumer exceptions must not fail worker execution.
      }
    }
    this.droppedBytes += data.length - offset;
  }

  snapshot() {
    return { forwardedBytes: this.forwardedBytes, droppedBytes: this.droppedBytes };
  }
}
