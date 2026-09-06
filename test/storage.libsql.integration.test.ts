import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";

import { ApprovalGate, fourEyes } from "../src/approvals/index.js";
import { EventBus } from "../src/bus/event-bus.js";
import { createMultiplayer, type AgentLike } from "../src/session.js";
import { LibSQLMultiplayerStore } from "../src/storage/libsql.js";
import type { Participant } from "../src/types.js";

const fakeAgent = (): AgentLike => ({
  id: "support",
  instructions: "You help the team.",
  async stream() {
    return {
      textStream: (async function* () {
        yield "on it";
      })(),
    };
  },
});

const person = (id: string, role: Participant["role"] = "editor"): Participant => ({
  id,
  displayName: id,
  role,
  surface: "web",
});

async function store() {
  const s = new LibSQLMultiplayerStore(createClient({ url: ":memory:" }));
  await s.migrate();
  return s;
}

/**
 * Conformance proves the store honours the interface. This proves the package
 * actually works on top of it — a store can satisfy every check and still be
 * unusable if, say, the run lifecycle writes a field the schema rejects.
 */
describe("LibSQLMultiplayerStore as a drop-in", () => {
  it("runs a whole session against a real database", async () => {
    const multiplayer = createMultiplayer({ agent: fakeAgent(), store: await store() });
    const session = await multiplayer.createSession({ threadId: "t1", title: "Refunds" });

    await multiplayer.join(session.id, person("alice", "owner"));
    await multiplayer.join(session.id, person("bob"));

    const replies: string[] = [];
    multiplayer.bus.subscribe(session.id, (event) => {
      if (event.type === "message" && event.fromAgent) replies.push(event.text);
    });

    await multiplayer.send({
      sessionId: session.id,
      participantId: "alice",
      text: "can we refund 4417?",
    });
    // Let the queued turn drain.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(replies).toEqual(["on it"]);
    expect((await multiplayer.store.listParticipants(session.id)).map((p) => p.id)).toEqual([
      "alice",
      "bob",
    ]);

    const audit = await multiplayer.store.listAudit(session.id);
    expect(audit.map((e) => e.action)).toEqual([
      "session.created",
      "participant.joined",
      "participant.joined",
      "message.sent",
      "agent.run.started",
      "agent.run.finished",
    ]);
  });

  it("clears runningRunId when a turn finishes", async () => {
    // The one patch that writes undefined. A store that ignores it leaves every
    // session looking permanently busy, and no other test would notice.
    const multiplayer = createMultiplayer({ agent: fakeAgent(), store: await store() });
    const session = await multiplayer.createSession({ threadId: "t1" });
    await multiplayer.join(session.id, person("alice"));

    await multiplayer.send({
      sessionId: session.id,
      participantId: "alice",
      text: "hello",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const record = await multiplayer.store.getSession(session.id);
    expect(record?.runningRunId).toBeFalsy();
  });

  it("resolves a four-eyes gate across a restart, on disk-backed state", async () => {
    // The R2 guarantee, now against a store that genuinely survives a process.
    const shared = await store();
    const bus = new EventBus();

    await shared.createSession({
      id: "s1",
      threadId: "t1",
      agentId: "support",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    for (const p of [person("alice"), person("bob"), person("dave")]) {
      await shared.addParticipant("s1", p);
    }

    const request = await new ApprovalGate(shared, bus).request({
      sessionId: "s1",
      requestedBy: "alice",
      toolName: "refund-order",
      toolArgs: { orderId: "4417", amountCents: 400_000 },
      summary: "Refund $4,000",
      policy: fourEyes(),
    });

    // Restart: a new gate, new bus, same database.
    const restarted = new ApprovalGate(shared, new EventBus());

    await expect(restarted.vote(request.id, "alice", "approve")).rejects.toThrow(
      /cannot approve their own/i,
    );
    expect((await restarted.vote(request.id, "bob", "approve")).status).toBe("pending");
    expect((await restarted.vote(request.id, "dave", "approve")).status).toBe("approved");
  });

  it("keeps two sessions' rosters and ledgers apart", async () => {
    const shared = await store();
    const multiplayer = createMultiplayer({ agent: fakeAgent(), store: shared });

    const one = await multiplayer.createSession({ threadId: "t1", id: "s1" });
    const two = await multiplayer.createSession({ threadId: "t2", id: "s2" });
    await multiplayer.join(one.id, person("alice"));
    await multiplayer.join(two.id, person("mallory"));

    expect((await shared.listParticipants("s1")).map((p) => p.id)).toEqual(["alice"]);
    expect(await shared.getParticipant("s2", "alice")).toBeNull();
    expect((await shared.listAudit("s1")).every((e) => e.sessionId === "s1")).toBe(true);
  });

  it("survives being reopened against the same file", async () => {
    // The actual claim: this store is durable. An in-memory database would pass
    // every other test here.
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "mp-libsql-"));
    const url = `file:${join(dir, "mp.db")}`;

    const first = new LibSQLMultiplayerStore(createClient({ url }));
    await first.migrate();
    await first.createSession({
      id: "s1",
      threadId: "t1",
      agentId: "support",
      createdAt: 1,
      updatedAt: 1,
      metadata: { tier: "gold" },
    });
    await first.addParticipant("s1", person("alice", "owner"));
    await first.appendAudit({
      id: "e1",
      sessionId: "s1",
      action: "session.created",
      actorId: null,
      at: 1,
    });

    // A different client against the same file — a redeployed process.
    const second = new LibSQLMultiplayerStore(createClient({ url }));
    await second.migrate(); // idempotent

    expect((await second.getSession("s1"))?.metadata).toEqual({ tier: "gold" });
    expect((await second.getParticipant("s1", "alice"))?.role).toBe("owner");
    expect((await second.listAudit("s1")).map((e) => e.id)).toEqual(["e1"]);
  });
});
