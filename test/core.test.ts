import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CapabilityRegistry, OperationCoordinator,
  type BackendDriver, type DriverOutcome, type DriverRequest,
} from '../src/core.js';

function setup() {
  const registry = new CapabilityRegistry();
  registry.register({ action: 'send_message', status: 'implemented' });
  return { registry, core: new OperationCoordinator(registry) };
}

function driver(id: string, execute: BackendDriver['execute']): BackendDriver {
  return { id, capabilities: ['send_message'], execute };
}

test('registry exposes immutable descriptions and rejects duplicate registration', () => {
  const { registry } = setup();
  assert.equal(registry.get('send_message')?.status, 'implemented');
  assert.equal(registry.get('missing'), undefined);
  assert.ok(Object.isFrozen(registry.list()));
  assert.ok(Object.isFrozen(registry.get('send_message')));
  assert.throws(() => registry.register({ action: 'send_message', status: 'unsupported' }), /Duplicate/);
});

test('unimplemented or unsupported actions never reach a driver', async () => {
  const { registry, core } = setup();
  let calls = 0;
  core.activate('a', driver('one', async () => { calls++; return { state: 'accepted' }; }));
  for (const status of ['unsupported', 'experimental', 'unverified'] as const) {
    registry.register({ action: status, status });
    const result = await core.dispatch({ accountId: 'a', action: status });
    assert.equal(result.state, 'failed');
  }
  assert.equal((await core.dispatch({ accountId: 'a', action: 'missing' })).state, 'failed');
  core.activate('a', { ...driver('none', async () => { calls++; return { state: 'accepted' }; }), capabilities: [] });
  assert.equal((await core.dispatch({ accountId: 'a', action: 'send_message' })).state, 'failed');
  assert.equal(calls, 0);
});

test('unknown responses and exceptions are never retried', async () => {
  const { core } = setup();
  let calls = 0;
  core.activate('a', driver('one', async () => {
    calls++;
    return { state: 'unknown', reason: 'transport_closed_after_write' };
  }));
  assert.equal((await core.dispatch({ accountId: 'a', action: 'send_message' })).state, 'unknown');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  core.activate('a', driver('two', async () => { calls++; throw new Error('connection lost'); }));
  assert.equal((await core.dispatch({ accountId: 'a', action: 'send_message' })).state, 'unknown');
  assert.equal(calls, 2);
});

test('switching before dispatch fences the previous generation', async () => {
  const { core } = setup();
  let calls = 0;
  const old = core.activate('a', driver('one', async () => { calls++; return { state: 'accepted' }; }));
  const pending = core.dispatch({ accountId: 'a', action: 'send_message' });
  const next = core.activate('a', driver('two', async () => { calls++; return { state: 'accepted' }; }));
  assert.ok(next.generation > old.generation);
  assert.equal((await pending).state, 'failed');
  assert.equal((await core.dispatch({ accountId: 'a', action: 'send_message', expectedGeneration: old.generation })).state, 'failed');
  assert.equal(calls, 0);
});

test('an in-flight old session cannot return confirmation after a switch', async () => {
  const { core } = setup();
  let resolve!: (value: DriverOutcome) => void;
  let calls = 0;
  core.activate('a', driver('one', async () => {
    calls++;
    return new Promise<DriverOutcome>(done => { resolve = done; });
  }));
  const pending = core.dispatch({ accountId: 'a', action: 'send_message' });
  await Promise.resolve();
  assert.equal(calls, 1);
  core.activate('a', driver('two', async () => { calls++; return { state: 'accepted' }; }));
  resolve({ state: 'confirmed', receipt: 'old-receipt' });
  assert.equal((await pending).state, 'unknown');
  assert.equal(calls, 1);
});

test('account generations and routing are isolated; deactivation cannot reuse an epoch', async () => {
  const { core } = setup();
  const seen: DriverRequest[] = [];
  const shared = driver('shared', async request => { seen.push(request); return { state: 'accepted' }; });
  const original = core.activate('a', shared);
  const b = core.activate('b', shared);
  const pending = core.dispatch({ accountId: 'b', action: 'send_message' });
  core.deactivate('a');
  assert.equal((await pending).state, 'accepted');
  assert.equal(core.session('b')?.generation, b.generation);
  assert.equal(seen[0]?.accountId, 'b');
  assert.equal((await core.dispatch({ accountId: 'a', action: 'send_message' })).state, 'failed');
  assert.ok(core.activate('a', shared).generation > original.generation);
});

test('accepted stays accepted; malformed confirmation never becomes success', async () => {
  const { core } = setup();
  const responses: DriverOutcome[] = [
    { state: 'accepted' }, { state: 'confirmed', receipt: '' },
    { state: 'confirmed', receipt: 'server-receipt' },
    { state: 'success' } as unknown as DriverOutcome,
    { state: 'failed', reason: 'explicit_rejection' },
  ];
  core.activate('a', driver('one', async () => responses.shift()!));
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await core.dispatch({ accountId: 'a', action: 'send_message' }));
  assert.deepEqual(results.map(result => result.state), ['accepted', 'unknown', 'confirmed', 'unknown', 'failed']);
  assert.equal(new Set(results.map(result => result.operationId)).size, 5);
});
