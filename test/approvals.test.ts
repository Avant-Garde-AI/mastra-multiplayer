import { describe, expect, it } from "vitest";

import { ApprovalGate, bindingHashFor, fourEyes, quorumOf } from "../src/approvals/index.js";
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
