import { existsSync } from 'node:fs';

import { appendFile, writeFile } from 'node:fs/promises';

import { join } from 'node:path';

import { setTimeout as sleep } from 'node:timers/promises';

export function createWorker(context) {
  const path = (name) => join(context.projectRoot, name);

  async function probe(args, call) {
    await writeFile(path(`started-${args.id}`), call.requestId);

    while (!existsSync(path(`release-${args.id}`))) {
      if (call.signal.aborted && args.cooperate) {
        break;
      }

      await sleep(5);
    }

    await writeFile(path(`finished-${args.id}`), 'finished');

    if (args.crash) {
      process.exit(7);
    }

    if (args.fail) {
      throw new Error('private failure');
    }

    return {
      content: [],
      structuredContent: {
        id: args.id,
        requestId: call.requestId,
      },
    };
  }

  return {
    tools: {
      probe,
      sync: probe,
    },
    resources: {
      read: async (args, call) => {
        await probe({ id: 'resource' }, call);

        return {
          contents: [
            {
              uri: args.uri,
              text: 'resource',
            },
          ],
        };
      },
    },
    prompts: {
      render: async (_args, call) => {
        await probe({ id: 'prompt' }, call);

        return {
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: 'prompt',
              },
            },
          ],
        };
      },
    },
    close: () => appendFile(path(`closed-${context.workerId}`), 'closed\n'),
  };
}
