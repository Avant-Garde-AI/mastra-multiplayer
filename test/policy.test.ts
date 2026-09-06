import { describe, expect, it } from "vitest";

import {
  DEFAULT_POLICY,
  canVote,
  evaluate,
  mergePolicy,
  quorumOf,
  remainingApprovals,
} from "../src/approvals/policy.js";
import type { ApprovalRequest, Participant } from "../src/types.js";

const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: "a1",
  sessionId: "s1",
  requestedBy: "alice",
  toolName: "refund",
  toolArgs: { amountCents: 4000 },
  bindingHash: "hash",
  summary: "Refund $40",
  policyName: "sparse",
  status: "pending",
  votes: [],
  createdAt: 0,
  expiresAt: 10_000,
  ...overrides,
});

const bob: Participant = {
  id: "bob",
  displayName: "Bob",
  role: "editor",
  surface: "web",
};

const approved = request({
  votes: [{ participantId: "bob", decision: "approve", votedAt: 1 }],
});
const denied = request({
  votes: [{ participantId: "bob", decision: "deny", votedAt: 1 }],
});

/**
 * A policy assembled from optional config carries `undefined` values, and a
 * plain spread lets them replace the defaults. Three keys fail badly when that
 * happens, in both directions plus a crash.
 */
describe("mergePolicy", () => {
  it("ignores keys that are explicitly undefined", () => {
    const merged = mergePolicy({
      name: "sparse",
      quorum: undefined,
      denyIsFinal: undefined,
      allowedRoles: undefined,
      expiresAfterMs: undefined,
    });

    expect(merged.quorum).toBe(DEFAULT_POLICY.quorum);
    expect(merged.denyIsFinal).toBe(DEFAULT_POLICY.denyIsFinal);
    expect(merged.allowedRoles).toEqual(DEFAULT_POLICY.allowedRoles);
    expect(merged.expiresAfterMs).toBe(DEFAULT_POLICY.expiresAfterMs);
  });

  it("still lets a real value override the default", () => {
    expect(mergePolicy(quorumOf(3)).quorum).toBe(3);
    expect(mergePolicy({ name: "lenient", denyIsFinal: false }).denyIsFinal).toBe(false);
    expect(mergePolicy({ name: "n", quorum: 0 }).quorum).toBe(0);
  });

  it("an undefined quorum does not leave the gate unapprovable", () => {
    // `approvals.length >= undefined` is false for every possible count.
    const policy = { name: "sparse", quorum: undefined };
    expect(evaluate(policy, approved, 1)).toBe("approved");
    expect(remainingApprovals(policy, request())).toBe(DEFAULT_POLICY.quorum);
  });

  it("an undefined denyIsFinal does not make a deny stop resolving", () => {
    expect(evaluate({ name: "sparse", denyIsFinal: undefined }, denied, 1)).toBe("denied");
  });

  it("an undefined allowedRoles does not throw in canVote", () => {
    const eligibility = canVote({ name: "sparse", allowedRoles: undefined }, request(), bob);
    expect(eligibility.eligible).toBe(true);
  });
});
