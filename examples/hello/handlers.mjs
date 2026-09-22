/** A module is loaded once per named worker. Nothing is registered globally. */
export async function createWorker(context) {
  let greetings = 0;
  context.log('Worker ready');

  return {
    tools: {
      async greet({ name }) {
        greetings += 1;
        const text = `${context.config.greeting ?? 'Hello'}, ${name}!`;
        return {
          content: [{ type: 'text', text }],
          structuredContent: { greeting: text, count: greetings, workerPid: process.pid },
        };
      },
    },
    resources: {
      async guide({ uri }) {
        return {
          contents: [
            { uri, mimeType: 'text/plain', text: 'Call greet, then request the welcome prompt.' },
          ],
        };
      },
    },
    prompts: {
      async welcome({ name }) {
        return {
          messages: [
            { role: 'user', content: { type: 'text', text: `Write a short welcome for ${name}.` } },
          ],
        };
      },
    },
    async close() {
      context.log('Worker closed');
    },
  };
}
