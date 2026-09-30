import { MCPackError } from './errors.js';

/** Bound Python's partial frame before UTF-8 decoding and JSON parsing. */
export class WorkerFrameReader {
  private parts: Buffer[] = [];
  private bytes = 0;
  private broken = false;

  constructor(
    private readonly limit: number,
    private readonly receive: (message: unknown) => void,
    private readonly fail: (error: MCPackError) => void,
  ) {}

  private reject(code: 'OUTPUT_LIMIT_EXCEEDED' | 'WORKER_PROTOCOL_ERROR', message: string) {
    this.broken = true;

    this.parts = [];

    this.bytes = 0;

    this.fail(new MCPackError(code, message));
  }

  write(data: Buffer): void {
    if (this.broken) {
      return;
    }

    let start = 0;

    while (start < data.length) {
      const newline = data.indexOf(10, start);

      const end = newline === -1 ? data.length : newline;

      const size = end - start;

      if (this.bytes + size > this.limit) {
        this.reject('OUTPUT_LIMIT_EXCEEDED', 'Worker frame exceeded maxOutputBytes.');

        return;
      }

      if (size) {
        this.parts.push(Buffer.from(data.subarray(start, end)));
      }

      this.bytes += size;

      if (newline === -1) {
        return;
      }

      const frame = Buffer.concat(this.parts, this.bytes);

      this.parts = [];

      this.bytes = 0;

      try {
        this.receive(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)));
      } catch {
        this.reject('WORKER_PROTOCOL_ERROR', 'Invalid Python worker frame');

        return;
      }

      start = newline + 1;
    }
  }

  end(): void {
    if (!this.broken && this.bytes) {
      this.reject('WORKER_PROTOCOL_ERROR', 'Incomplete Python worker frame');
    }
  }
}
