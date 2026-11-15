import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, parseConfig } from '../src/config.js';

test('resolves an explicitly named token without accepting inline secrets', () => {
  const input = { backend: { url: 'http://127.0.0.1:3000', tokenEnv: 'TEST_TOKEN' } };
  assert.deepEqual(parseConfig(input, { TEST_TOKEN: 'synthetic-token' }), {
    url: 'http://127.0.0.1:3000', token: 'synthetic-token', timeoutMs: 5000,
  });
  assert.throws(() => parseConfig(input, {}), ConfigError);
  assert.throws(() => parseConfig({ backend: { url: 'http://localhost', token: 'secret' } }), ConfigError);
});

test('rejects misspelled fields, invalid environment references and unbounded timeouts', () => {
  for (const input of [null, [], { backnd: {} }, { backend: {} },
    { backend: { url: 'http://localhost', tokenEnv: '../secret' } },
    ...[0, -1, 1.5, '5000', 60001].map(timeoutMs => ({ backend: { url: 'http://localhost' }, timeoutMs })),
  ]) assert.throws(() => parseConfig(input), ConfigError);
});
