import test from 'node:test';

import assert from 'node:assert/strict';

import { resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/client';

import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('one MCP server discovers and invokes persistent Node and Python capabilities', async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/cli.js'), 'serve', resolve('examples/mixed/mcpack.json')],
    stderr: 'pipe',
  });

  let diagnostics = '';

  transport.stderr?.on('data', (chunk) => {
    diagnostics += chunk;
  });

  const client = new Client({
    name: 'mixed-test',
    version: '1',
  });

  t.after(() => client.close());

  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`Mixed server initialization failed. Server diagnostics:\n${diagnostics}`, {
      cause: error,
    });
  }

  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ['greet', 'summarize'],
  );

  const node = await client.callTool({
    name: 'greet',
    arguments: { name: 'Diego' },
  });

  const python = await client.callTool({
    name: 'summarize',
    arguments: { values: [1, 2, 3] },
  });

  assert.equal(node.content[0].text, 'Hello, Diego!');

  assert.equal(python.structuredContent.total, 6);

  assert.notEqual(node.structuredContent.pid, python.structuredContent.pid);

  const repeated = await client.callTool({
    name: 'summarize',
    arguments: { values: [4] },
  });

  assert.equal(repeated.structuredContent.calls, 2);

  assert.equal(repeated.structuredContent.pid, python.structuredContent.pid);

  await assert.rejects(
    client.callTool({
      name: 'summarize',
      arguments: { values: [] },
    }),
  );

  assert.equal((await client.listResources()).resources[0].uri, 'mcpack://mixed/guide');

  assert.match(
    (await client.readResource({ uri: 'mcpack://mixed/guide' })).contents[0].text,
    /Python/,
  );

  assert.equal((await client.listPrompts()).prompts[0].name, 'review');

  assert.match(
    (
      await client.getPrompt({
        name: 'review',
        arguments: { summary: 'Total 6' },
      })
    ).messages[0].content.text,
    /Total 6/,
  );

  await client.close();

  assert.match(diagnostics, /Python worker ready/);
});
