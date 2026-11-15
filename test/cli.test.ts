import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
function run(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [cli, ...args], { env, timeout: 10000 }, (error, stdout, stderr) => {
      resolve({ code: typeof error?.code === 'number' ? error.code : error ? 1 : 0, stdout, stderr });
    });
  });
}

test('CLI help is offline and invalid arguments fail without echoing secrets', async () => {
  assert.match((await run(['--help'])).stdout, /read-only/);
  const result = await run(['--token', 'do-not-log-me']);
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stderr, /do-not-log-me/);
});

test('CLI probes only read actions, masks account and distinguishes unknown health', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'lumabridge-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const seen: string[] = [];
  let healthy = true;
  const server = createServer((req, res) => {
    seen.push(req.url ?? '');
    assert.equal(req.headers.authorization, 'Bearer synthetic-cli-token');
    const data = req.url === '/get_version_info' ? { app_name: 'MockOneBot', app_version: '0.0.0' }
      : req.url === '/get_status' ? (healthy ? { online: true, good: true } : {})
      : { user_id: '123456789' };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ backend: {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    tokenEnv: 'LUMABRIDGE_TEST_TOKEN',
  } }));
  const env = { ...process.env, LUMABRIDGE_TEST_TOKEN: 'synthetic-cli-token' };
  const ok = await run(['--config', path], env);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).account.id, '[redacted]');
  assert.doesNotMatch(ok.stdout + ok.stderr, /123456789|synthetic-cli-token/);
  assert.deepEqual(seen, ['/get_version_info', '/get_status', '/get_login_info']);
  healthy = false;
  assert.equal((await run(['--config', path], env)).code, 2);
});
