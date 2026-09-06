import { describe, expect, it } from "vitest";

import { EventBus } from "../src/bus/event-bus.js";
import { PresenceManager } from "../src/presence/index.js";
import { InMemoryMultiplayerStore } from "../src/storage/index.js";

async function setup(now: () => number) {
  const store = new InMemoryMultiplayerStore();
  const bus = new EventBus();
  const presence = new PresenceManager(store, bus, {
    idleAfterMs: 1000,
    dropAfterMs: 3000,
    now,
  });
  await store.createSession({
    id: "s1",
    threadId: "t1",
    agentId: "a1",
    createdAt: 0,
    updatedAt: 0,
  });
  return { store, bus, presence };
}

describe("PresenceManager", () => {
  it("marks stale participants idle, then drops them", async () => {
    let clock = 0;
    const { presence } = await setup(() => clock);

    await presence.heartbeat("s1", "alice");
    await presence.heartbeat("s1", "bob");

    clock = 1500;
    await presence.sweep("s1");
    const idle = await presence.sweep("s1");
    expect(idle).toEqual([]);

    clock = 4000;
    const dropped = await presence.sweep("s1");
    expect(dropped.sort()).toEqual(["alice", "bob"]);
  });

  it("keeps a participant alive across heartbeats", async () => {
    let clock = 0;
    const { presence, store } = await setup(() => clock);

    await presence.heartbeat("s1", "alice");
    clock = 2000;
    await presence.heartbeat("s1", "alice");
    clock = 4000;
    await presence.heartbeat("s1", "alice");

    const dropped = await presence.sweep("s1");
    expect(dropped).toEqual([]);
    expect(await store.listPresence("s1")).toHaveLength(1);
  });

  it("broadcasts typing state", async () => {
    const { presence, bus } = await setup(() => 0);
    const seen: string[] = [];
    bus.subscribe("s1", (event) => {
      if (event.type === "presence.updated") {
        seen.push(event.presence[0]?.status ?? "none");
      }
    });

    await presence.setTyping("s1", "alice", true);
    await presence.setTyping("s1", "alice", false);
    expect(seen).toEqual(["typing", "active"]);
  });
});

/**
 * A dropped SSE stream and a departure look identical to the transport and are
 * completely different to the room. Reconnects, tab switches, and a laptop lid
 * all close the stream while the person is still sitting in the session.
 */
describe("PresenceManager.disconnected", () => {
  it("clears presence without evicting anyone from the roster", async () => {
    const { bus, presence } = await setup(() => 0);
    const seen: string[] = [];
    bus.subscribe("s1", (event) => seen.push(event.type));

    await presence.heartbeat("s1", "alice");
    const remaining = await presence.disconnected("s1", "alice");

    expect(remaining).toEqual([]);
    expect(seen).not.toContain("participant.left");
    expect(seen.filter((t) => t === "presence.updated")).toHaveLength(2);
  });

  it("still announces a departure when someone actually leaves", async () => {
    const { bus, presence } = await setup(() => 0);
    const seen: string[] = [];
    bus.subscribe("s1", (event) => seen.push(event.type));

    await presence.heartbeat("s1", "alice");
    await presence.leave("s1", "alice");

    expect(seen).toContain("participant.left");
  });
});
