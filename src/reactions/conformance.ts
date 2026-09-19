import type {
  ReactionClaim,
  ReactionEvent,
  ReactionPolicy,
  ReactionStore,
} from "./types.js";

export interface ReactionStoreFixtureOptions {
  budgetLimits?: Record<string, number>;
  now?: () => number;
}

export type ReactionStoreFactory = (
  options?: ReactionStoreFixtureOptions,
) => ReactionStore | Promise<ReactionStore>;

export interface ReactionConformanceCheck {
  group: string;
  name: string;
  run: (makeStore: ReactionStoreFactory) => Promise<void>;
}

class ConformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReactionConformanceError";
  }
}

function ok(value: unknown, message: string): asserts value {
  if (!value) throw new ConformanceError(message);
}

function eq(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ConformanceError(
      `${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

function event(
  id: string,
  receivedAt: number,
  extra: Partial<ReactionEvent> = {},
): ReactionEvent {
  return {
    id,
    sessionId: "session-1",
    dedupeKey: id,
    participantId: "person-1",
    kind: "message",
    content: [{ type: "text", text: id }],
    receivedAt,
    ...extra,
  };
}

function runPolicy(extra: Partial<ReactionPolicy> = {}): ReactionPolicy {
  return {
    id: "test-policy",
    version: "1",
    decide(snapshot) {
      return {
        kind: "run",
        through: snapshot.pending.at(-1)!.cursor,
        reason: "ready",
        response: { maxIntents: 1, budgetClass: "reply" },
      };
    },
    ...extra,
  };
}

async function claim(
  store: ReactionStore,
  workerId: string,
  now: number,
  policy = runPolicy(),
  leaseMs = 100,
): Promise<ReactionClaim> {
  const result = await store.claimDue(workerId, policy, { now, leaseMs });
  ok(result?.status === "claimed", `expected a claim for ${workerId}`);
  return result.claim;
}

export function reactionConformanceChecks(): ReactionConformanceCheck[] {
  return [
    {
      group: "ingest",
      name: "deduplicates without changing the original cursor",
      async run(makeStore) {
        const store = await makeStore();
        const first = await store.ingest(event("one", 10));
        const duplicate = await store.ingest(event("duplicate-id", 20, { dedupeKey: "one" }));
        eq(duplicate, { inserted: false, cursor: first.cursor }, "duplicate ingest must be stable");
        const owned = await claim(store, "worker-a", 20);
        eq(owned.events.map((item) => item.id), ["one"], "duplicate must not enter the batch");
      },
    },
    {
      group: "batching",
      name: "seals a cross-participant burst into one immutable batch",
      async run(makeStore) {
        const store = await makeStore();
        await store.ingest(event("one", 10, { participantId: "alice" }));
        await store.ingest(event("two", 11, { participantId: "bob" }));
        const owned = await claim(store, "worker-a", 20);
        eq(owned.events.map((item) => item.id), ["one", "two"], "burst membership must be preserved");
      },
    },
    {
      group: "batching",
      name: "leaves input after the sealed cursor for the next batch",
      async run(makeStore) {
        const store = await makeStore();
        await store.ingest(event("one", 10));
        await store.ingest(event("two", 11));
        const firstOnly = runPolicy({
          decide(snapshot) {
            return {
              kind: "run",
              through: snapshot.pending[0]!.cursor,
              reason: "bounded",
              response: { maxIntents: 0, budgetClass: "reply" },
            };
          },
        });
        const first = await claim(store, "worker-a", 20, firstOnly);
        await store.ingest(event("three", 12));
        await store.complete(first, { result: "done" }, 21);
        const second = await claim(store, "worker-b", 22);
        eq(second.events.map((item) => item.id), ["two", "three"], "later evidence must remain pending");
      },
    },
    {
      group: "policy",
      name: "wait preserves every pending event until the deadline",
      async run(makeStore) {
        const store = await makeStore();
        await store.ingest(event("one", 10));
        const wait: ReactionPolicy = {
          id: "quiet",
          version: "1",
          decide: () => ({ kind: "wait", until: 50, reason: "quiet_window" }),
        };
        eq(await store.claimDue("worker-a", wait, { now: 20 }), null, "wait should not claim");
        eq(await store.claimDue("worker-a", runPolicy(), { now: 49 }), null, "deadline must be durable");
        const owned = await claim(store, "worker-a", 50);
        eq(owned.events.map((item) => item.id), ["one"], "wait must not consume input");
      },
    },
    {
      group: "policy",
      name: "distinguishes durable silence from a temporary defer",
      async run(makeStore) {
        const store = await makeStore();
        await store.ingest(event("one", 10));
        const defer: ReactionPolicy = {
          id: "defer",
          version: "1",
          decide: () => ({ kind: "suppress", action: "defer", until: 30, reason: "budget_reset" }),
        };
        eq(await store.claimDue("worker-a", defer, { now: 20 }), null, "defer should preserve input");
        const silence: ReactionPolicy = {
          id: "silence",
          version: "1",
          decide: (snapshot) => ({
            kind: "suppress",
            action: "consume",
            through: snapshot.pending.at(-1)!.cursor,
            reason: "acknowledgement_only",
          }),
        };
        const result = await store.claimDue("worker-a", silence, { now: 30 });
        ok(result?.status === "suppressed", "consume should produce a suppression outcome");
        eq(result.eventIds, ["one"], "suppression must identify consumed evidence");
        eq(await store.claimDue("worker-a", runPolicy(), { now: 31 }), null, "consumed silence must not replay");
      },
    },
    {
      group: "claims",
      name: "reclaims an expired batch with the same id and a higher fence",
      async run(makeStore) {
        const store = await makeStore();
        await store.ingest(event("one", 10));
        const first = await claim(store, "worker-a", 20);
        const second = await claim(store, "worker-b", 121);
        eq(second.batchId, first.batchId, "retry must retain batch identity");
        eq(second.events.map((item) => item.id), first.events.map((item) => item.id), "retry must retain membership");
        ok(second.fence > first.fence, "retry must increment the fence");
        ok(first.signal.aborted, "losing attempt must receive an abort signal");
      },
    },
    {
      group: "claims",
      name: "rejects renewal and completion from a stale owner",
      async run(makeStore) {
        const store = await makeStore();
        await store.ingest(event("one", 10));
        const first = await claim(store, "worker-a", 20);
        await claim(store, "worker-b", 121);
        eq(await store.renew(first, 122), false, "stale renewal must fail");
        const completed = await store.complete(first, { result: "stale" }, 122);
        eq(completed.status, "stale", "stale completion must not commit");
      },
    },
    {
      group: "completion",
      name: "returns the canonical committed output on replay",
      async run(makeStore) {
        const store = await makeStore();
        await store.ingest(event("one", 10));
        const owned = await claim(store, "worker-a", 20);
        const first = await store.complete(owned, {
          result: { proposal: "canonical" },
          response: { kind: "text", text: "hello" },
        }, 21);
        const replay = await store.complete(owned, { result: { proposal: "different" } }, 22);
        eq(first.status, "committed", "first completion should commit");
        eq(replay.status, "already_committed", "replay should be identified");
        if (replay.status === "already_committed") {
          eq(replay.output.result, { proposal: "canonical" }, "replay must return canonical output");
        }
      },
    },
    {
      group: "completion",
      name: "allows successful silence",
      async run(makeStore) {
        const store = await makeStore();
        await store.ingest(event("one", 10));
        const owned = await claim(store, "worker-a", 20);
        const result = await store.complete(owned, { result: { observed: true } }, 21);
        ok(result.status === "committed", "silent output should commit");
        eq(result.responseIntentId, undefined, "silence must create no response intent");
      },
    },
    {
      group: "completion",
      name: "rejects a response when policy authorized zero intents",
      async run(makeStore) {
        const store = await makeStore();
        await store.ingest(event("one", 10));
        const noReply = runPolicy({
          decide: (snapshot) => ({
            kind: "run",
            through: snapshot.pending.at(-1)!.cursor,
            reason: "observe_only",
            response: { maxIntents: 0, budgetClass: "reply" },
          }),
        });
        const owned = await claim(store, "worker-a", 20, noReply);
        let rejected = false;
        try {
          await store.complete(owned, {
            result: "done",
            response: { kind: "text", text: "not allowed" },
          }, 21);
        } catch {
          rejected = true;
        }
        ok(rejected, "store must enforce the response allowance at commit");
      },
    },
    {
      group: "state",
      name: "invalidates completion after consent or roster changes",
      async run(makeStore) {
        const store = await makeStore();
        await store.ingest(event("one", 10));
        const owned = await claim(store, "worker-a", 20);
        await store.setSessionState("session-1", { consentRevision: "2" });
        const result = await store.complete(owned, { result: "outdated" }, 21);
        eq(result.status, "suppressed", "state change must prevent commit");
        const next = await claim(store, "worker-b", 22);
        eq(next.events.map((item) => item.id), ["one"], "invalidated evidence must be reconsidered");
      },
    },
    {
      group: "budgets",
      name: "enforces a limited response slot across successive batches",
      async run(makeStore) {
        const store = await makeStore({ budgetLimits: { reply: 1 } });
        await store.ingest(event("one", 10));
        const first = await claim(store, "worker-a", 20);
        await store.complete(first, {
          result: "done",
          response: { kind: "text", text: "first" },
        }, 21);
        await store.ingest(event("two", 21));
        eq(await store.claimDue("worker-b", runPolicy(), { now: 22 }), null, "spent budget must block another claim");
      },
    },
  ];
}
