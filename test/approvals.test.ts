import { describe, expect, it } from "vitest";

import { ApprovalGate, bindingHashFor, fourEyes, quorumOf } from "../src/approvals/index.js";
import { createMultiplayer } from "../src/session.js";
import { EventBus } from "../src/bus/event-bus.js";
import { InMemoryMultiplayerStore } from "../src/storage/index.js";
import type { Participant } from "../src/types.js";

const person = (id: string, role: Participant["role"] = "editor"): Participant => ({
  id,
  displayName: id,
  role,
  surface: "web",
});

async function setup() {
  const store = new InMemoryMultiplayerStore();
  const bus = new EventBus();
  const gate = new ApprovalGate(store, bus);

  await store.createSession({
    id: "s1",
    threadId: "t1",
    agentId: "a1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  for (const p of [person("alice"), person("bob"), person("carol", "viewer")]) {
    await store.addParticipant("s1", p);
  }
  return { store, bus, gate };
}

describe("ApprovalGate", () => {
  it("resolves once quorum is reached", async () => {
    const { gate } = await setup();
    const request = await gate.request({
      sessionId: "s1",
      requestedBy: "alice",
      toolName: "refund",
      toolArgs: { orderId: "123", amount: 40 },
      summary: "Refund order 123",
      policy: quorumOf(2),
    });

    const afterFirst = await gate.vote(request.id, "alice", "approve");
    expect(afterFirst.status).toBe("pending");

    const afterSecond = await gate.vote(request.id, "bob", "approve");
    expect(afterSecond.status).toBe("approved");
  });

  it("blocks the requester under four-eyes", async () => {
    const { gate } = await setup();
    const request = await gate.request({
      sessionId: "s1",
      requestedBy: "alice",
      toolName: "deploy",
      toolArgs: { env: "production" },
      summary: "Deploy to production",
      policy: fourEyes(),
    });

    await expect(gate.vote(request.id, "alice", "approve")).rejects.toThrow(
      /cannot approve their own/i,
    );
  });

  it("rejects voters whose role is not permitted", async () => {
    const { gate } = await setup();
    const request = await gate.request({
      sessionId: "s1",
      requestedBy: "alice",
      toolName: "deploy",
      toolArgs: {},
      summary: "Deploy",
    });

    await expect(gate.vote(request.id, "carol", "approve")).rejects.toThrow(
      /not permitted/i,
    );
  });

  it("treats a single deny as final by default", async () => {
    const { gate } = await setup();
    const request = await gate.request({
      sessionId: "s1",
      requestedBy: "alice",
      toolName: "delete",
      toolArgs: { table: "users" },
      summary: "Drop the users table",
      policy: quorumOf(2),
    });

    const result = await gate.vote(request.id, "bob", "deny", "absolutely not");
    expect(result.status).toBe("denied");
  });

  it("expires unresolved requests as denied", async () => {
    const { gate } = await setup();
    const request = await gate.request({
      sessionId: "s1",
      requestedBy: "alice",
      toolName: "email",
      toolArgs: { to: "all@company.com" },
      summary: "Email everyone",
      policy: quorumOf(1, { expiresAfterMs: -1 }),
    });

    const refreshed = await gate.refresh(request.id);
    expect(refreshed?.status).toBe("expired");
  });

  it("binds an approval to exact arguments", async () => {
    const { gate } = await setup();
    const args = { orderId: "123", amount: 40 };
    const request = await gate.request({
      sessionId: "s1",
      requestedBy: "alice",
      toolName: "refund",
      toolArgs: args,
      summary: "Refund",
    });

    expect(() => gate.assertBinding(request, "refund", args)).not.toThrow();
    expect(() =>
      gate.assertBinding(request, "refund", { orderId: "456", amount: 4000 }),
    ).toThrow(/does not match/i);
  });

  it("hashes argument order independently", () => {
    expect(bindingHashFor("t", { a: 1, b: 2 })).toBe(bindingHashFor("t", { b: 2, a: 1 }));
  });

  it("writes an audit entry for every step", async () => {
    const { gate, store } = await setup();
    const request = await gate.request({
      sessionId: "s1",
      requestedBy: "alice",
      toolName: "refund",
      toolArgs: {},
      summary: "Refund",
    });
    await gate.vote(request.id, "bob", "approve");

    const audit = await store.listAudit("s1");
    const actions = audit.map((entry) => entry.action);
    expect(actions).toContain("approval.requested");
    expect(actions).toContain("approval.voted");
    expect(actions).toContain("approval.resolved");
  });
});

/**
 * A gate whose policy lives in the process loses it on restart. Before R2, a
 * four-eyes request that outlived a deploy resolved on one signature and the
 * audit trail showed nothing unusual — a governance control weakening in
 * silence, which is the worst shape a bug in this package can take.
 *
 * "Restart" here is a second `ApprovalGate` sharing only the store, which is
 * exactly what a redeployed process is.
 */
describe("policy persistence", () => {
  it("stores the resolved policy on the request", async () => {
    const { gate } = await setup();
    const request = await gate.request({
      sessionId: "s1",
      requestedBy: "alice",
      toolName: "refund",
      toolArgs: {},
      summary: "Refund",
      policy: fourEyes(),
    });

    expect(request.policy).toMatchObject({
      name: "four-eyes",
      quorum: 2,
      excludeRequester: true,
      // Defaults resolved at request time, not left to be re-derived later.
      denyIsFinal: true,
      onExpiry: "deny",
      allowedRoles: ["owner", "editor", "approver"],
    });
  });

  it("still needs two approvals after a restart", async () => {
    const { store, bus, gate } = await setup();
    const request = await gate.request({
      sessionId: "s1",
      requestedBy: "alice",
      toolName: "refund",
      toolArgs: { amountCents: 400_000 },
      summary: "Refund $4,000",
      policy: fourEyes(),
    });

    // The deploy. Nothing survives but the store.
    const restarted = new ApprovalGate(store, bus);

    const afterOne = await restarted.vote(request.id, "bob", "approve");
    expect(afterOne.status).toBe("pending");

    await store.addParticipant("s1", person("dave"));
    const afterTwo = await restarted.vote(request.id, "dave", "approve");
    expect(afterTwo.status).toBe("approved");
  });

  it("still excludes the requester after a restart", async () => {
    const { store, bus, gate } = await setup();
    const request = await gate.request({
      sessionId: "s1",
      requestedBy: "alice",
      toolName: "refund",
      toolArgs: {},
      summary: "Refund",
      policy: fourEyes(),
    });

    const restarted = new ApprovalGate(store, bus);

    await expect(restarted.vote(request.id, "alice", "approve")).rejects.toThrow(
      /cannot approve their own/i,
    );
  });

  it("keeps a role restriction across a restart", async () => {
    const { store, bus, gate } = await setup();
    const request = await gate.request({
      sessionId: "s1",
      requestedBy: "alice",
      toolName: "refund",
      toolArgs: {},
      summary: "Refund",
      policy: quorumOf(1, { allowedRoles: ["owner"] }),
    });

    const restarted = new ApprovalGate(store, bus);

    // bob is an editor, which this policy does not permit.
    await expect(restarted.vote(request.id, "bob", "approve")).rejects.toThrow(
      /not permitted/i,
    );
  });

  it("keeps an explicit participant allowlist across a restart", async () => {
    const { store, bus, gate } = await setup();
    const request = await gate.request({
      sessionId: "s1",
      requestedBy: "alice",
      toolName: "refund",
      toolArgs: {},
      summary: "Refund",
      // carol is a viewer, allowlisted by id.
      policy: quorumOf(1, { allowedRoles: ["owner"], allowedParticipants: ["carol"] }),
    });

    const restarted = new ApprovalGate(store, bus);
    const resolved = await restarted.vote(request.id, "carol", "approve");

    expect(resolved.status).toBe("approved");
  });

  it("expires on the restarted gate's own schedule, not the default", async () => {
    const { store, bus, gate } = await setup();
    const request = await gate.request({
      sessionId: "s1",
      requestedBy: "alice",
      toolName: "refund",
      toolArgs: {},
      summary: "Refund",
      policy: fourEyes({ expiresAfterMs: 60_000, onExpiry: "approve" }),
    });

    expect(request.expiresAt).toBe(request.createdAt + 60_000);

    const restarted = new ApprovalGate(store, bus);
    // Force the clock past expiry by rewriting the record.
    await store.saveApproval({ ...request, expiresAt: Date.now() - 1 });

    const refreshed = await restarted.refresh(request.id);
    // onExpiry: "approve" is unusual, which is what makes it a good probe —
    // the default would have denied.
    expect(refreshed?.status).toBe("approved");
  });

  it("does not fall back to the gate's default policy", async () => {
    const { store, bus, gate } = await setup();
    const request = await gate.request({
      sessionId: "s1",
      requestedBy: "alice",
      toolName: "refund",
      toolArgs: {},
      summary: "Refund",
      policy: fourEyes(),
    });

    // A restarted process configured with a *weaker* default must not apply it
    // to a request that was made under a stricter one.
    const restarted = new ApprovalGate(store, bus, { name: "lax", quorum: 1 });
    const afterOne = await restarted.vote(request.id, "bob", "approve");

    expect(afterOne.status).toBe("pending");
  });
});

/**
 * Expiry is evaluated against the clock, but nothing fires on its own. A gate
 * that expires at 3am sits `pending` until someone votes or refreshes it, so
 * "silence is not consent" only holds if something does the asking.
 */
describe("expiry sweep", () => {
  const expired = (gate: ApprovalGate, requestedBy = "alice") =>
    gate.request({
      sessionId: "s1",
      requestedBy,
      toolName: "refund",
      toolArgs: {},
      summary: "Refund",
      // Already past its deadline the moment it is created.
      policy: quorumOf(2, { expiresAfterMs: -1 }),
    });

  it("resolves a request whose deadline has passed", async () => {
    const { gate } = await setup();
    const request = await expired(gate);

    const resolved = await gate.sweepExpired("s1");

    expect(resolved.map((r) => r.id)).toEqual([request.id]);
    expect(resolved[0]?.status).toBe("expired");
  });

  it("leaves a request still inside its window alone", async () => {
    const { gate } = await setup();
    await gate.request({
      sessionId: "s1",
      requestedBy: "alice",
      toolName: "refund",
      toolArgs: {},
      summary: "Refund",
      policy: quorumOf(2, { expiresAfterMs: 60_000 }),
    });

    expect(await gate.sweepExpired("s1")).toEqual([]);
    expect(await gate.pending("s1")).toHaveLength(1);
  });

  it("records the deadline as the resolution time, not when the sweep ran", async () => {
    // The whole point of sweeping. A 3am expiry recorded at 9am is the wrong
    // answer to "when was this decided", and the ledger is what answers it.
    const { gate } = await setup();
    const request = await expired(gate);

    const [resolved] = await gate.sweepExpired("s1");

    expect(resolved?.resolvedAt).toBe(request.expiresAt);
  });

  it("honours onExpiry: approve", async () => {
    const { gate } = await setup();
    await gate.request({
      sessionId: "s1",
      requestedBy: "alice",
      toolName: "refund",
      toolArgs: {},
      summary: "Refund",
      policy: quorumOf(2, { expiresAfterMs: -1, onExpiry: "approve" }),
    });

    const [resolved] = await gate.sweepExpired("s1");
    expect(resolved?.status).toBe("approved");
  });

  it("is idempotent — a second sweep resolves nothing", async () => {
    const { gate } = await setup();
    await expired(gate);

    expect(await gate.sweepExpired("s1")).toHaveLength(1);
    expect(await gate.sweepExpired("s1")).toEqual([]);
  });

  it("announces each resolution to the room", async () => {
    const { bus, gate } = await setup();
    const seen: string[] = [];
    bus.subscribe("s1", (event) => seen.push(event.type));

    await expired(gate);
    seen.length = 0;
    await gate.sweepExpired("s1");

    expect(seen).toEqual(["approval.resolved"]);
  });

  it("writes the resolution to the audit ledger", async () => {
    const { store, gate } = await setup();
    await expired(gate);
    await gate.sweepExpired("s1");

    const audit = await store.listAudit("s1");
    expect(audit.some((e) => e.action === "approval.resolved")).toBe(true);
  });

  it("sweeps every session when driven from the session object", async () => {
    const multiplayer = createMultiplayer({
      agent: {
        id: "a",
        async stream() {
          return { textStream: (async function* () { yield "x"; })() };
        },
      },
    });
    const one = await multiplayer.createSession({ threadId: "t1" });
    const two = await multiplayer.createSession({ threadId: "t2" });

    for (const session of [one, two]) {
      await multiplayer.join(session.id, person("alice"));
      await multiplayer.approvals.request({
        sessionId: session.id,
        requestedBy: "alice",
        toolName: "refund",
        toolArgs: {},
        summary: "Refund",
        policy: quorumOf(2, { expiresAfterMs: -1 }),
      });
    }

    const resolved = await multiplayer.sweepExpiredApprovals();
    expect(resolved).toHaveLength(2);
    expect(new Set(resolved.map((r) => r.sessionId))).toEqual(
      new Set([one.id, two.id]),
    );
  });

  it("keeps sweeping when one request cannot be refreshed", async () => {
    // One broken record must not strand every other expired gate in the
    // session — a sweep that stops on the first error resolves nothing.
    const { store, bus } = await setup();
    const logged: string[] = [];
    const gate = new ApprovalGate(store, bus, { name: "default" }, {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message) => logged.push(message),
    });

    const bad = await expired(gate);
    const good = await expired(gate, "bob");

    const original = store.getApproval.bind(store);
    store.getApproval = async (id) => {
      if (id === bad.id) throw new Error("storage blip");
      return original(id);
    };

    const resolved = await gate.sweepExpired("s1");

    expect(resolved.map((r) => r.id)).toEqual([good.id]);
    expect(logged.some((m) => m.includes("could not refresh"))).toBe(true);
  });
});
