import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { OneBotProbeError, probeOneBot, type ProbeErrorCode } from '../src/onebot-http.js';

interface RequestRecord {
  path: string;
  method: string;
  authorization: string | undefined;
  body: string;
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function server(t: TestContext, handler: Handler): Promise<string> {
  const instance = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    instance.once('error', reject);
    instance.listen(0, '127.0.0.1', () => {
      instance.off('error', reject);
      resolve();
    });
  });
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      instance.close((error) => (error ? reject(error) : resolve()));
    });
  });
  const address = instance.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function json(response: ServerResponse, data: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
}

function code(expected: ProbeErrorCode, secret = 'never-print-this-secret'): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof OneBotProbeError);
    assert.equal(error.code, expected);
    assert.equal(error.name, 'OneBotProbeError');
    assert.ok(!String(error).includes(secret));
    assert.ok(!JSON.stringify(error).includes(secret));
    assert.ok(!String(error).includes('127.0.0.1'));
    assert.equal(error.cause, undefined);
    return true;
  };
}

const allowedActions = ['get_version_info', 'get_status', 'get_login_info'];

function answers(action: string, backend = 'NapCat.Onebot'): unknown {
  if (action === 'get_version_info') return { app_name: backend, app_version: '2.4.2' };
  if (action === 'get_status') return { online: true, good: true };
  if (action === 'get_login_info') return { user_id: 10001, nickname: 'Test' };
  assert.fail(`Unexpected action ${action}`);
}

for (const backend of ['NapCat.Onebot', 'SnowLuma']) {
  test(`probes ${backend} through a subpath using only read-only actions`, async (t) => {
    const records: RequestRecord[] = [];
    const base = await server(t, (request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        records.push({
          path: request.url ?? '',
          method: request.method ?? '',
          authorization: request.headers.authorization,
          body,
        });
        const action = request.url?.split('/').at(-1) ?? '';
        json(response, answers(action, backend));
      });
    });
    const result = await probeOneBot({ url: `${base}/onebot/v11`, token: 'test-token' });
    assert.deepEqual(result.backend, { name: backend, version: '2.4.2' });
    assert.deepEqual(result.health, { transport: true, online: true, good: true });
    assert.deepEqual(result.account, { id: '10001' });
    assert.ok(Number.isFinite(Date.parse(result.observedAt)));
    assert.deepEqual(records, allowedActions.map((action) => ({
      path: `/onebot/v11/${action}`,
      method: 'POST',
      authorization: 'Bearer test-token',
      body: '{}',
    })));
  });
}

test('unknown health is null, absent account is omitted, and no token header is invented', async (t) => {
  const base = await server(t, (request, response) => {
    assert.equal(request.headers.authorization, undefined);
    if (request.url === '/get_version_info') json(response, answers('get_version_info'));
    else if (request.url === '/get_status') json(response, { good: null });
    else json(response, { user_id: '0' });
  });
  const result = await probeOneBot({ url: `${base}/` });
  assert.deepEqual(result.health, { transport: true, online: null, good: null });
  assert.equal('account' in result, false);
});

test('explicit offline stays false and decimal account ids are preserved without number coercion', async (t) => {
  const base = await server(t, (request, response) => {
    if (request.url === '/get_version_info') json(response, answers('get_version_info'));
    else if (request.url === '/get_status') json(response, { online: false, good: false });
    else json(response, { user_id: '9007199254740993' });
  });
  const result = await probeOneBot({ url: base });
  assert.deepEqual(result.health, { transport: true, online: false, good: false });
  assert.deepEqual(result.account, { id: '9007199254740993' });
});

for (const status of [401, 403, 500]) {
  test(`rejects HTTP ${status} without exposing the body or retrying`, async (t) => {
    let calls = 0;
    const base = await server(t, (_request, response) => {
      calls += 1;
      response.writeHead(status);
      response.end('never-print-this-secret');
    });
    await assert.rejects(probeOneBot({ url: base }), code(status === 500 ? 'HTTP_ERROR' : 'UNAUTHORIZED'));
    assert.equal(calls, 1);
  });
}

for (const [envelope, expected] of [
  [{ status: 'async', retcode: 1, data: {} }, 'ASYNC_RESPONSE'],
  [{ status: 'failed', retcode: 100, wording: 'never-print-this-secret' }, 'ACTION_FAILED'],
  [{ status: 'ok', retcode: 100, data: {} }, 'ACTION_FAILED'],
  [{ status: 'ok', retcode: '0', data: {} }, 'INVALID_RESPONSE'],
  [{ status: 'ok', data: {} }, 'INVALID_RESPONSE'],
  [{ retcode: 0, data: {} }, 'INVALID_RESPONSE'],
  [{ status: 'ok', retcode: 0, data: [] }, 'INVALID_RESPONSE'],
  [{ status: 'ok', retcode: 0, data: null }, 'INVALID_RESPONSE'],
  [{ status: 'ok', retcode: 0, data: { app_name: 'NapCat', app_version: 1 } }, 'INVALID_RESPONSE'],
  [null, 'INVALID_RESPONSE'],
] as const) {
  test(`rejects invalid envelope ${JSON.stringify(envelope)}`, async (t) => {
    let calls = 0;
    const base = await server(t, (_request, response) => {
      calls += 1;
      response.end(JSON.stringify(envelope));
    });
    await assert.rejects(probeOneBot({ url: base }), code(expected));
    assert.equal(calls, 1);
  });
}

for (const data of [{ online: 'true' }, { good: 1 }, { online: [] }]) {
  test(`rejects nonboolean health ${JSON.stringify(data)}`, async (t) => {
    const actions: string[] = [];
    const base = await server(t, (request, response) => {
      actions.push(request.url ?? '');
      json(response, request.url === '/get_version_info' ? answers('get_version_info') : data);
    });
    await assert.rejects(probeOneBot({ url: base }), code('INVALID_RESPONSE'));
    assert.deepEqual(actions, ['/get_version_info', '/get_status']);
  });
}

for (const userId of [-1, 1.5, 9007199254740992, 'not-an-id', '', true]) {
  test(`rejects invalid account id ${JSON.stringify(userId)}`, async (t) => {
    const base = await server(t, (request, response) => {
      const action = request.url?.slice(1) ?? '';
      json(response, action === 'get_login_info' ? { user_id: userId } : answers(action));
    });
    await assert.rejects(probeOneBot({ url: base }), code('INVALID_RESPONSE'));
  });
}

test('rejects non-JSON and malformed UTF-8 with safe messages', async (t) => {
  for (const body of ['<html>never-print-this-secret</html>', Buffer.from([0xff, 0xfe])]) {
    const base = await server(t, (_request, response) => { response.end(body); });
    await assert.rejects(probeOneBot({ url: base }), code('INVALID_JSON'));
  }
});

test('rejects an oversized declared response before reading it', async (t) => {
  const base = await server(t, (_request, response) => {
    response.writeHead(200, { 'content-length': String(1024 * 1024 + 1) });
    response.flushHeaders();
  });
  await assert.rejects(probeOneBot({ url: base }), code('RESPONSE_TOO_LARGE'));
});

test('bounds chunked responses even without a content-length header', async (t) => {
  const base = await server(t, (_request, response) => {
    response.writeHead(200, { 'transfer-encoding': 'chunked' });
    response.write(' '.repeat(1024 * 1024));
    response.end('x');
  });
  await assert.rejects(probeOneBot({ url: base }), code('RESPONSE_TOO_LARGE'));
});

test('deadline covers a response body that never completes', async (t) => {
  const base = await server(t, (_request, response) => {
    response.writeHead(200);
    response.write('{');
  });
  await assert.rejects(probeOneBot({ url: base, timeoutMs: 50 }), code('TIMEOUT'));
});

test('one deadline bounds the complete sequence, with no per-action timeout reset', async (t) => {
  let calls = 0;
  const base = await server(t, (request, response) => {
    calls += 1;
    const action = request.url?.slice(1) ?? '';
    void sleep(80).then(() => { if (!response.destroyed) json(response, answers(action)); });
  });
  await assert.rejects(probeOneBot({ url: base, timeoutMs: 140 }), code('TIMEOUT'));
  assert.ok(calls < 3);
});

test('redirect:error stops at the origin and never leaks the token to the redirect target', async (t) => {
  let targetCalls = 0;
  let originCalls = 0;
  const target = await server(t, (_request, response) => {
    targetCalls += 1;
    json(response, answers('get_version_info'));
  });
  const origin = await server(t, (_request, response) => {
    originCalls += 1;
    response.writeHead(302, { location: `${target}/never-print-this-secret` });
    response.end();
  });
  // Native Fetch does not expose a redirect Response in redirect:error mode.
  await assert.rejects(probeOneBot({ url: origin, token: 'never-print-this-secret' }), code('NETWORK_ERROR'));
  assert.equal(originCalls, 1);
  assert.equal(targetCalls, 0);
});

test('rejects URLs with credentials, queries, fragments, or non-HTTP protocols before any request', async (t) => {
  let calls = 0;
  const base = await server(t, (_request, response) => { calls += 1; response.end(); });
  for (const url of [
    base.replace('http://', 'http://user:never-print-this-secret@'),
    `${base}?token=never-print-this-secret`, `${base}?`, `${base}#fragment`, `${base}#`,
    `ftp://${base.slice('http://'.length)}`, 'file:///tmp/x', 'not-a-url', ` ${base}`,
  ]) {
    await assert.rejects(probeOneBot({ url }), code('INVALID_URL'));
  }
  assert.equal(calls, 0);
});

test('rejects unsafe header tokens and unbounded deadlines before any request', async (t) => {
  let calls = 0;
  const base = await server(t, (_request, response) => { calls += 1; response.end(); });
  for (const token of ['', 'line\r\nbreak', 'space token', '\u00e9']) {
    await assert.rejects(probeOneBot({ url: base, token }), code('INVALID_TOKEN'));
  }
  for (const timeoutMs of [0, -1, 1.5, 60001, Infinity, NaN]) {
    await assert.rejects(probeOneBot({ url: base, timeoutMs }), code('INVALID_TIMEOUT'));
  }
  assert.equal(calls, 0);
});
