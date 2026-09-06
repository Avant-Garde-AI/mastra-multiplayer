import { Redis } from "ioredis";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { RedisEventBus } from "../src/bus/redis.js";
import type { MultiplayerEvent } from "../src/bus/events.js";

const REDIS_URL = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6399";

const connections: Redis[] = [];
function connect(): Redis {
  const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: false });
  connections.push(client);
  return client;
}

/** A bus backed by its own pair of connections — one process, in effect. */
function bus(options: { replayBufferSize?: number; keyPrefix?: string } = {}) {
  return new RedisEventBus({
    client: connect(),
    subscriber: connect(),
    keyPrefix: options.keyPrefix ?? "test",
    ...(options.replayBufferSize === undefined
      ? {}
      : { replayBufferSize: options.replayBufferSize }),
  });
}

const message = (sessionId: string, text: string) =>
  ({ type: "message", sessionId, participantId: "alice", text, fromAgent: false }) as const;

/** Waits for a condition, so tests never depend on a fixed sleep. */
async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for events");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Probed at module load, not in `beforeAll` — `describe.runIf` is evaluated when
 * the file is collected, which happens first.
 *
 * A contributor without Redis gets a skip rather than twenty failures. CI does
 * not: it runs a Redis service, and a silent skip there would quietly delete
 * the only coverage of the guarantee this bus exists to provide.
 */
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

if (!available) {
  const message =
    `Redis is not reachable at ${REDIS_URL}. ` +
    `Start one with \`redis-server --port 6399\` to run the RedisEventBus tests.`;
  if (process.env.CI) throw new Error(`${message} CI must not skip them.`);
  console.warn(`[skipped] ${message}`);
}

afterEach(async () => {
  if (!available) return;
  const cleaner = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  const keys = await cleaner.keys("test:*");
  if (keys.length > 0) await cleaner.del(...keys);
  await cleaner.quit();
});

afterAll(async () => {
  await Promise.all(connections.map((c) => c.quit().catch(() => {})));
});

describe.runIf(available)("RedisEventBus", () => {
  describe("sequencing", () => {
    it("assigns monotonic sequences per session", async () => {
      const b = bus();
      expect((await b.publish(message("s1", "one"))).seq).toBe(1);
      expect((await b.publish(message("s1", "two"))).seq).toBe(2);
      expect((await b.publish(message("s2", "other"))).seq).toBe(1);
    });

    it("never issues the same sequence twice across two instances", async () => {
      // The failure this class exists to prevent. Clients discard anything at
      // or below the highest seq they have seen, so a duplicate makes them drop
      // a real event while believing it was a repeat — invisible from outside.
      const a = bus();
      const b = bus();

      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          (i % 2 === 0 ? a : b).publish(message("s1", `m${i}`)),
        ),
      );

      const seqs = results.map((e) => e.seq).sort((x, y) => x - y);
      expect(new Set(seqs).size).toBe(100);
      expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    });

    it("ignores a caller-supplied seq", async () => {
      // Honouring it would break the only guarantee this class provides.
      const b = bus();
      const event = await b.publish({ ...message("s1", "one"), seq: 999 } as never);
      expect(event.seq).toBe(1);
    });

    it("reports the sequence a snapshot is consistent with", async () => {
      const b = bus();
      expect(await b.currentSeq("s1")).toBe(0);
      await b.publish(message("s1", "one"));
      await b.publish(message("s1", "two"));

      expect(await b.currentSeq("s1")).toBe(2);
      expect(await b.replay("s1", await b.currentSeq("s1"))).toEqual([]);
    });
  });

  describe("fan-out", () => {
    it("delivers an event published on one instance to a subscriber on another", async () => {
      // Two instances are two server processes. This is the whole point.
      const publisher = bus();
      const listener = bus();

      const seen: MultiplayerEvent[] = [];
      await listener.subscribeFrom("s1", 0, (event) => seen.push(event));

      await publisher.publish(message("s1", "from the other process"));
      await until(() => seen.length === 1);

      expect(seen[0]).toMatchObject({
        type: "message",
        text: "from the other process",
        seq: 1,
      });
    });

    it("delivers in sequence order under concurrent publishers", async () => {
      const a = bus();
      const b = bus();
      const listener = bus();

      const seen: MultiplayerEvent[] = [];
      await listener.subscribeFrom("s1", 0, (event) => seen.push(event));

      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          (i % 2 === 0 ? a : b).publish(message("s1", `m${i}`)),
        ),
      );
      await until(() => seen.length === 50);

      // Redis processes the publish script under one lock, so the channel order
      // is the sequence order.
      expect(seen.map((e) => e.seq)).toEqual(
        Array.from({ length: 50 }, (_, i) => i + 1),
      );
    });

    it("does not fan out across sessions", async () => {
      const publisher = bus();
      const listener = bus();

      const seen: string[] = [];
      await listener.subscribeFrom("s1", 0, (event) => seen.push(event.sessionId));

      await publisher.publish(message("s2", "elsewhere"));
      await publisher.publish(message("s1", "here"));
      await until(() => seen.length === 1);

      expect(seen).toEqual(["s1"]);
    });

    it("stops delivering after unsubscribe", async () => {
      const publisher = bus();
      const listener = bus();

      const seen: string[] = [];
      const off = await listener.subscribeFrom("s1", 0, (e) => seen.push(e.type));

      await publisher.publish(message("s1", "one"));
      await until(() => seen.length === 1);

      off();
      expect(listener.subscriberCount("s1")).toBe(0);

      await publisher.publish(message("s1", "two"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(seen).toHaveLength(1);
    });

    it("keeps delivering to the other subscribers when one throws", async () => {
      const errors: string[] = [];
      const listener = new RedisEventBus({
        client: connect(),
        subscriber: connect(),
        keyPrefix: "test",
        onError: (_, context) => errors.push(context),
      });

      const delivered: string[] = [];
      await listener.subscribeFrom("s1", 0, () => {
        throw new Error("bad subscriber");
      });
      listener.subscribe("s1", (event) => delivered.push(event.type));

      await bus().publish(message("s1", "one"));
      await until(() => delivered.length === 1);

      expect(delivered).toEqual(["message"]);
      expect(errors).toContain("subscriber threw");
    });
  });

  describe("replay", () => {
    it("returns only what a client missed", async () => {
      const b = bus();
      await b.publish(message("s1", "one"));
      await b.publish(message("s1", "two"));
      await b.publish(message("s1", "three"));

      expect((await b.replay("s1", 1)).map((e) => e.seq)).toEqual([2, 3]);
    });

    it("is readable from another instance", async () => {
      // A client reconnecting through a load balancer lands anywhere.
      const publisher = bus();
      await publisher.publish(message("s1", "one"));
      await publisher.publish(message("s1", "two"));

      expect((await bus().replay("s1", 0)).map((e) => e.seq)).toEqual([1, 2]);
    });

    it("bounds the buffer and keeps the newest events", async () => {
      const b = bus({ replayBufferSize: 3 });
      for (let i = 1; i <= 10; i++) await b.publish(message("s1", `m${i}`));

      expect((await b.replay("s1")).map((e) => e.seq)).toEqual([8, 9, 10]);
    });

    it("keeps sequencing when replay is disabled", async () => {
      const b = bus({ replayBufferSize: 0 });
      await b.publish(message("s1", "one"));

      expect((await b.publish(message("s1", "two"))).seq).toBe(2);
      expect(await b.replay("s1")).toEqual([]);
    });

    it("preserves an empty array in a payload", async () => {
      // `presence.updated` legitimately carries an empty roster. A Lua script
      // that decoded and re-encoded the payload with cjson would turn `[]` into
      // `{}` and break the client's reducer.
      const b = bus();
      await b.publish({ type: "presence.updated", sessionId: "s1", presence: [] });

      const [event] = await b.replay("s1");
      expect(Array.isArray((event as { presence: unknown[] }).presence)).toBe(true);
      expect((event as { presence: unknown[] }).presence).toEqual([]);
    });
  });

  describe("subscribeFrom", () => {
    it("replays and goes live with no gap between them", async () => {
      const publisher = bus();
      const listener = bus();

      await publisher.publish(message("s1", "before-1"));
      await publisher.publish(message("s1", "before-2"));

      const seen: number[] = [];
      await listener.subscribeFrom("s1", 0, (event) => seen.push(event.seq));

      await publisher.publish(message("s1", "after"));
      await until(() => seen.length === 3);

      expect(seen).toEqual([1, 2, 3]);
    });

    it("delivers an event that lands while the replay is being read", async () => {
      // The gap `subscribeFrom` exists to close, forced rather than raced: the
      // replay read is held open, an event is published, and the read is then
      // released. Replaying before subscribing loses that event entirely;
      // subscribing before replaying delivers it ahead of the older ones, and a
      // client tracking the highest seq it has seen discards the replay.
      const publisher = bus();
      const listener = bus();

      await publisher.publish(message("s1", "before"));

      let release!: () => void;
      let readTheList!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const hasRead = new Promise<void>((resolve) => {
        readTheList = resolve;
      });

      const realReplay = listener.replay.bind(listener);
      listener.replay = async (sessionId, afterSeq) => {
        const events = await realReplay(sessionId, afterSeq);
        readTheList();
        await held;
        return events;
      };

      const seen: string[] = [];
      const subscribing = listener.subscribeFrom("s1", 0, (event) => {
        seen.push((event as { text?: string }).text ?? event.type);
      });

      // Strictly after the replay list has been read, and strictly before
      // `subscribeFrom` returns. Publishing any earlier lands the event in the
      // replay itself, which is a different case and lets the bug through.
      await hasRead;
      await publisher.publish(message("s1", "during"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      await subscribing;

      await until(() => seen.length === 2);
      expect(seen).toEqual(["before", "during"]);
    });

    it("does not deliver an event twice when it lands mid-replay", async () => {
      // The event is both in the replay list and on the live channel. A naive
      // implementation delivers it once from each.
      const publisher = bus();
      const listener = bus();

      for (let i = 0; i < 20; i++) await publisher.publish(message("s1", `m${i}`));

      const seen: number[] = [];
      const subscribing = listener.subscribeFrom("s1", 0, (e) => seen.push(e.seq));
      // Published while the replay read is in flight.
      await publisher.publish(message("s1", "concurrent"));
      await subscribing;

      await until(() => seen.length >= 21);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual([...seen].sort((a, b) => a - b));
    });

    it("honours afterSeq so a reconnecting client sees no duplicates", async () => {
      const publisher = bus();
      const listener = bus();

      for (let i = 1; i <= 5; i++) await publisher.publish(message("s1", `m${i}`));

      const seen: number[] = [];
      await listener.subscribeFrom("s1", 3, (event) => seen.push(event.seq));
      await until(() => seen.length === 2);

      expect(seen).toEqual([4, 5]);
    });
  });

  describe("clear", () => {
    it("drops the sequence, the buffer, and local subscribers", async () => {
      const b = bus();
      await b.publish(message("s1", "one"));
      b.subscribe("s1", () => {});

      await b.clear("s1");

      expect(await b.currentSeq("s1")).toBe(0);
      expect(await b.replay("s1")).toEqual([]);
      expect(b.subscriberCount("s1")).toBe(0);
    });
  });

  describe("key namespacing", () => {
    it("keeps two prefixes apart on one Redis", async () => {
      const tenantA = bus({ keyPrefix: "test:a" });
      const tenantB = bus({ keyPrefix: "test:b" });

      await tenantA.publish(message("s1", "a"));
      await tenantA.publish(message("s1", "a2"));

      expect(await tenantB.currentSeq("s1")).toBe(0);
      expect(await tenantB.replay("s1")).toEqual([]);
    });
  });
});
