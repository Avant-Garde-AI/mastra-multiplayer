import { Redis } from "ioredis";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { RedisEventBus } from "../src/bus/redis.js";
import { RedisTurnLease } from "../src/concurrency/redis-lease.js";
import { createMultiplayer, type AgentLike } from "../src/session.js";
import { silentLogger } from "../src/internal/logger.js";
import { InMemoryMultiplayerStore } from "../src/storage/index.js";
import type { Participant } from "../src/types.js";

const REDIS_URL = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6399";
const connections: Redis[] = [];

const connect = () => {
  const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, retryStrategy: () => null });
  connections.push(client);
  return client;
};

const available = await (async () => {
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

if (!available && process.env.CI) {
  throw new Error(`Redis unreachable at ${REDIS_URL}; CI must not skip these.`);
}

const person = (id: string): Participant => ({
  id,
  displayName: id,
  role: "editor",
  surface: "web",
});

/** Streams slowly enough that two runs would visibly overlap. */
const slowAgent = (reply: string, perWordMs = 30): AgentLike => ({
  id: "support",
  async stream() {
    return {
      textStream: (async function* () {
        for (const word of reply.split(" ")) {
          await new Promise((r) => setTimeout(r, perWordMs));
          yield `${word} `;
        }
      })(),
    };
  },
});

/** One "server process": own store, own connections, sharing only Redis. */
function instance(reply: string, options: { lease?: boolean; perWordMs?: number } = {}) {
  return createMultiplayer({
    agent: slowAgent(reply, options.perWordMs ?? 30),
    store: new InMemoryMultiplayerStore(),
    bus: new RedisEventBus({
      client: connect(),
      subscriber: connect(),
      keyPrefix: "dtest",
    }),
    concurrency: {
      logger: silentLogger,
      ...(options.lease === false
        ? {}
        : {
            lease: new RedisTurnLease(connect(), { keyPrefix: "dtest" }),
            leaseTtlMs: 5_000,
            leaseRenewMs: 500,
            leaseRetryMs: 50,
          }),
    },
  });
}

async function seed(instances: ReturnType<typeof instance>[], sessionId: string) {
  for (const [i, mp] of instances.entries()) {
    if (i === 0) await mp.createSession({ threadId: "t1", id: sessionId });
    else
      await mp.store.createSession({
        id: sessionId,
        threadId: "t1",
        agentId: "support",
        createdAt: 1,
        updatedAt: 1,
      });
    await mp.join(sessionId, person(`p${i}`));
  }
}

const until = async (check: () => boolean, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

afterEach(async () => {
  if (!available) return;
  const cleaner = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  const keys = await cleaner.keys("dtest:*");
  if (keys.length > 0) await cleaner.del(...keys);
  await cleaner.quit();
});

afterAll(async () => {
  await Promise.all(connections.map((c) => c.quit().catch(() => {})));
});

describe.runIf(available)("turn-taking across instances", () => {
  describe("without a lease", () => {
    it("runs two turns at once — the gap the lease closes", async () => {
      // Kept as a test rather than a comment: it is the reason the lease
      // exists, and it fails loudly if someone makes the lease mandatory
      // without noticing.
      const a = instance("reply from A", { lease: false });
      const b = instance("reply from B", { lease: false });
      await seed([a, b], "s1");

      let concurrent = 0;
      let peak = 0;
      await a.bus.subscribeFrom("s1", await a.bus.currentSeq("s1"), (event) => {
        if (event.type === "agent.run.started") peak = Math.max(peak, ++concurrent);
        if (event.type === "agent.run.finished") concurrent--;
      });

      await Promise.all([
        a.send({ sessionId: "s1", participantId: "p0", text: "one" }),
        b.send({ sessionId: "s1", participantId: "p1", text: "two" }),
      ]);
      await until(() => concurrent === 0 && peak > 0);

      expect(peak).toBe(2);
    });
  });

  describe("with a lease", () => {
    it("serializes turns started on two instances at once", async () => {
      const a = instance("reply from A");
      const b = instance("reply from B");
      await seed([a, b], "s1");

      let concurrent = 0;
      let peak = 0;
      const finished: string[] = [];
      await a.bus.subscribeFrom("s1", await a.bus.currentSeq("s1"), (event) => {
        if (event.type === "agent.run.started") peak = Math.max(peak, ++concurrent);
        if (event.type === "agent.run.finished") {
          concurrent--;
          finished.push(event.runId);
        }
      });

      await Promise.all([
        a.send({ sessionId: "s1", participantId: "p0", text: "one" }),
        b.send({ sessionId: "s1", participantId: "p1", text: "two" }),
      ]);

      // Both messages are still owed a reply — the lease delays, it does not drop.
      await until(() => finished.length === 2);
      expect(peak).toBe(1);
    });

    it("does not drop the waiting instance's message", async () => {
      const a = instance("first");
      const b = instance("second");
      await seed([a, b], "s1");

      const replies: string[] = [];
      await a.bus.subscribeFrom("s1", await a.bus.currentSeq("s1"), (event) => {
        if (event.type === "message" && event.fromAgent) replies.push(event.text.trim());
      });

      await Promise.all([
        a.send({ sessionId: "s1", participantId: "p0", text: "one" }),
        b.send({ sessionId: "s1", participantId: "p1", text: "two" }),
      ]);
      await until(() => replies.length === 2);

      expect(replies.sort()).toEqual(["first", "second"]);
    });

    it("releases the lease so the next turn is not blocked", async () => {
      const a = instance("done");
      await seed([a], "s1");

      await a.send({ sessionId: "s1", participantId: "p0", text: "one" });
      await new Promise((r) => setTimeout(r, 200));

      // A second instance must be able to take the lease afterwards.
      const lease = new RedisTurnLease(connect(), { keyPrefix: "dtest" });
      expect(await lease.acquire("s1", "someone-else", 1000)).toBe(true);
    });

    it("hands the lease on when a holder crashes, once the TTL expires", async () => {
      // A held lease always carries an expiry, so a process that dies mid-turn
      // cannot wedge the session for ever.
      const lease = new RedisTurnLease(connect(), { keyPrefix: "dtest" });
      expect(await lease.acquire("s1", "crashed", 150)).toBe(true);
      expect(await lease.acquire("s1", "next", 1000)).toBe(false);

      await new Promise((r) => setTimeout(r, 200));
      expect(await lease.acquire("s1", "next", 1000)).toBe(true);
    });
  });

  describe("interrupt", () => {
    it("stops a run owned by another instance", async () => {
      // Before this, `interrupt()` aborted only locally while still publishing
      // `agent.run.interrupted` — so clients showed the run stopped and the
      // agent kept streaming.
      const a = instance("this reply keeps going for quite a while indeed", {
        perWordMs: 60,
      });
      const b = instance("unused");
      await seed([a, b], "s1");

      const deltas: string[] = [];
      await a.bus.subscribeFrom("s1", await a.bus.currentSeq("s1"), (event) => {
        if (event.type === "agent.delta") deltas.push(event.delta);
      });

      void a.send({ sessionId: "s1", participantId: "p0", text: "go" });
      await until(() => deltas.length >= 2);

      const atInterrupt = deltas.length;
      await b.interrupt("s1", "p1");

      // Allow one more delta for the one already in flight when the abort landed.
      await new Promise((r) => setTimeout(r, 400));
      expect(deltas.length).toBeLessThanOrEqual(atInterrupt + 1);
    });

    it("still stops a run owned by the same instance", async () => {
      const a = instance("this reply keeps going for quite a while indeed", {
        perWordMs: 60,
      });
      await seed([a], "s1");

      const deltas: string[] = [];
      await a.bus.subscribeFrom("s1", await a.bus.currentSeq("s1"), (event) => {
        if (event.type === "agent.delta") deltas.push(event.delta);
      });

      void a.send({ sessionId: "s1", participantId: "p0", text: "go" });
      await until(() => deltas.length >= 2);

      const atInterrupt = deltas.length;
      await a.interrupt("s1", "p0");
      await new Promise((r) => setTimeout(r, 400));

      expect(deltas.length).toBeLessThanOrEqual(atInterrupt + 1);
    });
  });
});
