import { randomUUID } from 'node:crypto';

export type CapabilityStatus = 'implemented' | 'unsupported' | 'experimental' | 'unverified';
export interface Capability {
  readonly action: string;
  readonly status: CapabilityStatus;
  readonly description?: string;
}

function requireName(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new TypeError(`${label} must be a nonempty, unpadded string`);
  }
}

export class CapabilityRegistry {
  private readonly entries = new Map<string, Readonly<Capability>>();

  register(capability: Capability): void {
    requireName(capability.action, 'action');
    if (!['implemented', 'unsupported', 'experimental', 'unverified'].includes(capability.status)) {
      throw new TypeError('Invalid capability status');
    }
    if (this.entries.has(capability.action)) throw new Error(`Duplicate action: ${capability.action}`);
    this.entries.set(capability.action, Object.freeze({ ...capability }));
  }

  get(action: string): Readonly<Capability> | undefined { return this.entries.get(action); }
  list(): readonly Readonly<Capability>[] { return Object.freeze([...this.entries.values()]); }
}

/** Accepted means queued by the driver. Confirmed requires a driver receipt, not recipient delivery. */
export type DriverOutcome =
  | { readonly state: 'accepted'; readonly receipt?: string }
  | { readonly state: 'confirmed'; readonly receipt: string }
  | { readonly state: 'failed' | 'unknown'; readonly reason: string };

export interface DriverRequest {
  readonly operationId: string;
  readonly accountId: string;
  readonly generation: number;
  readonly action: string;
  readonly payload: unknown;
}

export interface BackendDriver {
  readonly id: string;
  readonly capabilities: readonly string[];
  execute(request: DriverRequest): Promise<DriverOutcome>;
}

export interface SessionSnapshot {
  readonly accountId: string;
  readonly backendId: string;
  readonly generation: number;
}

export interface DispatchRequest {
  readonly accountId: string;
  readonly action: string;
  readonly payload?: unknown;
  readonly expectedGeneration?: number;
}

export type OperationResult = DriverOutcome & {
  readonly operationId: string;
  readonly accountId: string;
  readonly action: string;
  readonly backendId: string | null;
  readonly generation: number | null;
};

interface Session {
  readonly snapshot: Readonly<SessionSnapshot>;
  readonly driver: BackendDriver;
  readonly capabilities: ReadonlySet<string>;
}

/** In-memory, single-process fencing. Switching cannot undo a request already sent by a driver. */
export class OperationCoordinator {
  private readonly sessions = new Map<string, Session>();
  private readonly generations = new Map<string, number>();

  constructor(private readonly registry: CapabilityRegistry) {}

  activate(accountId: string, driver: BackendDriver): Readonly<SessionSnapshot> {
    requireName(accountId, 'accountId');
    requireName(driver.id, 'backendId');
    for (const action of driver.capabilities) requireName(action, 'action');
    const generation = this.advance(accountId);
    const snapshot = Object.freeze({ accountId, backendId: driver.id, generation });
    this.sessions.set(accountId, { snapshot, driver, capabilities: new Set(driver.capabilities) });
    return snapshot;
  }

  deactivate(accountId: string): void {
    requireName(accountId, 'accountId');
    this.advance(accountId);
    this.sessions.delete(accountId);
  }

  session(accountId: string): Readonly<SessionSnapshot> | undefined {
    return this.sessions.get(accountId)?.snapshot;
  }

  private advance(accountId: string): number {
    const next = (this.generations.get(accountId) ?? 0) + 1;
    if (!Number.isSafeInteger(next)) throw new Error('Session generation exhausted');
    this.generations.set(accountId, next);
    return next;
  }

  async dispatch(request: DispatchRequest): Promise<OperationResult> {
    // Copy routing fields before yielding so callers cannot retarget a queued operation.
    const { accountId, action, payload, expectedGeneration } = request;
    requireName(accountId, 'accountId');
    requireName(action, 'action');
    const session = this.sessions.get(accountId);
    const identity = {
      operationId: randomUUID(), accountId, action,
      backendId: session?.snapshot.backendId ?? null,
      generation: session?.snapshot.generation ?? null,
    };
    const finish = (outcome: DriverOutcome): OperationResult => Object.freeze({ ...identity, ...outcome });
    const fail = (reason: string): OperationResult => finish({ state: 'failed', reason });
    const capability = this.registry.get(action);
    if (!capability) return fail('capability_not_registered');
    if (capability.status !== 'implemented') return fail(`capability_${capability.status}`);
    if (!session) return fail('no_active_backend');
    if (!session.capabilities.has(action)) return fail('backend_unsupported');
    if (expectedGeneration !== undefined && expectedGeneration !== session.snapshot.generation) {
      return fail('stale_generation');
    }
    const current = (): boolean => this.sessions.get(accountId) === session;
    await Promise.resolve();
    if (!current()) return fail('session_changed_before_dispatch');

    let outcome: DriverOutcome;
    try {
      // Exactly one invocation. An exception may follow a remote side effect: never retry here.
      outcome = await session.driver.execute(Object.freeze({
        operationId: identity.operationId, accountId, action,
        generation: session.snapshot.generation, payload,
      }));
    } catch {
      return finish({ state: 'unknown', reason: 'driver_exception_outcome_unknown' });
    }
    if (!current()) return finish({ state: 'unknown', reason: 'session_changed_during_dispatch' });

    // Runtime checks protect callers from malformed adapter responses; strip all extra properties.
    if (outcome && outcome.state === 'confirmed' && typeof outcome.receipt === 'string' && outcome.receipt.trim()) {
      return finish({ state: 'confirmed', receipt: outcome.receipt });
    }
    if (outcome && outcome.state === 'accepted') {
      if (outcome.receipt === undefined) return finish({ state: 'accepted' });
      if (typeof outcome.receipt === 'string' && outcome.receipt.trim()) {
        return finish({ state: 'accepted', receipt: outcome.receipt });
      }
    }
    if (outcome && (outcome.state === 'failed' || outcome.state === 'unknown') &&
        typeof outcome.reason === 'string' && outcome.reason.trim()) {
      return finish({ state: outcome.state, reason: outcome.reason });
    }
    return finish({ state: 'unknown', reason: 'invalid_driver_outcome' });
  }
}
