import { setTimeout } from 'node:timers/promises';

export function createWorker() {
  return {
    tools: {
      async probe({ payload = '', delayMs = 0, iterations = 0 }) {
        if (delayMs) await setTimeout(delayMs);
        let checksum = 0;
        for (let i = 0; i < iterations; i++) checksum = (checksum + i) % 65521;
        return {
          content: [{ type: 'text', text: payload }],
          structuredContent: { checksum, pid: process.pid },
        };
      },
    },
  };
}
