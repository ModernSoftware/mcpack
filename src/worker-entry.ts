import { pathToFileURL } from 'node:url';

import type { NativeWorker, WorkerContext, CallContext, Handler, JsonObject } from './contracts.js';

import { parentMessage, toolResult, resourceResult, promptResult } from './wire.js';

let worker: NativeWorker | undefined;

let context: WorkerContext;

const active = new Map<string, { controller: AbortController; task: Promise<void> }>();

let closing = false;

let maxOutputBytes = 1024 * 1024;

function send(message: object): void {
  if (!process.connected) {
    return;
  }

  const frame = {
    v: 1,
    ...message,
  };

  if (Buffer.byteLength(JSON.stringify(frame), 'utf8') > maxOutputBytes) {
    process.send?.({
      v: 1,
      type: 'error',
      id: (message as { id?: string }).id,
      code: 'OUTPUT_LIMIT_EXCEEDED',
      message: 'Worker response exceeded maxOutputBytes.',
    });

    return;
  }

  process.send?.(frame);
}

async function close(): Promise<void> {
  if (closing) {
    return;
  }

  closing = true;

  for (const call of active.values()) call.controller.abort();

  await Promise.all(Array.from(active.values()).map((call) => call.task));

  await worker?.close?.();

  send({ type: 'closed' });

  process.disconnect?.();
}

process.on('message', async (raw) => {
  try {
    const message = parentMessage.parse(raw);

    if (message.type === 'init') {
      if (worker) {
        throw new Error('Worker already initialized');
      }

      maxOutputBytes = message.maxOutputBytes;

      context = {
        workerId: message.workerId,
        projectRoot: message.projectRoot,
        config: message.config,
        log: (value) => process.stderr.write(`[${message.workerId}] ${value}\n`),
      };

      const module = await import(pathToFileURL(message.module).href);

      const factory = module[message.exportName];

      if (typeof factory !== 'function') {
        throw new Error(`Missing factory export: ${message.exportName}`);
      }

      worker = await factory(context);

      if (!worker || typeof worker !== 'object') {
        throw new Error('Factory must return a NativeWorker object');
      }

      for (const binding of message.bindings) {
        const table = worker[binding.kind];

        if (
          !table ||
          !Object.hasOwn(table, binding.handler) ||
          typeof table[binding.handler] !== 'function'
        ) {
          throw new Error(`Missing ${binding.kind} handler: ${binding.handler}`);
        }
      }

      send({ type: 'ready' });
    } else if (message.type === 'call') {
      if (!worker || closing) {
        throw new Error('Worker is not ready to accept a call');
      }

      const table = worker[message.kind];

      const handler =
        table && Object.hasOwn(table, message.handler) ? table[message.handler] : undefined;

      if (!handler) {
        throw new Error('Handler not found');
      }

      const controller = new AbortController();

      const callContext: CallContext = {
        ...context,
        requestId: message.id,
        signal: controller.signal,
      };

      const task = Promise.resolve().then(async () => {
        try {
          let result: unknown;

          try {
            result = await (handler as Handler<JsonObject, unknown>)(message.input, callContext);
          } catch (error) {
            context.log(error instanceof Error ? (error.stack ?? error.message) : String(error));

            send({
              type: 'error',
              id: message.id,
              code: 'HANDLER_FAILED',
              message: 'Handler failed; inspect worker diagnostics.',
            });

            return;
          }

          const schema = {
            tools: toolResult,
            resources: resourceResult,
            prompts: promptResult,
          }[message.kind];

          const parsed = schema.safeParse(result);

          if (!parsed.success) {
            send({
              type: 'error',
              id: message.id,
              code: 'INVALID_RESULT',
              message: 'Handler returned an invalid result.',
            });

            return;
          }

          send({
            type: 'result',
            id: message.id,
            result: parsed.data,
          });
        } catch {
          send({
            type: 'error',
            id: message.id,
            code: 'INVALID_RESULT',
            message: 'Handler result could not be serialized.',
          });
        } finally {
          active.delete(message.id);
        }
      });

      active.set(message.id, {
        controller,
        task,
      });
    } else if (message.type === 'cancel') {
      const activeCall = active.get(message.id);

      if (activeCall) {
        activeCall.controller.abort();
      }
    } else await close();
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);

    send({
      type: 'error',
      code: 'STARTUP_FAILED',
      message: 'Worker initialization or protocol failed; inspect diagnostics.',
    });

    process.exitCode = 1;

    process.disconnect?.();
  }
});

process.on('disconnect', () => {
  void close().finally(() => process.exit());
});
