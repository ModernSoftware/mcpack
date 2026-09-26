import { DiagnosticLimiter } from './output-limits.js';
import type { ChildProcess } from 'node:child_process';
import { launchWorker, type WorkerProcess } from './worker-process.js';
import { randomUUID } from 'node:crypto';
import type { JsonObject, Operation } from './contracts.js';
import type { LoadedProject, WorkerDefinition } from './manifest.js';
import { MCPackError } from './errors.js';
import { childMessage } from './wire.js';

interface Pending {
  id: string;
  kind: Operation;
  handler: string;
  input: JsonObject;
  resolve(value: unknown): void;
  reject(error: MCPackError): void;
  cleanup(): void;
}

export type Diagnostic = (workerId: string, stream: 'stdout' | 'stderr', text: string) => void;

/** One persistent process, one active request, and a bounded FIFO queue. */
export class ProcessWorker {
  private child?: ChildProcess;
  private transport?: WorkerProcess;
  private state: 'new' | 'starting' | 'ready' | 'failed' | 'closed' = 'new';
  private queue: Pending[] = [];
  private active?: Pending;
  private ready?: { resolve(): void; reject(error: MCPackError): void };
  private exited: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;
  private startupTimer?: NodeJS.Timeout;
  private killTimer?: NodeJS.Timeout;
  private diagnosticLimiter?: DiagnosticLimiter;

  constructor(
    private id: string,
    private definition: WorkerDefinition,
    private project: LoadedProject,
    private diagnostic: Diagnostic,
  ) {}

  async start(): Promise<void> {
    if (this.state !== 'new') throw new MCPackError('WORKER_UNAVAILABLE', 'Worker already started');

    this.state = 'starting';
    const env: NodeJS.ProcessEnv = {};

    const inherited = [
      'PATH',
      'Path',
      'SystemRoot',
      'SYSTEMROOT',
      'WINDIR',
      'TEMP',
      'TMP',
      ...this.definition.inheritEnv,
    ];

    for (const key of inherited) if (process.env[key] !== undefined) env[key] = process.env[key];

    Object.assign(env, this.definition.env);

    this.diagnosticLimiter = new DiagnosticLimiter(
      this.definition.maxDiagnosticBytesPerSecond,
      (stream, text) => this.diagnostic(this.id, stream, text),
    );
    const transport = launchWorker(
      this.definition,
      this.project.root,
      env,
      (raw) => this.receive(raw),
      (error) => this.fail(error),
      (stream, text) => this.diagnosticLimiter!.write(stream, text),
    );
    this.transport = transport;
    const child = (this.child = transport.child);

    this.exited = new Promise((resolve) => {
      const exited = () => {
        clearTimeout(this.killTimer);
        this.fail(new MCPackError('WORKER_EXITED', `Worker ${this.id} exited`));
        resolve();
      };
      child.once('exit', exited);
      // Failed spawn emits error without exit. Do not wait for stdio 'close':
      // application-created descendants may retain the pipe descriptors.
      child.once('error', () => {
        if (!child.pid) exited();
      });
    });

    const started = new Promise<void>((resolve, reject) => {
      this.ready = { resolve, reject };
    });

    this.startupTimer = setTimeout(
      () => this.fail(new MCPackError('STARTUP_FAILED', `Worker ${this.id} startup timed out`)),
      this.definition.startupTimeoutMs,
    );

    const bindings = (['tools', 'resources', 'prompts'] as const).flatMap((kind) =>
      this.project.manifest[kind]
        .filter((item) => item.worker === this.id)
        .map((item) => ({ kind, handler: item.handler })),
    );

    this.send({
      type: 'init',
      workerId: this.id,
      projectRoot: this.project.root,
      module: this.definition.module,
      exportName: this.definition.export,
      config: this.definition.config,
      maxOutputBytes: this.definition.maxOutputBytes,
      bindings,
    });

    return started;
  }

  call(
    kind: Operation,
    handler: string,
    input: JsonObject,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.state !== 'ready')
      return Promise.reject(
        new MCPackError('WORKER_UNAVAILABLE', `Worker ${this.id} is unavailable`),
      );

    if (signal?.aborted) return Promise.reject(new MCPackError('CANCELLED', 'Request cancelled'));

    if (this.active && this.queue.length >= this.definition.maxQueue)
      return Promise.reject(new MCPackError('QUEUE_FULL', `Worker ${this.id} queue is full`));

    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const cancel = () => this.cancel(id, new MCPackError('CANCELLED', 'Request cancelled'));
      const timer = setTimeout(
        () => this.cancel(id, new MCPackError('DEADLINE_EXCEEDED', 'Request deadline exceeded')),
        this.definition.timeoutMs,
      );

      const pending: Pending = {
        id,
        kind,
        handler,
        input,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
        },
      };

      signal?.addEventListener('abort', cancel, { once: true });
      this.queue.push(pending);
      this.dispatch();
    });
  }

  private dispatch(): void {
    if (this.state !== 'ready' || this.active) return;

    this.active = this.queue.shift();

    if (this.active) {
      const { id, kind, handler, input } = this.active;
      this.send({ type: 'call', id, kind, handler, input });
    }
  }

  private receive(raw: unknown): void {
    if (this.state === 'closed' || this.state === 'failed') return;

    const parsed = childMessage.safeParse(raw);

    if (!parsed.success)
      return this.fail(new MCPackError('WORKER_PROTOCOL_ERROR', 'Invalid worker message'));

    const message = parsed.data;

    if (message.type === 'ready' && this.state === 'starting') {
      clearTimeout(this.startupTimer);
      this.state = 'ready';
      this.ready?.resolve();
      this.ready = undefined;
      return;
    }

    if (message.type === 'error' && !message.id)
      return this.fail(new MCPackError(message.code, message.message));

    if ((message.type !== 'result' && message.type !== 'error') || message.id !== this.active?.id) {
      return this.fail(new MCPackError('WORKER_PROTOCOL_ERROR', 'Unexpected worker response'));
    }

    const pending = this.active!;
    this.active = undefined;
    pending.cleanup();

    if (message.type === 'error') pending.reject(new MCPackError(message.code, message.message));
    else pending.resolve(message.result);

    this.dispatch();
  }

  private cancel(id: string, error: MCPackError): void {
    if (this.active?.id === id) {
      const active = this.active;
      this.active = undefined;
      active.cleanup();
      active.reject(error);
      this.send({ type: 'cancel', id });

      // Never reuse a worker whose timed-out handler could still mutate state.
      this.fail(
        new MCPackError('WORKER_UNAVAILABLE', 'Worker stopped after cancellation or deadline'),
      );
    } else {
      const index = this.queue.findIndex((item) => item.id === id);

      if (index < 0) return;

      const [pending] = this.queue.splice(index, 1);
      pending.cleanup();
      pending.reject(error);
    }
  }

  private send(message: object): void {
    try {
      this.transport?.send({ v: 1, ...message });
    } catch {
      this.fail(new MCPackError('WORKER_PROTOCOL_ERROR', 'Worker message could not be sent'));
    }
  }

  private rejectPending(error: MCPackError): void {
    clearTimeout(this.startupTimer);
    this.ready?.reject(error);
    this.ready = undefined;

    for (const pending of [...(this.active ? [this.active] : []), ...this.queue]) {
      pending.cleanup();
      pending.reject(error);
    }

    this.active = undefined;
    this.queue = [];
  }

  private fail(error: MCPackError): void {
    if (this.state === 'failed' || this.state === 'closed') return;

    this.state = 'failed';
    this.rejectPending(error);
    this.child?.kill('SIGTERM');
    this.killTimer = setTimeout(() => this.child?.kill('SIGKILL'), 250);
    this.killTimer.unref();
  }

  snapshot() {
    return {
      state: this.state,
      active: Boolean(this.active),
      queued: this.queue.length,
      diagnostics: this.diagnosticLimiter?.snapshot() ?? { forwardedBytes: 0, droppedBytes: 0 },
    };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;

    const wasReady = this.state === 'ready';
    this.state = 'closed';
    this.rejectPending(new MCPackError('RUNTIME_CLOSED', 'Runtime closed'));

    if (wasReady) this.send({ type: 'close' });
    else this.child?.kill('SIGTERM');

    this.closing = (async () => {
      const timer = setTimeout(
        () => this.child?.kill('SIGKILL'),
        this.definition.shutdownTimeoutMs,
      );
      try {
        await this.exited;
      } finally {
        clearTimeout(timer);
        clearTimeout(this.killTimer);
      }
    })();

    return this.closing;
  }
}
