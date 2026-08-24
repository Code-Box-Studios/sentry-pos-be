import { AsyncLocalStorage } from 'async_hooks';

export type Scope = 'platform' | 'tenant';

export interface RequestContext {
  requestId: string;
  scope: Scope | null; // null until a guard authenticates
  actor: { type: 'platform_admin' | 'owner' | 'terminal'; id: string } | null;
  ownerId: string | null; // tenant scope: the BO who owns everything queried
  businessId: string | null; // set for terminal requests (and portal routes that carry one)
  branchId: string | null; // set for terminal requests
  terminalCode: string | null;
  sessionId: string | null; // §11 "session/token id"
  ip: string;
  userAgent: string;
  deviceTimestamp: string | null; // X-Device-Timestamp header (terminal requests)

  /**
   * Active interactive-transaction client, registered by services that open
   * their OWN `$transaction` (Tasks 19/20). When set, the tenancy/audit
   * extension (Task 4) runs the mutation AND its audit insert on THIS client
   * so the audit row commits/rolls back atomically with the mutation. When
   * unset, the extension opens its own transaction per standalone mutation.
   *
   * Typed as `unknown` deliberately: the concrete Prisma transaction-client
   * type lives downstream of this module; the extension narrows it internally.
   */
  txClient?: unknown;

  /**
   * Per-request memoization slot for the extension's scope lookups
   * (owner→businessId set, owner→branchId set, branch→business resolution).
   * Keyed by cache name; opaque to everything but the extension.
   */
  scopeCache?: Map<string, unknown>;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Returns the current request context.
 * Throws if called outside a requestContext.run() scope.
 */
export function getContext(): RequestContext {
  const store = requestContext.getStore();
  if (store === undefined) {
    throw new Error('getContext() called outside a request context');
  }
  return store;
}

/**
 * Merges `patch` into the current request context store.
 * Must be called inside a requestContext.run() scope (e.g., from an auth guard).
 */
export function setAuthContext(patch: Partial<RequestContext>): void {
  const store = requestContext.getStore();
  if (store === undefined) {
    throw new Error('setAuthContext() called outside a request context');
  }
  Object.assign(store, patch);
}

/**
 * Registers the active interactive-transaction client on the current request
 * context so the tenancy/audit extension rides it for mutation + audit writes.
 * Services opening their own `$transaction` (Tasks 19/20) call this with the
 * transaction client, then clear it (pass `undefined`) when the callback ends.
 * Must be called inside a requestContext.run() scope.
 */
export function setTxClient(txClient: unknown): void {
  const store = requestContext.getStore();
  if (store === undefined) {
    throw new Error('setTxClient() called outside a request context');
  }
  store.txClient = txClient;
}

/**
 * Runs `fn` with `txClient` registered on the current context, guaranteeing the
 * previous value is restored afterwards (so nested/sequential transactions
 * don't leak their client). Returns whatever `fn` returns.
 */
export async function runWithTxClient<T>(
  txClient: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const store = requestContext.getStore();
  if (store === undefined) {
    throw new Error('runWithTxClient() called outside a request context');
  }
  const prev = store.txClient;
  store.txClient = txClient;
  try {
    return await fn();
  } finally {
    store.txClient = prev;
  }
}
