import { describe, expect, it } from "vitest";

import {
  createReactionBus,
  createBurstReactionPolicy,
  InMemoryReactionStore,
  type ReactionEvent,
  type ReactionPolicy,
} from "../src/reactions/index.js";

const message: ReactionEvent = {
  id: "message-1",
  sessionId: "session-1",
  dedupeKey: "provider:message-1",
  participantId: "alice",
  kind: "message",
  content: [{ type: "text", text: "Can you help?" }],
  receivedAt: 1,
};

const policy: ReactionPolicy = {
  id: "mentions",
  version: "1",
  decide(snapshot) {
    return {
      kind: "run",
      through: snapshot.pending.at(-1)!.cursor,
      reason: "direct_question",
      response: { maxIntents: 1, budgetClass: "solicited" },
    };
  },
};

describe("ReactionBus", () => {
  it("ingests, runs, and commits one response intent", async () => {
    const store = new InMemoryReactionStore();
    const bus = createReactionBus({
      store,
      policy,
      now: () => 10,
      runner: async (claim) => ({
        result: { eventIds: claim.events.map((event) => event.id) },
        response: { kind: "text" as const, text: "Yes." },
      }),
    });

    await bus.ingest(message);
    const result = await bus.runNext({ workerId: "worker-a" });

    expect(result.status).toBe("committed");
    if (result.status === "committed") {
      expect(result.responseIntentId).toBe(`response:${result.batchId}`);
      expect(result.output.result).toEqual({ eventIds: ["message-1"] });
    }
  });

  it("releases a failed run and retries the same batch", async () => {
    let now = 10;
    let attempts = 0;
    const store = new InMemoryReactionStore({ now: () => now });
    const bus = createReactionBus({
      store,
      policy,
      now: () => now,
      retryDelayMs: 5,
      runner: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("model unavailable");
        return { result: "recovered" };
      },
    });

    await bus.ingest(message);
    const failed = await bus.runNext({ workerId: "worker-a" });
    expect(failed.status).toBe("failed");

    now = 14;
    expect((await bus.runNext({ workerId: "worker-b" })).status).toBe("idle");
    now = 15;
    const recovered = await bus.runNext({ workerId: "worker-b" });
    expect(recovered.status).toBe("committed");
    if (failed.status === "failed" && recovered.status === "committed") {
      expect(recovered.batchId).toBe(failed.batchId);
    }
  });
});

describe("createBurstReactionPolicy", () => {
  const snapshot = (events: Array<Partial<ReactionEvent> & Pick<ReactionEvent, "id">>) => ({
    sessionId: "session-1",
    revision: "1",
    pending: events.map((item, index) => ({
      ...message,
      ...item,
      cursor: String(index + 1),
      dedupeKey: item.id,
      receivedAt: item.receivedAt ?? index * 100,
    })),
    firstReceivedAt: events[0]?.receivedAt ?? 0,
    latestReceivedAt: events.at(-1)?.receivedAt ?? 0,
    state: { consentRevision: "1", rosterRevision: "1", paused: false },
    budgets: [],
  });

  it("extends the quiet window but caps it at maximum wait", () => {
    const burst = createBurstReactionPolicy({ quietMs: 1_000, maxWaitMs: 2_000 });
    const input = snapshot([
      { id: "one", receivedAt: 0 },
      { id: "two", receivedAt: 1_900 },
    ]);

    expect(burst.decide(input, 1_950)).toEqual({
      kind: "wait",
      until: 2_000,
      reason: "await_quiet_window",
    });
    expect(burst.decide(input, 2_000)).toMatchObject({
      kind: "run",
      reason: "maximum_wait_elapsed",
    });
  });

  it("accelerates trusted direct and urgent signals", () => {
    const burst = createBurstReactionPolicy({
      quietMs: 5_000,
      addressedDelayMs: 250,
    });
    const direct = snapshot([{ id: "one", signals: { addressedToAgent: true } }]);
    expect(burst.decide(direct, 100)).toMatchObject({ kind: "wait", until: 250 });
    expect(burst.decide(direct, 250)).toMatchObject({
      kind: "run",
      reason: "direct_address_ready",
      response: { budgetClass: "solicited" },
    });

    const urgent = snapshot([{ id: "urgent", signals: { urgency: "urgent" } }]);
    expect(burst.decide(urgent, 0)).toMatchObject({
      kind: "run",
      reason: "trusted_urgent_signal",
    });
  });

  it("successfully consumes reaction-only traffic without a model run", () => {
    const burst = createBurstReactionPolicy();
    const input = snapshot([{
      id: "heart",
      kind: "reaction",
      content: [],
      signals: { reaction: { value: "heart", operation: "add" } },
    }]);
    expect(burst.decide(input, 10_000)).toMatchObject({
      kind: "suppress",
      action: "consume",
      reason: "reaction_only",
    });
  });

  it("re-evaluates a durable wait when an urgent event arrives", async () => {
    let now = 0;
    const store = new InMemoryReactionStore({ now: () => now });
    const burst = createBurstReactionPolicy({ quietMs: 5_000 });
    await store.ingest(message);
    expect(await store.claimDue("worker-a", burst, { now })).toBeNull();

    now = 100;
    await store.ingest({
      ...message,
      id: "message-2",
      dedupeKey: "provider:message-2",
      receivedAt: now,
      signals: { urgency: "urgent" },
    });
    expect((await store.claimDue("worker-b", burst, { now }))?.status).toBe("claimed");
  });
});
