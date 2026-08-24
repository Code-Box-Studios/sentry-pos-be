import { requestContext, getContext, setAuthContext } from './request-context';

describe('RequestContext (AsyncLocalStorage)', () => {
  describe('getContext() outside a run', () => {
    it('throws when called outside any requestContext.run', () => {
      expect(() => getContext()).toThrow(
        'getContext() called outside a request context',
      );
    });
  });

  describe('requestContext.run isolation', () => {
    it('two concurrent async chains each see their own context', async () => {
      // We use two Promise chains that interleave via setTimeout to confirm
      // AsyncLocalStorage provides true per-chain isolation, not just sequential.
      const resultsA: string[] = [];
      const resultsB: string[] = [];

      const chainA = new Promise<void>((resolve) => {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        requestContext.run(
          {
            requestId: 'req-A',
            scope: null,
            actor: null,
            ownerId: null,
            businessId: null,
            branchId: null,
            terminalCode: null,
            sessionId: null,
            ip: '1.1.1.1',
            userAgent: 'agent-A',
            deviceTimestamp: null,
          },
          async () => {
            resultsA.push(getContext().requestId); // immediate read
            await new Promise((r) => setTimeout(r, 10)); // yield to let chain B start
            resultsA.push(getContext().requestId); // read after yield
            resolve();
          },
        );
      });

      // Start chain B after a brief yield so both are alive concurrently
      await new Promise((r) => setTimeout(r, 5));

      const chainB = new Promise<void>((resolve) => {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        requestContext.run(
          {
            requestId: 'req-B',
            scope: null,
            actor: null,
            ownerId: null,
            businessId: null,
            branchId: null,
            terminalCode: null,
            sessionId: null,
            ip: '2.2.2.2',
            userAgent: 'agent-B',
            deviceTimestamp: null,
          },
          async () => {
            resultsB.push(getContext().requestId); // runs while chain A is mid-yield
            await new Promise((r) => setTimeout(r, 0));
            resultsB.push(getContext().requestId);
            resolve();
          },
        );
      });

      await Promise.all([chainA, chainB]);

      // Chain A must always read its own requestId
      expect(resultsA).toEqual(['req-A', 'req-A']);
      // Chain B must always read its own requestId
      expect(resultsB).toEqual(['req-B', 'req-B']);
    });
  });

  describe('setAuthContext', () => {
    it('mutates only the current store and does not bleed into a sibling chain', async () => {
      let ctxA_before_patch: string | null = null;
      let ctxA_after_peer_patch: string | null = null;
      let ctxB_after_patch: string | null = null;

      let barrierResolve: (value: unknown) => void = () => {};
      const barrierPromise = new Promise((res) => (barrierResolve = res));

      const chainA = new Promise<void>((resolve) => {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        requestContext.run(
          {
            requestId: 'req-setA',
            scope: null,
            actor: null,
            ownerId: null,
            businessId: null,
            branchId: null,
            terminalCode: null,
            sessionId: null,
            ip: '10.0.0.1',
            userAgent: 'ua-A',
            deviceTimestamp: null,
          },
          async () => {
            ctxA_before_patch = getContext().scope;
            // Wait until chain B has patched its own scope
            await barrierPromise;
            // Chain A's scope must still be null — unaffected by chain B's patch
            ctxA_after_peer_patch = getContext().scope;
            resolve();
          },
        );
      });

      const chainB = new Promise<void>((resolve) => {
        requestContext.run(
          {
            requestId: 'req-setB',
            scope: null,
            actor: null,
            ownerId: null,
            businessId: null,
            branchId: null,
            terminalCode: null,
            sessionId: null,
            ip: '10.0.0.2',
            userAgent: 'ua-B',
            deviceTimestamp: null,
          },
          () => {
            // Patch chain B's own scope
            setAuthContext({ scope: 'tenant' });
            ctxB_after_patch = getContext().scope;
            barrierResolve(undefined); // unblock chain A
            resolve();
          },
        );
      });

      await Promise.all([chainA, chainB]);

      expect(ctxA_before_patch).toBeNull();
      expect(ctxB_after_patch).toBe('tenant');
      // The critical assertion: chain B's patch must NOT have bled into chain A
      expect(ctxA_after_peer_patch).toBeNull();
    });
  });
});
