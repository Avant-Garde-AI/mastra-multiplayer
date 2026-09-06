/**
 * A conformance suite for `MultiplayerStore`.
 *
 * The interface has more implicit contract than it looks: `updateSession` is a
 * patch that must also be able to *clear* a field, `addParticipant` is an
 * upsert, `listAudit` returns the newest entries rather than the oldest, and an
 * `ApprovalRequest` carries a resolved policy that has to round-trip exactly or
 * a four-eyes gate silently becomes a one-signature gate. None of that is
 * visible from the type signatures, and all of it is load-bearing.
 *
 * So the checks live here rather than in this package's own tests, and they are
 * plain functions rather than a test framework's suite — drive them from
 * vitest, jest, `node:test`, or a script. Zero dependencies.
 *
 * ```ts
 * import { conformanceChecks } from "mastra-multiplayer/storage/conformance";
 *
 * for (const check of conformanceChecks()) {
 *   it(`${check.group} — ${check.name}`, async () => {
 *     await check.run(await makeFreshStore());
 *   });
 * }
 * ```
 *
 * Every check gets a store with no sessions in it and creates what it needs.
 */
import type { MultiplayerStore } from "./index.js";
import type {
  ApprovalRequest,
  AuditEntry,
  Participant,
  ResolvedPolicy,
  SessionRecord,
} from "../types.js";

export interface ConformanceCheck {
  /** Broad area, for grouping output: `sessions`, `participants`, … */
  group: string;
  name: string;
  run: (store: MultiplayerStore) => Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Assertions — small enough not to warrant a dependency               */
/* ------------------------------------------------------------------ */

class ConformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConformanceError";
  }
}

function ok(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConformanceError(message);
}

function eq(actual: unknown, expected: unknown, message: string): void {
  if (!same(actual, expected)) {
    throw new ConformanceError(
      `${message}\n  expected: ${show(expected)}\n  actual:   ${show(actual)}`,
    );
  }
}

/** Structural equality, treating a missing key and an undefined value alike. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => same(item, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] === undefined && right[key] === undefined) continue;
    if (!same(left[key], right[key])) return false;
  }
  return true;
}

function show(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const session = (id: string, extra: Partial<SessionRecord> = {}): SessionRecord => ({
  id,
  threadId: `thread_${id}`,
  agentId: "support",
  createdAt: 1_000,
  updatedAt: 1_000,
  ...extra,
});

const person = (id: string, extra: Partial<Participant> = {}): Participant => ({
  id,
  displayName: id,
  role: "editor",
  surface: "web",
  ...extra,
});

const policy = (extra: Partial<ResolvedPolicy> = {}): ResolvedPolicy => ({
  name: "four-eyes",
  quorum: 2,
  excludeRequester: true,
  allowedRoles: ["owner", "approver"],
  denyIsFinal: true,
  expiresAfterMs: 900_000,
  onExpiry: "deny",
  ...extra,
});

const approval = (
  id: string,
  extra: Partial<ApprovalRequest> = {},
): ApprovalRequest => ({
  id,
  sessionId: "s1",
  requestedBy: "alice",
  toolName: "refund-order",
  toolArgs: { orderId: "4417", amountCents: 4000 },
  bindingHash: "abc123",
  summary: "Refund $40 on order 4417",
  policy: policy(),
  status: "pending",
  votes: [],
  createdAt: 1_000,
  expiresAt: 901_000,
  ...extra,
});

const entry = (id: string, extra: Partial<AuditEntry> = {}): AuditEntry => ({
  id,
  sessionId: "s1",
  action: "message.sent",
  actorId: "alice",
  at: 1_000,
  ...extra,
});

async function withSession(store: MultiplayerStore, id = "s1"): Promise<SessionRecord> {
  const record = session(id);
  await store.createSession(record);
  return record;
}

/* ------------------------------------------------------------------ */
/* The checks                                                          */
/* ------------------------------------------------------------------ */

export function conformanceChecks(): ConformanceCheck[] {
  return [
    /* -------------------------------------------------------------- */
    { group: "sessions", name: "round-trips a created session", async run(store) {
      const record = session("s1", { title: "Refund review" });
      await store.createSession(record);
      eq(await store.getSession("s1"), record, "getSession must return what was stored");
    } },

    { group: "sessions", name: "returns null for an unknown session", async run(store) {
      eq(await store.getSession("nope"), null, "an unknown session must read as null, not throw");
    } },

    { group: "sessions", name: "round-trips metadata", async run(store) {
      await store.createSession(
        session("s1", { metadata: { tier: "gold", tags: ["vip", "eu"], nested: { a: 1 } } }),
      );
      const found = await store.getSession("s1");
      eq(found?.metadata, { tier: "gold", tags: ["vip", "eu"], nested: { a: 1 } },
        "metadata must survive serialization intact");
    } },

    { group: "sessions", name: "updateSession patches rather than replaces", async run(store) {
      await store.createSession(session("s1", { title: "Original" }));
      await store.updateSession("s1", { runningRunId: "run_1" });

      const found = await store.getSession("s1");
      eq(found?.title, "Original", "a patch must not drop fields it does not mention");
      eq(found?.threadId, "thread_s1", "a patch must not drop the thread binding");
      eq(found?.runningRunId, "run_1", "the patched field must be applied");
    } },

    { group: "sessions", name: "updateSession refreshes updatedAt", async run(store) {
      await store.createSession(session("s1"));
      await store.updateSession("s1", { title: "Renamed" });

      const found = await store.getSession("s1");
      ok((found?.updatedAt ?? 0) > 1_000, "updateSession must refresh updatedAt");
    } },

    { group: "sessions", name: "updateSession can clear a field with undefined", async run(store) {
      // The agent's run lifecycle sets `runningRunId` on start and clears it on
      // finish, by patching with `undefined`. A store that skips undefined
      // values leaves every session looking permanently busy.
      await store.createSession(session("s1"));
      await store.updateSession("s1", { runningRunId: "run_1" });
      await store.updateSession("s1", { runningRunId: undefined });

      const found = await store.getSession("s1");
      ok(!found?.runningRunId, "patching with undefined must clear the field, not be ignored");
    } },

    { group: "sessions", name: "lists every session", async run(store) {
      await store.createSession(session("s1"));
      await store.createSession(session("s2"));

      const ids = (await store.listSessions()).map((s) => s.id).sort();
      eq(ids, ["s1", "s2"], "listSessions must return all sessions");
    } },

    /* -------------------------------------------------------------- */
    { group: "participants", name: "adds, gets, and lists", async run(store) {
      await withSession(store);
      await store.addParticipant("s1", person("alice"));
      await store.addParticipant("s1", person("bob", { role: "owner" }));

      eq((await store.getParticipant("s1", "alice"))?.displayName, "alice", "getParticipant must find a member");
      eq((await store.listParticipants("s1")).map((p) => p.id).sort(), ["alice", "bob"],
        "listParticipants must return the roster");
    } },

    { group: "participants", name: "returns null for a non-member", async run(store) {
      await withSession(store);
      eq(await store.getParticipant("s1", "nobody"), null, "a non-member must read as null");
    } },

    { group: "participants", name: "returns null for a participant of an unknown session", async run(store) {
      // The default authorization rule calls this on every request, including
      // for session ids that do not exist.
      eq(await store.getParticipant("nope", "alice"), null, "an unknown session must read as null");
    } },

    { group: "participants", name: "addParticipant is an upsert", async run(store) {
      await withSession(store);
      await store.addParticipant("s1", person("alice", { role: "viewer" }));
      await store.addParticipant("s1", person("alice", { role: "owner", displayName: "Alice C." }));

      const roster = await store.listParticipants("s1");
      eq(roster.length, 1, "rejoining must not duplicate a roster entry");
      eq(roster[0]?.role, "owner", "rejoining must update the role");
      eq(roster[0]?.displayName, "Alice C.", "rejoining must update the display name");
    } },

    { group: "participants", name: "round-trips every optional field", async run(store) {
      await withSession(store);
      const full = person("alice", {
        resourceId: "slack:U06CK1E9HN2",
        email: "alice@example.com",
        avatarUrl: "https://example.com/a.png",
        metadata: { team: "support", shift: 2 },
      });
      await store.addParticipant("s1", full);

      eq(await store.getParticipant("s1", "alice"), full, "optional participant fields must survive");
    } },

    { group: "participants", name: "removeParticipant also clears presence", async run(store) {
      await withSession(store);
      await store.addParticipant("s1", person("alice"));
      await store.setPresence("s1", { participantId: "alice", status: "active", lastSeenAt: 1 });

      await store.removeParticipant("s1", "alice");

      eq(await store.getParticipant("s1", "alice"), null, "the participant must be gone");
      eq(await store.listPresence("s1"), [], "their presence must be gone too");
    } },

    { group: "participants", name: "scopes the roster per session", async run(store) {
      await withSession(store, "s1");
      await withSession(store, "s2");
      await store.addParticipant("s1", person("alice"));
      await store.addParticipant("s2", person("bob"));

      eq((await store.listParticipants("s1")).map((p) => p.id), ["alice"], "rosters must not leak between sessions");
      eq(await store.getParticipant("s2", "alice"), null, "membership must not leak between sessions");
    } },

    { group: "participants", name: "returns an empty roster for an unknown session", async run(store) {
      eq(await store.listParticipants("nope"), [], "reads of an unknown session return empty");
    } },

    /* -------------------------------------------------------------- */
    { group: "presence", name: "sets and lists", async run(store) {
      await withSession(store);
      await store.setPresence("s1", { participantId: "alice", status: "active", lastSeenAt: 5 });

      eq(await store.listPresence("s1"), [{ participantId: "alice", status: "active", lastSeenAt: 5 }],
        "presence must round-trip");
    } },

    { group: "presence", name: "setPresence is an upsert per participant", async run(store) {
      await withSession(store);
      await store.setPresence("s1", { participantId: "alice", status: "active", lastSeenAt: 5 });
      await store.setPresence("s1", { participantId: "alice", status: "idle", lastSeenAt: 90 });

      const presence = await store.listPresence("s1");
      eq(presence.length, 1, "a heartbeat must replace, not accumulate — this runs every 10 seconds");
      eq(presence[0]?.status, "idle", "the newest heartbeat wins");
      eq(presence[0]?.lastSeenAt, 90, "lastSeenAt must advance");
    } },

    { group: "presence", name: "clears one participant without touching others", async run(store) {
      await withSession(store);
      await store.setPresence("s1", { participantId: "alice", status: "active", lastSeenAt: 5 });
      await store.setPresence("s1", { participantId: "bob", status: "active", lastSeenAt: 5 });

      await store.clearPresence("s1", "alice");

      eq((await store.listPresence("s1")).map((p) => p.participantId), ["bob"],
        "clearing one participant must leave the rest present");
    } },

    { group: "presence", name: "round-trips an opaque cursor", async run(store) {
      await withSession(store);
      const cursor = { anchor: 42, selection: [1, 2, 3], label: "para-7" };
      await store.setPresence("s1", { participantId: "alice", status: "active", lastSeenAt: 5, cursor });

      eq((await store.listPresence("s1"))[0]?.cursor, cursor,
        "cursor is opaque to the package and must survive unchanged");
    } },

    { group: "presence", name: "scopes presence per session", async run(store) {
      await withSession(store, "s1");
      await withSession(store, "s2");
      await store.setPresence("s1", { participantId: "alice", status: "active", lastSeenAt: 5 });

      eq(await store.listPresence("s2"), [], "presence must not leak between sessions");
    } },

    /* -------------------------------------------------------------- */
    { group: "approvals", name: "round-trips a request", async run(store) {
      await withSession(store);
      const request = approval("ap1");
      await store.saveApproval(request);

      eq(await store.getApproval("ap1"), request, "an approval must round-trip exactly");
    } },

    { group: "approvals", name: "round-trips the resolved policy exactly", async run(store) {
      // The governance rule itself. A store that drops it, truncates it, or
      // rebuilds it from `policy.name` has reintroduced the bug where a
      // four-eyes gate resolves on one signature.
      await withSession(store);
      const stored = policy({
        name: "custom",
        quorum: 3,
        allowedRoles: ["owner", "approver", "editor"],
        allowedParticipants: ["carol", "dave"],
        onExpiry: "approve",
        denyIsFinal: false,
      });
      await store.saveApproval(approval("ap1", { policy: stored }));

      eq((await store.getApproval("ap1"))?.policy, stored, "the resolved policy must survive verbatim");
    } },

    { group: "approvals", name: "round-trips tool arguments of any shape", async run(store) {
      await withSession(store);
      const toolArgs = {
        orderId: "4417",
        amountCents: 4000,
        nested: { reasons: ["damaged", "late"], flags: { partial: false } },
        items: [{ sku: "A", qty: 2 }],
      };
      await store.saveApproval(approval("ap1", { toolArgs }));

      // The binding hash is computed over these; a lossy round-trip breaks it.
      eq((await store.getApproval("ap1"))?.toolArgs, toolArgs, "tool arguments must survive verbatim");
    } },

    { group: "approvals", name: "returns null for an unknown approval", async run(store) {
      eq(await store.getApproval("nope"), null, "an unknown approval must read as null");
    } },

    { group: "approvals", name: "saveApproval upserts votes without duplicating", async run(store) {
      await withSession(store);
      await store.saveApproval(approval("ap1"));

      const first = (await store.getApproval("ap1"))!;
      first.votes.push({ participantId: "bob", decision: "approve", votedAt: 10 });
      await store.saveApproval(first);

      const second = (await store.getApproval("ap1"))!;
      second.votes.push({ participantId: "carol", decision: "approve", votedAt: 20 });
      second.status = "approved";
      second.resolvedAt = 20;
      await store.saveApproval(second);

      const final = (await store.getApproval("ap1"))!;
      eq(final.votes.length, 2, "saving twice must not duplicate votes");
      eq(final.votes.map((v) => v.participantId), ["bob", "carol"], "vote order must be preserved");
      eq(final.status, "approved", "status must be updated");
      eq(final.resolvedAt, 20, "resolvedAt must be stored");
    } },

    { group: "approvals", name: "round-trips a vote reason", async run(store) {
      await withSession(store);
      await store.saveApproval(approval("ap1", {
        votes: [{ participantId: "bob", decision: "deny", reason: "amount looks wrong", votedAt: 10 }],
      }));

      eq((await store.getApproval("ap1"))?.votes[0]?.reason, "amount looks wrong",
        "a vote's stated reason is part of the audit story");
    } },

    { group: "approvals", name: "round-trips the workflow binding", async run(store) {
      await withSession(store);
      await store.saveApproval(approval("ap1", { runId: "run_9", stepId: "step_refund" }));

      const found = await store.getApproval("ap1");
      eq(found?.runId, "run_9", "runId must survive");
      eq(found?.stepId, "step_refund", "stepId must survive");
    } },

    { group: "approvals", name: "lists by session", async run(store) {
      await withSession(store, "s1");
      await withSession(store, "s2");
      await store.saveApproval(approval("ap1", { sessionId: "s1" }));
      await store.saveApproval(approval("ap2", { sessionId: "s2" }));

      eq((await store.listApprovals("s1")).map((a) => a.id), ["ap1"], "approvals must not leak between sessions");
    } },

    { group: "approvals", name: "filters by status", async run(store) {
      await withSession(store);
      await store.saveApproval(approval("ap1", { status: "pending" }));
      await store.saveApproval(approval("ap2", { status: "approved" }));
      await store.saveApproval(approval("ap3", { status: "pending" }));

      eq((await store.listApprovals("s1", "pending")).map((a) => a.id).sort(), ["ap1", "ap3"],
        "a status filter must be applied");
      eq((await store.listApprovals("s1")).length, 3, "no filter must return every status");
    } },

    /* -------------------------------------------------------------- */
    { group: "audit", name: "appends and lists", async run(store) {
      await withSession(store);
      await store.appendAudit(entry("e1"));
      await store.appendAudit(entry("e2", { action: "approval.voted", at: 2_000 }));

      eq((await store.listAudit("s1")).map((e) => e.id), ["e1", "e2"], "the ledger must read oldest-first");
    } },

    { group: "audit", name: "returns the most recent entries under a limit", async run(store) {
      // The subtle one. A naive `ORDER BY at ASC LIMIT n` returns the *oldest*
      // entries — the exact opposite — and both look plausible in a response.
      await withSession(store);
      for (let i = 1; i <= 10; i++) {
        await store.appendAudit(entry(`e${i}`, { at: 1_000 + i }));
      }

      const recent = await store.listAudit("s1", 3);
      eq(recent.map((e) => e.id), ["e8", "e9", "e10"],
        "listAudit must return the newest entries, oldest-first within that window");
    } },

    { group: "audit", name: "defaults to a limit of 100", async run(store) {
      await withSession(store);
      for (let i = 1; i <= 120; i++) {
        await store.appendAudit(entry(`e${i}`, { at: 1_000 + i }));
      }

      const page = await store.listAudit("s1");
      eq(page.length, 100, "the default limit is 100");
      eq(page[page.length - 1]?.id, "e120", "the default page must end at the newest entry");
    } },

    { group: "audit", name: "stores a null actor for agent-originated entries", async run(store) {
      await withSession(store);
      await store.appendAudit(entry("e1", { action: "agent.run.started", actorId: null }));

      eq((await store.listAudit("s1"))[0]?.actorId, null, "an agent entry has no actor, and null is not a string");
    } },

    { group: "audit", name: "round-trips the detail payload", async run(store) {
      await withSession(store);
      await store.appendAudit(entry("e1", {
        detail: { approvalId: "ap1", policy: "four-eyes", votes: 2, meta: { ip: null } },
      }));

      eq((await store.listAudit("s1"))[0]?.detail,
        { approvalId: "ap1", policy: "four-eyes", votes: 2, meta: { ip: null } },
        "audit detail must survive verbatim — it is the evidence");
    } },

    { group: "audit", name: "scopes the ledger per session", async run(store) {
      await withSession(store, "s1");
      await withSession(store, "s2");
      await store.appendAudit(entry("e1", { sessionId: "s1" }));
      await store.appendAudit(entry("e2", { sessionId: "s2" }));

      eq((await store.listAudit("s1")).map((e) => e.id), ["e1"], "ledgers must not leak between sessions");
    } },

    { group: "audit", name: "returns an empty ledger for an unknown session", async run(store) {
      eq(await store.listAudit("nope"), [], "reads of an unknown session return empty");
    } },

    /* -------------------------------------------------------------- */
    { group: "isolation", name: "does not hand out mutable internal state", async run(store) {
      // A caller that mutates a returned object must not change what is
      // stored. Free for a real database; easy to get wrong in a cache.
      await withSession(store);
      await store.addParticipant("s1", person("alice"));
      await store.saveApproval(approval("ap1"));

      const roster = await store.listParticipants("s1");
      roster[0]!.displayName = "tampered";
      roster[0]!.role = "owner";

      const request = (await store.getApproval("ap1"))!;
      request.status = "approved";
      request.policy.quorum = 1;
      request.votes.push({ participantId: "mallory", decision: "approve", votedAt: 1 });

      eq((await store.getParticipant("s1", "alice"))?.displayName, "alice",
        "mutating a returned participant must not change the store");
      const reread = (await store.getApproval("ap1"))!;
      eq(reread.status, "pending", "mutating a returned approval must not change the store");
      eq(reread.policy.quorum, 2, "the stored policy must not be reachable by reference");
      eq(reread.votes.length, 0, "the stored votes must not be reachable by reference");
    } },

    { group: "isolation", name: "rejects writes to an unknown session", async run(store) {
      // Reads of a missing session are empty; writes are a bug worth surfacing.
      ok(await rejects(() => store.addParticipant("nope", person("alice"))),
        "adding a participant to a session that does not exist must reject");
      ok(await rejects(() => store.appendAudit(entry("e1", { sessionId: "nope" }))),
        "auditing against a session that does not exist must reject");
    } },
  ];
}

/** Every group name the suite emits, for callers that want to organize output. */
export function conformanceGroups(): string[] {
  return [...new Set(conformanceChecks().map((check) => check.group))];
}
