import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('official client discovers and invokes native capabilities over stdio', async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/cli.js'), 'serve', resolve('examples/hello/mcpack.json')],
    stderr: 'pipe',
  });

  let diagnostics = '';

  transport.stderr?.on('data', (chunk) => {
    diagnostics += chunk;
  });

  const client = new Client({ name: 'mcpack-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();

  assert.equal(tools.tools[0].name, 'greet');
  assert.equal(tools.tools[0].inputSchema.additionalProperties, false);

  const result = await client.callTool({ name: 'greet', arguments: { name: 'Diego' } });

  assert.equal(result.content[0].text, 'Hello, Diego!');
  assert.equal(
    (await client.callTool({ name: 'greet', arguments: { name: 'Team' } })).structuredContent.count,
    2,
  );

  await assert.rejects(client.callTool({ name: 'greet', arguments: {} }));
  assert.equal((await client.listResources()).resources[0].uri, 'mcpack://hello/guide');
  assert.match(
    (await client.readResource({ uri: 'mcpack://hello/guide' })).contents[0].text,
    /Call greet/,
  );
  assert.equal((await client.listPrompts()).prompts[0].name, 'welcome');
  assert.match(
    (await client.getPrompt({ name: 'welcome', arguments: { name: 'Diego' } })).messages[0].content
      .text,
    /Diego/,
  );
  await assert.rejects(client.getPrompt({ name: 'welcome' }));
  await assert.rejects(client.readResource({ uri: 'mcpack://missing' }));
  await client.close();
  assert.match(diagnostics, /Worker ready/);
});
