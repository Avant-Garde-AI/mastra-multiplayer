import { Redis } from "ioredis";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { InMemoryTurnLease, type TurnLease } from "../src/concurrency/lease.js";
import { RedisTurnLease } from "../src/concurrency/redis-lease.js";

const REDIS_URL = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6399";
const connections: Redis[] = [];

const redisAvailable = await (async () => {
  try {
    const probe = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
      retryStrategy: () => null,
    });
    await probe.ping();
    await probe.quit();
    return true;
  } catch {
    return false;
  }
})();

if (!redisAvailable && process.env.CI) {
  throw new Error(`Redis unreachable at ${REDIS_URL}; CI must not skip these.`);
}

afterEach(async () => {
  if (!redisAvailable) return;
  const cleaner = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  const keys = await cleaner.keys("ltest:*");
  if (keys.length > 0) await cleaner.del(...keys);
  await cleaner.quit();
});

afterAll(async () => {
  await Promise.all(connections.map((c) => c.quit().catch(() => {})));
});

/**
 * One battery, both implementations — the same reasoning as the storage
 * conformance suite. A lease whose semantics differ between backends is a lease
 * that only works on the backend it was tested against.
 */
function leaseContract(name: string, make: () => TurnLease, enabled = true) {
  describe.runIf(enabled)(name, () => {
    const sessionId = "s1";

    it("grants an unheld lease", async () => {
      expect(await make().acquire(sessionId, "a", 1000)).toBe(true);
    });

    it("refuses a lease another holder has", async () => {
      const lease = make();
      await lease.acquire(sessionId, "a", 1000);
      expect(await lease.acquire(sessionId, "b", 1000)).toBe(false);
    });

    it("grants it again after release", async () => {
      const lease = make();
      await lease.acquire(sessionId, "a", 1000);
      await lease.release(sessionId, "a");
      expect(await lease.acquire(sessionId, "b", 1000)).toBe(true);
    });

    it("grants it again after expiry", async () => {
      const lease = make();
      await lease.acquire(sessionId, "a", 100);
      await new Promise((r) => setTimeout(r, 150));
      expect(await lease.acquire(sessionId, "b", 1000)).toBe(true);
    });

    it("keeps sessions independent", async () => {
      const lease = make();
      await lease.acquire("s1", "a", 1000);
      expect(await lease.acquire("s2", "b", 1000)).toBe(true);
    });

    describe("ownership", () => {
      it("does not let a stale holder release someone else's lease", async () => {
        // The dangerous case. A holds the lease, stalls past its TTL; B takes
        // it and starts running; A finally finishes and calls release. A
        // release that does not check ownership frees B's lease mid-run, and a
        // third instance can start a concurrent turn — the exact failure the
        // lease exists to prevent, reintroduced by the cleanup path.
        const lease = make();
        await lease.acquire(sessionId, "a", 100);
        await new Promise((r) => setTimeout(r, 150));
        expect(await lease.acquire(sessionId, "b", 5000)).toBe(true);

        await lease.release(sessionId, "a");

        expect(await lease.acquire(sessionId, "c", 1000)).toBe(false);
      });

      it("does not let a stale holder renew someone else's lease", async () => {
        const lease = make();
        await lease.acquire(sessionId, "a", 100);
        await new Promise((r) => setTimeout(r, 150));
        await lease.acquire(sessionId, "b", 5000);

        expect(await lease.renew(sessionId, "a", 60_000)).toBe(false);
      });

      it("renews a lease the holder still owns", async () => {
        const lease = make();
        await lease.acquire(sessionId, "a", 200);
        expect(await lease.renew(sessionId, "a", 5000)).toBe(true);

        await new Promise((r) => setTimeout(r, 250));
        // Still held: the renewal extended it past the original expiry.
        expect(await lease.acquire(sessionId, "b", 1000)).toBe(false);
      });

      it("reports a lost lease rather than silently re-taking it", async () => {
        // `renew` returning false is what tells a running turn to abort.
        const lease = make();
        await lease.acquire(sessionId, "a", 100);
        await new Promise((r) => setTimeout(r, 150));

        expect(await lease.renew(sessionId, "a", 1000)).toBe(false);
      });

      it("releases nothing when the caller never held it", async () => {
        const lease = make();
        await lease.acquire(sessionId, "a", 5000);
        await lease.release(sessionId, "never-held-it");

        expect(await lease.acquire(sessionId, "c", 1000)).toBe(false);
      });
    });
  });
}

leaseContract("InMemoryTurnLease", () => new InMemoryTurnLease());

leaseContract(
  "RedisTurnLease",
  () => {
    const client = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    connections.push(client);
    return new RedisTurnLease(client, { keyPrefix: "ltest" });
  },
  redisAvailable,
);
