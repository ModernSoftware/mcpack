export function createWorker() {
  let calls = 0;
  return {
    tools: {
      greet({ name }) {
        calls += 1;
        return {
          content: [{ type: 'text', text: `Hello, ${name}!` }],
          structuredContent: { calls, pid: process.pid, runtime: 'node' },
        };
      },
    },
  };
}
