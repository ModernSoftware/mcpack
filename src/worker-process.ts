import { fork, spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { WorkerDefinition } from './manifest.js';
import { MCPackError } from './errors.js';

export interface WorkerProcess {
  child: ChildProcess;
  send(message: object): void;
}

/** Runtime-specific framing; scheduling and lifecycle live in ProcessWorker. */
export function launchWorker(
  definition: WorkerDefinition,
  cwd: string,
  env: NodeJS.ProcessEnv,
  receive: (message: unknown) => void,
  fail: (error: MCPackError) => void,
  diagnostic: (stream: 'stdout' | 'stderr', text: string) => void,
): WorkerProcess {
  const node = definition.runtime === 'node';
  const child = node
    ? fork(new URL('./worker-entry.js', import.meta.url), [], {
        cwd,
        env,
        execArgv: [],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        serialization: 'json',
      })
    : spawn(
        definition.executable,
        ['-u', '-B', fileURLToPath(new URL('../runtimes/python/worker.py', import.meta.url))],
        { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );

  child.on('error', () => fail(new MCPackError('WORKER_UNAVAILABLE', 'Cannot launch worker')));
  child.stderr?.on('data', (data: Buffer) => diagnostic('stderr', data.toString('utf8')));

  if (node) {
    child.stdout?.on('data', (data: Buffer) => diagnostic('stdout', data.toString('utf8')));
    child.on('message', receive);
    child.on('disconnect', () => fail(new MCPackError('WORKER_EXITED', 'Worker disconnected')));
  } else {
    // Python owns stdout as a UTF-8 JSON-lines channel; print() is redirected to stderr.
    child.stdout?.setEncoding('utf8');
    let pending = '';
    let broken = false;
    child.stdout?.on('data', (data: string) => {
      if (broken) return;
      pending += data;
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          receive(JSON.parse(line));
        } catch {
          broken = true;
          fail(new MCPackError('WORKER_PROTOCOL_ERROR', 'Invalid Python worker frame'));
          return;
        }
      }
    });
    child.stdin?.on('error', () => fail(new MCPackError('WORKER_EXITED', 'Worker input closed')));
  }

  return {
    child,
    send(message) {
      const onError = (error: Error | null | undefined) => {
        if (error) fail(new MCPackError('WORKER_PROTOCOL_ERROR', 'Worker send failed'));
      };
      if (node) {
        if (!child.connected) throw new Error('Worker disconnected');
        child.send(message, onError);
      } else {
        if (!child.stdin?.writable) throw new Error('Worker input closed');
        child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8', onError);
      }
    },
  };
}
