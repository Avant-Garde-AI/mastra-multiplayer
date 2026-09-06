import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MultiplayerClient } from "../src/client/index.js";
import type { MultiplayerEvent } from "../src/bus/events.js";
import type { Participant } from "../src/types.js";

const person = (id: string): Participant => ({
  id,
  displayName: id,
  role: "editor",
  surface: "web",
});

/**
 * Minimal `EventSource`. The real one is not in Node, and jsdom's cannot be
 * driven event by event — which is exactly what the reducer needs.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(event: { data: string }) => void>>();

  constructor(
    readonly url: string,
    readonly init?: { withCredentials?: boolean },
  ) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (event: { data: string }) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(handler);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.closed = true;
  }

  /** Delivers an event the way the server would frame it. */
  emit(event: Partial<MultiplayerEvent> & { type: string; seq: number }): void {
    const payload = JSON.stringify({ sessionId: "s1", at: Date.now(), ...event });
    for (const handler of this.listeners.get(event.type) ?? []) handler({ data: payload });
  }
}

let fetchMock: ReturnType<typeof vi.fn>;

function snapshot(body: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      session: { id: "s1", threadId: "t1", agentId: "a" },
      participants: [],
      presence: [],
      approvals: [],
      seq: 0,
      ...body,
    }),
    text: async () => "",
  };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  fetchMock = vi.fn(async () => snapshot());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const client = (options: Partial<{ baseUrl: string; basePath: string }> = {}) =>
  new MultiplayerClient({ sessionId: "s1", ...options });

/** The stream the client most recently opened. */
const stream = () => FakeEventSource.instances.at(-1)!;

describe("MultiplayerClient", () => {
  describe("start", () => {
    it("joins, hydrates, then opens the stream — in that order", async () => {
      const c = client();
      const calls: string[] = [];
      fetchMock.mockImplementation(async (url: string) => {
        calls.push(new URL(url, "http://x").pathname);
        return snapshot();
      });

      await c.start();
      calls.push("stream:" + new URL(stream().url, "http://x").pathname);

      expect(calls).toEqual([
        "/multiplayer/sessions/s1/join",
        "/multiplayer/sessions/s1/state",
        "stream:/multiplayer/sessions/s1/stream",
      ]);
    });

    it("opens the stream from the snapshot's sequence, not from zero", async () => {
      const c = client();
      fetchMock.mockImplementation(async (url: string) =>
        url.endsWith("/state") ? snapshot({ seq: 47 }) : snapshot(),
      );

      await c.start();

      expect(stream().url).toContain("lastSeq=47");
    });

    it("does not replay events the snapshot already covers", async () => {
      const c = client();
      fetchMock.mockImplementation(async (url: string) =>
        url.endsWith("/state")
          ? snapshot({ seq: 5, participants: [person("alice")] })
          : snapshot(),
      );

      await c.start();
      // A late frame from below the cursor — already reflected in the snapshot.
      stream().emit({ type: "message", seq: 3, participantId: "alice", text: "old", fromAgent: false } as never);

      expect(c.getState().messages).toEqual([]);
    });
  });

  describe("hydrate", () => {
    it("fills the roster, presence, and open approvals", async () => {
      const c = client();
      fetchMock.mockResolvedValue(
        snapshot({
          participants: [person("alice"), person("bob")],
          presence: [{ participantId: "alice", status: "active", lastSeenAt: 1 }],
          approvals: [{ id: "ap1", status: "pending" }],
          seq: 9,
        }),
      );

      await c.hydrate();

      expect(c.getState().participants.map((p) => p.id)).toEqual(["alice", "bob"]);
      expect(c.getState().presence).toHaveLength(1);
      expect(c.getState().approvals).toHaveLength(1);
    });

    it("throws with the status when the snapshot is refused", async () => {
      const c = client();
      fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => "Forbidden" });

      await expect(c.hydrate()).rejects.toThrow("403 Forbidden");
    });

    it("does not move the cursor while a stream is open", async () => {
      // Advancing past in-flight replay frames would silently drop them.
      const c = client();
      await c.start();

      fetchMock.mockResolvedValue(snapshot({ seq: 99 }));
      await c.hydrate();
      stream().emit({ type: "message", seq: 1, participantId: "alice", text: "replayed", fromAgent: false } as never);

      expect(c.getState().messages.map((m) => m.text)).toEqual(["replayed"]);
    });
  });

  describe("reducer", () => {
    async function connected() {
      const c = client();
      await c.start();
      return c;
    }

    it("adds and removes participants", async () => {
      const c = await connected();
      stream().emit({ type: "participant.joined", seq: 1, participant: person("bob") } as never);
      expect(c.getState().participants.map((p) => p.id)).toEqual(["bob"]);

      stream().emit({ type: "participant.left", seq: 2, participantId: "bob" } as never);
      expect(c.getState().participants).toEqual([]);
    });

    it("upserts rather than duplicating a rejoining participant", async () => {
      const c = await connected();
      stream().emit({ type: "participant.joined", seq: 1, participant: person("bob") } as never);
      stream().emit({
        type: "participant.joined",
        seq: 2,
        participant: { ...person("bob"), displayName: "Bobby" },
      } as never);

      expect(c.getState().participants).toHaveLength(1);
      expect(c.getState().participants[0]!.displayName).toBe("Bobby");
    });

    it("accumulates agent deltas and clears them when the message lands", async () => {
      const c = await connected();
      stream().emit({ type: "agent.run.started", seq: 1, runId: "r1", triggeredBy: "alice" } as never);
      stream().emit({ type: "agent.delta", seq: 2, runId: "r1", delta: "Hel" } as never);
      stream().emit({ type: "agent.delta", seq: 3, runId: "r1", delta: "lo" } as never);

      expect(c.getState().streaming).toBe("Hello");
      expect(c.getState().agentRunning).toBe(true);

      stream().emit({ type: "message", seq: 4, participantId: null, text: "Hello", fromAgent: true } as never);
      expect(c.getState().streaming).toBeNull();

      stream().emit({ type: "agent.run.finished", seq: 5, runId: "r1", triggeredBy: null } as never);
      expect(c.getState().agentRunning).toBe(false);
    });

    it("clears the streaming buffer on an interrupt", async () => {
      const c = await connected();
      stream().emit({ type: "agent.run.started", seq: 1, runId: "r1", triggeredBy: "alice" } as never);
      stream().emit({ type: "agent.delta", seq: 2, runId: "r1", delta: "half a th" } as never);
      stream().emit({ type: "agent.run.interrupted", seq: 3, runId: "r1", triggeredBy: "bob" } as never);

      expect(c.getState()).toMatchObject({ streaming: null, agentRunning: false });
    });

    it("keeps a human message while the agent is mid-stream", async () => {
      const c = await connected();
      stream().emit({ type: "agent.run.started", seq: 1, runId: "r1", triggeredBy: "alice" } as never);
      stream().emit({ type: "agent.delta", seq: 2, runId: "r1", delta: "thinking" } as never);
      stream().emit({ type: "message", seq: 3, participantId: "bob", text: "wait", fromAgent: false } as never);

      // Someone else talking must not wipe the agent's in-flight reply.
      expect(c.getState().streaming).toBe("thinking");
      expect(c.getState().messages.map((m) => m.text)).toEqual(["wait"]);
    });

    it("replaces a pending approval on update and drops it on resolve", async () => {
      const c = await connected();
      stream().emit({ type: "approval.requested", seq: 1, request: { id: "ap1", votes: [] } } as never);
      stream().emit({ type: "approval.updated", seq: 2, request: { id: "ap1", votes: [1] } } as never);

      expect(c.getState().approvals).toHaveLength(1);
      expect((c.getState().approvals[0] as any).votes).toHaveLength(1);

      stream().emit({ type: "approval.resolved", seq: 3, request: { id: "ap1" } } as never);
      expect(c.getState().approvals).toEqual([]);
    });

    it("ignores a duplicate redelivered after a reconnect", async () => {
      const c = await connected();
      stream().emit({ type: "message", seq: 1, participantId: "alice", text: "once", fromAgent: false } as never);
      stream().emit({ type: "message", seq: 1, participantId: "alice", text: "once", fromAgent: false } as never);

      expect(c.getState().messages).toHaveLength(1);
    });

    it("survives a malformed frame without corrupting state", async () => {
      const c = await connected();
      stream().emit({ type: "message", seq: 1, participantId: "alice", text: "good", fromAgent: false } as never);

      // Raw garbage on the wire — the client must not throw.
      const handler = (stream() as any).listeners.get("message")[0];
      expect(() => handler({ data: "{not json" })).not.toThrow();

      expect(c.getState().messages).toHaveLength(1);
    });
  });

  describe("connection lifecycle", () => {
    it("marks connected on open and disconnected on error", async () => {
      const c = await (async () => {
        const inner = client();
        await inner.start();
        return inner;
      })();

      stream().onopen!();
      expect(c.getState().connected).toBe(true);

      stream().onerror!();
      expect(c.getState().connected).toBe(false);
    });

    it("reconnects with backoff after an error", async () => {
      vi.useFakeTimers();
      try {
        const c = client();
        await c.start();
        const first = stream();

        first.onerror!();
        expect(first.closed).toBe(true);
        expect(FakeEventSource.instances).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1000);
        expect(FakeEventSource.instances).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("closes the stream and stops heartbeating on disconnect", async () => {
      vi.useFakeTimers();
      try {
        const c = client();
        await c.start();
        const opened = stream();
        const before = fetchMock.mock.calls.length;

        c.disconnect();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(opened.closed).toBe(true);
        expect(c.getState().connected).toBe(false);
        expect(fetchMock.mock.calls.length).toBe(before);
      } finally {
        vi.useRealTimers();
      }
    });

    it("heartbeats presence on an interval", async () => {
      vi.useFakeTimers();
      try {
        const c = client();
        await c.start();
        const before = fetchMock.mock.calls.length;

        await vi.advanceTimersByTimeAsync(10_000);

        const beats = fetchMock.mock.calls
          .slice(before)
          .filter((call) => String(call[0]).endsWith("/presence"));
        expect(beats.length).toBeGreaterThanOrEqual(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not surface a failed heartbeat — the stream reconnect recovers", async () => {
      vi.useFakeTimers();
      try {
        const c = client();
        await c.start();
        fetchMock.mockRejectedValue(new Error("offline"));

        await expect(vi.advanceTimersByTimeAsync(10_000)).resolves.not.toThrow();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("requests", () => {
    it("sends credentials and the configured headers", async () => {
      const c = new MultiplayerClient({
        sessionId: "s1",
        headers: { Authorization: "Bearer t" },
      });
      await c.send("hi");

      const [, init] = fetchMock.mock.calls.at(-1)!;
      expect(init).toMatchObject({
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      });
      expect(JSON.parse(init.body)).toEqual({ text: "hi", addressedToAgent: true });
    });

    it("posts a vote to the session-less approvals path", async () => {
      const c = client();
      await c.vote("ap1", "approve", "looks right");

      const [url, init] = fetchMock.mock.calls.at(-1)!;
      expect(url).toBe("/multiplayer/approvals/ap1/vote");
      expect(JSON.parse(init.body)).toEqual({
        decision: "approve",
        reason: "looks right",
      });
    });

    it("respects baseUrl and basePath", async () => {
      const c = client({ baseUrl: "https://api.example.com", basePath: "/collab" });
      await c.send("hi");

      expect(fetchMock.mock.calls.at(-1)![0]).toBe(
        "https://api.example.com/collab/sessions/s1/messages",
      );
    });

    it("throws with the status and body when a request is refused", async () => {
      const c = client();
      fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => "Not eligible" });

      await expect(c.vote("ap1", "approve")).rejects.toThrow("403 Not eligible");
    });
  });

  describe("subscribe", () => {
    it("fires immediately with current state and stops after unsubscribe", async () => {
      const c = await (async () => {
        const inner = client();
        await inner.start();
        return inner;
      })();

      const seen: number[] = [];
      const off = c.subscribe((state) => seen.push(state.messages.length));
      expect(seen).toEqual([0]);

      stream().emit({ type: "message", seq: 1, participantId: "alice", text: "a", fromAgent: false } as never);
      expect(seen).toEqual([0, 1]);

      off();
      stream().emit({ type: "message", seq: 2, participantId: "alice", text: "b", fromAgent: false } as never);
      expect(seen).toEqual([0, 1]);
    });
  });
});
