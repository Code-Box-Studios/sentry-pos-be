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
