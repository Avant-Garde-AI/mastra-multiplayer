import { Redis } from "ioredis";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { RedisEventBus } from "../src/bus/redis.js";
import { createMultiplayer, type AgentLike } from "../src/session.js";
import { InMemoryMultiplayerStore } from "../src/storage/index.js";
import type { MultiplayerEvent } from "../src/bus/events.js";
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

const fakeAgent = (reply: string): AgentLike => ({
  id: "support",
  async stream() {
    return {
      textStream: (async function* () {
        yield reply;
      })(),
    };
  },
});

const person = (id: string): Participant => ({
  id,
  displayName: id,
  role: "editor",
  surface: "web",
});

/**
 * One "server process": its own session object, its own store, its own pair of
 * Redis connections. Sharing only Redis is the point — that is what two pods
 * behind a load balancer actually share.
 */
function instance(reply = "ack") {
  return createMultiplayer({
    agent: fakeAgent(reply),
    store: new InMemoryMultiplayerStore(),
    bus: new RedisEventBus({
      client: connect(),
      subscriber: connect(),
      keyPrefix: "itest",
    }),
  });
}

const until = async (check: () => boolean, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

afterEach(async () => {
  if (!available) return;
  const cleaner = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  const keys = await cleaner.keys("itest:*");
  if (keys.length > 0) await cleaner.del(...keys);
  await cleaner.quit();
});

afterAll(async () => {
  await Promise.all(connections.map((c) => c.quit().catch(() => {})));
});

describe.runIf(available)("two instances sharing one Redis", () => {
  it("shows a message sent on one instance to a client watching the other", async () => {
    // The failure R1 fixes: before this, half the room saw a different
    // conversation depending on which pod they landed on.
    const a = instance();
    const b = instance();

    await a.createSession({ threadId: "t1", id: "s1" });
    await b.store.createSession({
      id: "s1",
      threadId: "t1",
      agentId: "support",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await a.join("s1", person("alice"));

    const seenOnB: MultiplayerEvent[] = [];
    await b.bus.subscribeFrom("s1", 0, (event) => seenOnB.push(event));

    await a.send({
      sessionId: "s1",
      participantId: "alice",
      text: "can we refund 4417?",
      addressedToAgent: false,
    });

    await until(() => seenOnB.some((e) => e.type === "message"));
    expect(
      seenOnB.filter((e): e is Extract<MultiplayerEvent, { type: "message" }> =>
        e.type === "message",
      )[0]?.text,
    ).toBe("can we refund 4417?");
  });

  it("streams an agent run started on one instance to the other", async () => {
    const a = instance("all done");
    const b = instance();

    await a.createSession({ threadId: "t1", id: "s1" });
    await a.join("s1", person("alice"));

    const seen: string[] = [];
    await b.bus.subscribeFrom("s1", 0, (event) => seen.push(event.type));

    await a.send({ sessionId: "s1", participantId: "alice", text: "go" });
    await until(() => seen.includes("agent.run.finished"));

    expect(seen).toContain("agent.run.started");
    expect(seen).toContain("agent.delta");
    expect(seen).toContain("agent.run.finished");
  });

  it("keeps one sequence across both instances", async () => {
    const a = instance();
    const b = instance();
    await a.createSession({ threadId: "t1", id: "s1" });
    await a.join("s1", person("alice"));
    await b.store.createSession({
      id: "s1",
      threadId: "t1",
      agentId: "support",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await b.join("s1", person("bob"));

    const seqs: number[] = [];
    await a.bus.subscribeFrom("s1", await a.bus.currentSeq("s1"), (e) => seqs.push(e.seq));

    for (let i = 0; i < 10; i++) {
      const target = i % 2 === 0 ? a : b;
      await target.send({
        sessionId: "s1",
        participantId: i % 2 === 0 ? "alice" : "bob",
        text: `m${i}`,
        addressedToAgent: false,
      });
    }

    await until(() => seqs.length >= 10);
    // Strictly increasing, no repeats — the property clients rely on to know
    // what they have already applied.
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("lets a client reconnect to the other instance and replay what it missed", async () => {
    // A reconnect goes through the load balancer and lands anywhere.
    const a = instance();
    const b = instance();
    await a.createSession({ threadId: "t1", id: "s1" });
    await a.join("s1", person("alice"));

    await a.send({ sessionId: "s1", participantId: "alice", text: "one", addressedToAgent: false });
    const cursor = await a.bus.currentSeq("s1");
    await a.send({ sessionId: "s1", participantId: "alice", text: "two", addressedToAgent: false });
    await a.send({ sessionId: "s1", participantId: "alice", text: "three", addressedToAgent: false });

    const resumed: string[] = [];
    await b.bus.subscribeFrom("s1", cursor, (event) => {
      if (event.type === "message") resumed.push(event.text);
    });

    await until(() => resumed.length === 2);
    expect(resumed).toEqual(["two", "three"]);
  });
});
