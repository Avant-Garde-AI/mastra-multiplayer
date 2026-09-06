import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../src/bus/event-bus.js";

const message = (text: string, sessionId = "s1") =>
  ({ type: "message", sessionId, participantId: "alice", text, fromAgent: false }) as const;

describe("EventBus", async () => {
  it("assigns monotonic sequences per session, not globally", async () => {
    const bus = new EventBus();

    expect((await bus.publish(message("one"))).seq).toBe(1);
    expect((await bus.publish(message("two", "s2"))).seq).toBe(1);
    expect((await bus.publish(message("three"))).seq).toBe(2);
  });

  it("replays only what a client missed", async () => {
    const bus = new EventBus();
    await bus.publish(message("one"));
    await bus.publish(message("two"));
    await bus.publish(message("three"));

    const missed = await bus.replay("s1", 1);
    expect(missed.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("reports the sequence a snapshot is consistent with", async () => {
    const bus = new EventBus();
    expect(await bus.currentSeq("s1")).toBe(0);
    await bus.publish(message("one"));
    await bus.publish(message("two"));

    // Reconnecting from currentSeq must yield nothing already seen.
    expect(await bus.currentSeq("s1")).toBe(2);
    expect(await bus.replay("s1", await bus.currentSeq("s1"))).toEqual([]);
  });

  it("bounds the replay buffer and keeps the newest events", async () => {
    const bus = new EventBus({ replayBufferSize: 3 });
    for (let i = 1; i <= 10; i++) await bus.publish(message(`m${i}`));

    const buffered = await bus.replay("s1");
    expect(buffered.map((e) => e.seq)).toEqual([8, 9, 10]);
  });

  it("keeps sequencing when replay is disabled", async () => {
    const bus = new EventBus({ replayBufferSize: 0 });
    await bus.publish(message("one"));

    expect((await bus.publish(message("two"))).seq).toBe(2);
    expect(await bus.replay("s1")).toEqual([]);
  });

  it("delivers to the other subscribers when one throws", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = new EventBus();
    const delivered: string[] = [];
    // Synchronous throw on purpose: an async subscriber returns a rejected
    // promise, which the bus's try/catch would never see.
    bus.subscribe("s1", () => {
      throw new Error("bad subscriber");
    });
    bus.subscribe("s1", (event) => delivered.push(event.type));

    await expect(bus.publish(message("one"))).resolves.toBeTruthy();
    expect(delivered).toEqual(["message"]);
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });

  it("does not fan out across sessions", async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe("s1", (event) => seen.push(event.sessionId));

    await bus.publish(message("mine"));
    await bus.publish(message("theirs", "s2"));

    expect(seen).toEqual(["s1"]);
  });

  it("stops delivering after unsubscribe", async () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.subscribe("s1", () => count++);

    await bus.publish(message("one"));
    off();
    await bus.publish(message("two"));

    expect(count).toBe(1);
    expect(bus.subscriberCount("s1")).toBe(0);
  });
});
