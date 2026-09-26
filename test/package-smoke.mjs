import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'mcpack-package-'));
const npmCli = process.env.npm_execpath;

if (!npmCli) throw new Error('Run through npm run test:package');

let client;
let httpHost;

try {
  const packed = await exec(
    process.execPath,
    [npmCli, 'pack', '--json', '--pack-destination', root],
    { cwd: resolve('.') },
  );

  const packages = JSON.parse(packed.stdout.slice(packed.stdout.search(/\[\r?\n/)));
  const archive = join(root, packages[0].filename);

  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'isolated-consumer', private: true }),
  );

  await exec(
    process.execPath,
    [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', archive],
    { cwd: root },
  );

  const installed = join(root, 'node_modules', '@modern-software', 'mcpack');
  const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(metadata.name, '@modern-software/mcpack');
  assert.equal(metadata.license, 'Apache-2.0');
  assert.match(await readFile(join(installed, 'LICENSE'), 'utf8'), /Apache License/);
  assert.match(await readFile(join(installed, 'NOTICE'), 'utf8'), /Modern Software/);
  const cli = join(installed, 'dist', 'cli.js');
  for (const example of ['hello', 'mixed']) {
    const manifest = join(installed, 'examples', example, 'mcpack.json');
    await exec(process.execPath, [cli, 'validate', manifest], { cwd: root });
    client = new Client({ name: 'package-smoke', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'serve', manifest],
      cwd: root,
      stderr: 'pipe',
    });
    transport.stderr?.resume();
    await client.connect(transport);
    assert.equal(
      (await client.callTool({ name: 'greet', arguments: { name: 'Package' } })).content[0].text,
      'Hello, Package!',
    );
    if (example === 'hello') {
      await client.readResource({ uri: 'mcpack://hello/guide' });
      await client.getPrompt({ name: 'welcome', arguments: { name: 'Package' } });
    } else {
      assert.equal(
        (await client.callTool({ name: 'summarize', arguments: { values: [2, 3] } }))
          .structuredContent.total,
        5,
      );
      await client.readResource({ uri: 'mcpack://mixed/guide' });
      await client.getPrompt({ name: 'review', arguments: { summary: '5' } });
    }
    await client.close();
    client = undefined;
  }

  const { serveHttp, bearerToken } = await import(
    pathToFileURL(join(installed, 'dist', 'index.js')).href
  );
  httpHost = await serveHttp(join(installed, 'examples', 'mixed', 'mcpack.json'), {
    port: 0,
    authorize: bearerToken('package-test'),
  });
  client = new Client(
    { name: 'package-http', version: '1' },
    { versionNegotiation: { mode: 'auto' } },
  );
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  await client.connect(
    new StreamableHTTPClientTransport(new URL(httpHost.url), {
      requestInit: { headers: { authorization: 'Bearer package-test' } },
    }),
  );
  assert.equal(
    (await client.callTool({ name: 'summarize', arguments: { values: [4, 5] } })).structuredContent
      .total,
    9,
  );
  await client.readResource({ uri: 'mcpack://mixed/guide' });
  await client.getPrompt({ name: 'review', arguments: { summary: '9' } });
  console.log('PASS: installed tarball serves Node/Python over stdio and authenticated HTTP');
} finally {
  await client?.close();
  await httpHost?.close();
  await rm(root, { recursive: true, force: true });
}
