import { ProcessWorker, type Diagnostic } from './process-worker.js';

import { MCPackError, type ErrorCode } from './errors.js';

import type { JsonObject, Operation } from './contracts.js';

import type { LoadedProject, WorkerDefinition } from './manifest.js';

/** Replaces whole process generations. Never transfers or replays their calls. */
export class WorkerSupervisor {
  private state: 'new' | 'starting' | 'ready' | 'restarting' | 'failed' | 'closed' = 'new';
  private worker?: ProcessWorker;
  private generation = 0;
  private attempts = 0;
  private restartCount = 0;
  private exhausted = false;
  private lastFailureCode?: ErrorCode;
  private readySince = 0;
  private nextRestartAt: number | null = null;
  private cancelDelay?: () => void;
  private recovering?: Promise<void>;
  private closing?: Promise<void>;
  private archivedDiagnostics = {
    forwardedBytes: 0,
    droppedBytes: 0,
  };

  constructor(
    private id: string,
    private definition: WorkerDefinition,
    private project: LoadedProject,
    private diagnostic: Diagnostic,
  ) {}

  private createWorker(): ProcessWorker {
    if (this.worker) {
      const counters = this.worker.snapshot().diagnostics;

      this.archivedDiagnostics.forwardedBytes += counters.forwardedBytes;

      this.archivedDiagnostics.droppedBytes += counters.droppedBytes;
    }

    this.generation++;

    const worker = new ProcessWorker(
      this.id,
      this.definition,
      this.project,
      this.diagnostic,
      (error) => this.failed(worker, error),
    );

    this.worker = worker;

    return worker;
  }

  async start(): Promise<void> {
    if (this.state !== 'new') {
      throw new MCPackError('WORKER_UNAVAILABLE', 'Worker already started');
    }

    this.state = 'starting';

    const worker = this.createWorker();

    try {
      await worker.start();

      this.markReady(worker);
    } catch (error) {
      if (!this.isClosed()) {
        this.state = 'failed';
      }

      throw error;
    }
  }

  private isClosed(): boolean {
    return this.state === 'closed';
  }

  private markReady(worker: ProcessWorker): void {
    if (this.isClosed()) {
      throw new MCPackError('RUNTIME_CLOSED', 'Runtime closed');
    }

    if (worker.snapshot().state !== 'ready') {
      throw new MCPackError('WORKER_UNAVAILABLE', 'Worker failed before becoming ready');
    }

    this.state = 'ready';

    this.readySince = performance.now();
  }

  private failed(worker: ProcessWorker, error: MCPackError): void {
    // Old transport callbacks belong only to their own process generation.
    if (worker !== this.worker || this.isClosed()) {
      return;
    }

    this.lastFailureCode = error.code;
    // Initial startup fails fast. Replacement startup is handled by recover().
    if (this.state !== 'ready') {
      return;
    }

    const policy = this.definition.recovery;

    if (policy && performance.now() - this.readySince >= policy.resetAfterMs) {
      this.attempts = 0;
    }

    if (!policy || this.attempts >= policy.maxRestarts) {
      this.exhausted = Boolean(policy);

      this.state = 'failed';

      return;
    }

    this.state = 'restarting';

    this.recovering = this.recover(worker).catch(() => {
      // No detached rejected promise, even if unexpected supervision code fails.
      if (!this.isClosed()) {
        this.lastFailureCode = 'WORKER_UNAVAILABLE';

        this.state = 'failed';
      }
    });
  }

  private async recover(previous: ProcessWorker): Promise<void> {
    const policy = this.definition.recovery!;
    // close() waits for process exit, including bounded forced termination.
    await previous.close();

    while (this.state === 'restarting') {
      if (this.attempts >= policy.maxRestarts) {
        this.exhausted = true;

        this.state = 'failed';

        return;
      }

      const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** this.attempts);
      // Equal jitter avoids synchronized restart storms while retaining a lower bound.
      const delay = Math.ceil(ceiling * (0.5 + Math.random() * 0.5));

      this.nextRestartAt = Date.now() + delay;

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);

        this.cancelDelay = () => {
          clearTimeout(timer);

          resolve();
        };
      });

      this.cancelDelay = undefined;

      this.nextRestartAt = null;

      if (this.state !== 'restarting') {
        return;
      }

      this.attempts++;

      this.restartCount++;

      const worker = this.createWorker();

      try {
        await worker.start();

        this.markReady(worker);

        return;
      } catch (error) {
        if (this.isClosed()) {
          return;
        }

        this.lastFailureCode = error instanceof MCPackError ? error.code : 'STARTUP_FAILED';

        await worker.close();
      }
    }
  }

  call(
    kind: Operation,
    handler: string,
    input: JsonObject,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.state !== 'ready') {
      return Promise.reject(
        new MCPackError('WORKER_UNAVAILABLE', `Worker ${this.id} is unavailable`),
      );
    }

    return this.worker!.call(kind, handler, input, signal);
  }

  snapshot() {
    const current = this.worker?.snapshot();

    return {
      state: this.state,
      active: current?.active ?? false,
      activeCount: current?.activeCount ?? 0,
      queued: current?.queued ?? 0,
      diagnostics: {
        forwardedBytes:
          this.archivedDiagnostics.forwardedBytes + (current?.diagnostics.forwardedBytes ?? 0),
        droppedBytes:
          this.archivedDiagnostics.droppedBytes + (current?.diagnostics.droppedBytes ?? 0),
      },
      recovery: {
        enabled: Boolean(this.definition.recovery),
        generation: this.generation,
        restartCount: this.restartCount,
        attempts: this.attempts,
        exhausted: this.exhausted,
        lastFailureCode: this.lastFailureCode ?? null,
        nextRestartAt: this.nextRestartAt,
      },
    };
  }

  close(): Promise<void> {
    if (this.closing) {
      return this.closing;
    }

    this.state = 'closed';

    this.cancelDelay?.();

    this.nextRestartAt = null;

    return (this.closing = Promise.all([this.worker?.close(), this.recovering]).then(() => {}));
  }
}
