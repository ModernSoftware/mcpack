import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const exec = promisify(execFile);
const image = process.argv[2] ?? 'mcpack:ci';
const name = `mcpack-smoke-${randomUUID()}`;
const token = randomUUID();
const root = await mkdtemp(join(tmpdir(), 'mcpack-container-'));
const docker = (...args) =>
  exec('docker', args, { timeout: 30000, env: { ...process.env, MCPACK_HTTP_TOKEN: token } });
let client;
try {
  await chmod(root, 0o755);
  const manifest = JSON.parse(
    await readFile(new URL('../examples/mixed/mcpack.json', import.meta.url)),
  );
  for (const worker of Object.values(manifest.workers))
    worker.recovery = { baseDelayMs: 1000, maxDelayMs: 1000 };
  const filename = join(root, 'mcpack.json');
  await writeFile(filename, JSON.stringify(manifest), { mode: 0o644 });
  await docker(
    'run',
    '-d',
    '--name',
    name,
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=32m',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    '256m',
    '--cpus',
    '1',
    '--pids-limit',
    '64',
    '-e',
    'MCPACK_HTTP_TOKEN',
    '-p',
    '127.0.0.1::3000',
    '--mount',
    `type=bind,source=${filename},target=/project/mcpack.json,readonly`,
    image,
  );
  const address = (await docker('port', name, '3000/tcp')).stdout.trim();
  const url = `http://${address}`;
  async function probe(path, status) {
    const deadline = performance.now() + 20000;
    while (performance.now() < deadline) {
      if (
        await fetch(url + path)
          .then((r) => r.status === status)
          .catch(() => false)
      )
        return;
      await sleep(50);
    }
    assert.fail(`${path} did not reach ${status}`);
  }
  await probe('/readyz', 200);
  assert.equal((await fetch(url + '/mcp', { method: 'POST', body: '{}' })).status, 401);
  assert.notEqual((await docker('exec', name, 'id', '-u')).stdout.trim(), '0');
  client = new Client({ name: 'container-smoke', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url + '/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  assert.equal(
    (await client.callTool({ name: 'greet', arguments: { name: 'Container' } })).content[0].text,
    'Hello, Container!',
  );
  assert.equal(
    (await client.callTool({ name: 'summarize', arguments: { values: [2, 3] } })).structuredContent
      .total,
    5,
  );
  assert.equal((await client.listResources()).resources.length, 1);
  assert.equal((await client.listPrompts()).prompts.length, 1);
  // Kill only the Python runner; verify recovery with the same installed package/client.
  await docker(
    'exec',
    name,
    'python3',
    '-c',
    `import os,signal,pathlib
for path in pathlib.Path('/proc').iterdir():
 if path.name.isdigit() and int(path.name) != os.getpid():
  try:
   cmd=(path/'cmdline').read_bytes().split(b'\\0')
   if any(arg.endswith(b'/runtimes/python/worker.py') for arg in cmd):
    os.kill(int(path.name), signal.SIGKILL)
    break
  except (FileNotFoundError, PermissionError): pass
else: raise RuntimeError('Python worker not found')`,
  );
  await probe('/readyz', 503);
  await probe('/healthz', 200);
  await probe('/readyz', 200);
  assert.equal(
    (await client.callTool({ name: 'summarize', arguments: { values: [4, 5] } })).structuredContent
      .total,
    9,
  );
  await client.close();
  client = undefined;
  await docker('stop', '--time', '10', name);
  const state = JSON.parse((await docker('inspect', '--format', '{{json .State}}', name)).stdout);
  assert.equal(state.ExitCode, 0);
  assert.equal(state.OOMKilled, false);
  // No token inherited unless Docker is explicitly given -e; startup must fail closed.
  await assert.rejects(
    docker('run', '--rm', image),
    (error) => error.code === 1 && error.stderr.includes('empty or missing'),
  );
  console.log(
    'PASS: non-root/read-only container, auth, mixed runtimes, recovery and SIGTERM shutdown',
  );
} finally {
  await client?.close();
  await docker('rm', '-f', name).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
