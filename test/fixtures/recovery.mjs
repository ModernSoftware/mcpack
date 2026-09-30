import { appendFileSync, existsSync, readFileSync } from 'node:fs';

import { join } from 'node:path';

import { setTimeout as sleep } from 'node:timers/promises';

export async function createWorker(context) {
  const path = (name) => join(context.projectRoot, `${context.workerId}-${name}`);

  const previous = existsSync(path('starts'))
    ? readFileSync(path('starts'), 'utf8').trim().split('\n')
    : [];

  for (const pid of previous) {
    try {
      process.kill(Number(pid), 0);

      appendFileSync(path('overlap'), 'overlap\n');
    } catch {}
  }

  appendFileSync(path('starts'), `${process.pid}\n`);

  if (existsSync(path('hang-start'))) {
    await new Promise(() => {});
  }

  if (existsSync(path('fail-start'))) {
    throw new Error('PRIVATE_STARTUP_DETAIL');
  }

  let count = 0;

  return {
    tools: {
      probe: async (args) => {
        appendFileSync(path('calls'), `${args.id ?? 'call'}\n`);

        if (args.gate) {
          while (!existsSync(path('release'))) await sleep(5);
        }

        if (args.action === 'crash') {
          process.exit(7);
        }

        if (args.action === 'hang') {
          await new Promise(() => {});
        }

        if (args.action === 'protocol') {
          process.send({ garbage: true });

          await new Promise(() => {});
        }

        if (args.action === 'throw') {
          throw new Error('PRIVATE_HANDLER_DETAIL');
        }

        return {
          content: [],
          structuredContent: {
            pid: process.pid,
            count: ++count,
          },
        };
      },
    },
  };
}
