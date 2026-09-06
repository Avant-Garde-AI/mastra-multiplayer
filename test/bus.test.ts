import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../src/bus/event-bus.js";

const message = (text: string, sessionId = "s1") =>
  ({ type: "message", sessionId, participantId: "alice", text, fromAgent: false }) as const;

describe("EventBus", () => {
  it("assigns monotonic sequences per session, not globally", () => {
    const bus = new EventBus();

    expect(bus.publish(message("one")).seq).toBe(1);
    expect(bus.publish(message("two", "s2")).seq).toBe(1);
    expect(bus.publish(message("three")).seq).toBe(2);
  });

  it("replays only what a client missed", () => {
    const bus = new EventBus();
    bus.publish(message("one"));
    bus.publish(message("two"));
    bus.publish(message("three"));

    const missed = bus.replay("s1", 1);
    expect(missed.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("reports the sequence a snapshot is consistent with", () => {
    const bus = new EventBus();
    expect(bus.currentSeq("s1")).toBe(0);
    bus.publish(message("one"));
    bus.publish(message("two"));

    // Reconnecting from currentSeq must yield nothing already seen.
    expect(bus.currentSeq("s1")).toBe(2);
    expect(bus.replay("s1", bus.currentSeq("s1"))).toEqual([]);
  });

  it("bounds the replay buffer and keeps the newest events", () => {
    const bus = new EventBus({ replayBufferSize: 3 });
    for (let i = 1; i <= 10; i++) bus.publish(message(`m${i}`));

    const buffered = bus.replay("s1");
    expect(buffered.map((e) => e.seq)).toEqual([8, 9, 10]);
  });

  it("keeps sequencing when replay is disabled", () => {
    const bus = new EventBus({ replayBufferSize: 0 });
    bus.publish(message("one"));

    expect(bus.publish(message("two")).seq).toBe(2);
    expect(bus.replay("s1")).toEqual([]);
  });

  it("delivers to the other subscribers when one throws", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = new EventBus();
    const delivered: string[] = [];
    bus.subscribe("s1", () => {
      throw new Error("bad subscriber");
    });
    bus.subscribe("s1", (event) => delivered.push(event.type));

    expect(() => bus.publish(message("one"))).not.toThrow();
    expect(delivered).toEqual(["message"]);
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });

  it("does not fan out across sessions", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe("s1", (event) => seen.push(event.sessionId));

    bus.publish(message("mine"));
    bus.publish(message("theirs", "s2"));

    expect(seen).toEqual(["s1"]);
  });

  it("stops delivering after unsubscribe", () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.subscribe("s1", () => count++);

    bus.publish(message("one"));
    off();
    bus.publish(message("two"));

    expect(count).toBe(1);
    expect(bus.subscriberCount("s1")).toBe(0);
  });
});
