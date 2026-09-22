import { writeFile } from 'node:fs/promises';
export async function createWorker(context) {
  let count = 0;
  const result = (value) => ({
    content: [{ type: 'text', text: String(value) }],
    structuredContent: { count, pid: process.pid, worker: context.workerId },
  });
  return {
    tools: {
      async probe({ action = 'count', delay = 0 }) {
        if (action === 'hang') await new Promise(() => {});
        if (action === 'crash') process.exit(7);
        if (action === 'throw') throw new Error('PRIVATE_EXCEPTION');
        if (action === 'invalid') return { content: 'wrong' };
        if (action === 'bigint') return { content: [], structuredContent: { value: 1n } };
        if (action === 'business')
          return { content: [{ type: 'text', text: 'Denied by business rule' }], isError: true };
        if (action === 'env')
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  inherited: process.env.MCPACK_TEST_INHERITED,
                  hidden: process.env.MCPACK_TEST_HIDDEN,
                  explicit: process.env.MCPACK_TEST_EXPLICIT,
                }),
              },
            ],
          };
        console.log('This must not reach MCP stdout');
        await new Promise((resolve) => setTimeout(resolve, delay));
        count += 1;
        return result(count);
      },
    },
    async close() {
      if (context.config.hangOnClose) await new Promise(() => {});
      if (context.config.marker) await writeFile(context.config.marker, 'closed');
    },
  };
}

export async function neverReady() {
  await new Promise(() => {});
}
