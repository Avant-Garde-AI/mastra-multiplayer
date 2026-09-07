/**
 * The resumer's failure paths, against a fake workflow registry.
 *
 * The real-engine tests in `workflows.integration.test.ts` prove the happy
 * paths. These prove the ones a real engine will not produce on demand: a
 * workflow that is not registered, a run that has vanished, a resume that
 * throws, and two gates suspended in one run.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApprovalGate, bindingHashFor } from "../src/approvals/index.js";
import { EventBus } from "../src/bus/event-bus.js";
import { InMemoryTurnLease } from "../src/concurrency/lease.js";
import { silentLogger } from "../src/internal/logger.js";
import { InMemoryMultiplayerStore } from "../src/storage/index.js";
import {
  ApprovalResumer,
  approvalStep,
  type WorkflowLike,
  type WorkflowRegistryLike,
  type WorkflowRunLike,
} from "../src/workflows/index.js";
import type { ApprovalRequest, Participant } from "../src/types.js";

interface FakeRun {
  status: string;
  suspendedPaths?: Record<string, unknown>;
}

/** A registry whose runs are a plain map, so any state can be arranged. */
class FakeWorkflows implements WorkflowRegistryLike, WorkflowLike {
  readonly runs = new Map<string, FakeRun>();
  readonly resumed: Array<{ step: unknown; resumeData: unknown }> = [];
  registered = true;
  throwOnResume: Error | undefined;
  throwOnRead: Error | undefined;

  getWorkflow(id: string): WorkflowLike | undefined {
    if (!this.registered) throw new Error(`Workflow "${id}" is not registered`);
    return this;
  }

  async getWorkflowRunById(runId: string): Promise<FakeRun | null> {
    if (this.throwOnRead) throw this.throwOnRead;
    return this.runs.get(runId) ?? null;
  }

  async createRun(options?: { runId?: string }): Promise<WorkflowRunLike> {
    const runs = this.runs;
    const self = this;
    return {
      async resume(params) {
        if (self.throwOnResume) throw self.throwOnResume;
        self.resumed.push({ step: params.step, resumeData: params.resumeData });
        runs.set(options?.runId ?? "", { status: "success" });
        return { status: "success" };
      },
    };
  }
}

const alice: Participant = {
  id: "alice",
  displayName: "Alice",
  role: "approver",
  surface: "web",
};

describe("ApprovalResumer", () => {
  let store: InMemoryMultiplayerStore;
  let approvals: ApprovalGate;
  let workflows: FakeWorkflows;
  let host: { approvals: ApprovalGate; store: InMemoryMultiplayerStore };

  beforeEach(async () => {
    store = new InMemoryMultiplayerStore();
    approvals = new ApprovalGate(store, new EventBus(), { name: "one" }, silentLogger);
    workflows = new FakeWorkflows();
    host = { approvals, store };
    await store.createSession({
      id: "s1",
      threadId: "t1",
      agentId: "agent",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await store.addParticipant("s1", alice);
  });

  /** A gate suspended in `run-1`, decided but not yet resumed. */
  async function decidedGate(
    overrides: Partial<ApprovalRequest> = {},
  ): Promise<ApprovalRequest> {
    const request = await approvals.request({
      sessionId: "s1",
      requestedBy: "agent",
      toolName: "refund",
      toolArgs: { amountCents: 100 },
      summary: "Refund $1",
      workflowId: "refund",
      runId: "run-1",
      stepId: "gate",
    });
    const decided = { ...request, status: "approved" as const, ...overrides };
    await store.saveApproval(decided);
    workflows.runs.set("run-1", { status: "suspended", suspendedPaths: { gate: [0] } });
    return decided;
  }

  function resumer(options: Parameters<typeof makeResumer>[0] = {}) {
    return makeResumer(options);
  }

  function makeResumer(options: { lease?: InMemoryTurnLease } = {}) {
    return new ApprovalResumer(host, workflows, { ...options, logger: silentLogger });
  }

  it("resumes the step named on the request, with the decision", async () => {
    const request = await decidedGate();

    expect((await resumer().resume(request)).outcome).toBe("resumed");
    expect(workflows.resumed).toEqual([
      { step: "gate", resumeData: { approvalId: request.id, status: "approved" } },
    ]);
  });

  it("reports a failure, and does not mark the gate, when the workflow is unregistered", async () => {
    const request = await decidedGate();
    workflows.registered = false;

    const result = await resumer().resume(request);

    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("not registered");
    // Unmarked on purpose: registering the workflow is a deploy away, and a
    // gate that gave up here would never recover.
    expect((await store.getApproval(request.id))!.resumedAt).toBeUndefined();
  });

  it("reports a failure, and does not mark the gate, when the run is gone", async () => {
    const request = await decidedGate();
    workflows.runs.delete("run-1");

    const result = await resumer().resume(request);

    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("not found");
    expect((await store.getApproval(request.id))!.resumedAt).toBeUndefined();
  });

  it("reports a failure when the run cannot be read", async () => {
    const request = await decidedGate();
    workflows.throwOnRead = new Error("storage down");

    expect((await resumer().resume(request)).outcome).toBe("failed");
  });

  it("reports a failure, leaving the gate for the next sweep, when resume throws", async () => {
    const request = await decidedGate();
    workflows.throwOnResume = new Error("run is locked");

    const result = await resumer().resume(request);

    expect(result.outcome).toBe("failed");
    expect((await store.getApproval(request.id))!.resumedAt).toBeUndefined();
  });

  it("marks a gate whose run already moved on, so the sweep stops looking at it", async () => {
    const request = await decidedGate();
    workflows.runs.set("run-1", { status: "success" });

    const result = await resumer().resume(request);

    expect(result.outcome).toBe("skipped");
    expect(workflows.resumed).toEqual([]);
    expect((await store.getApproval(request.id))!.resumedAt).toBeTypeOf("number");
  });

  it("leaves another gate in the same run alone", async () => {
    const request = await decidedGate();
    // The run is suspended — but on a different gate. Resuming here would wake
    // the wrong step with the wrong decision.
    workflows.runs.set("run-1", {
      status: "suspended",
      suspendedPaths: { "other-gate": [1] },
    });

    expect((await resumer().resume(request)).outcome).toBe("skipped");
    expect(workflows.resumed).toEqual([]);
  });

  it("skips a request that is still pending", async () => {
    const request = await approvals.request({
      sessionId: "s1",
      requestedBy: "agent",
      toolName: "refund",
      toolArgs: {},
      summary: "Refund",
      workflowId: "refund",
      runId: "run-1",
      stepId: "gate",
    });

    expect((await resumer().resume(request)).outcome).toBe("skipped");
    expect(workflows.resumed).toEqual([]);
  });

  it("skips a decision that is not attached to a workflow at all", async () => {
    const request = await approvals.request({
      sessionId: "s1",
      requestedBy: "agent",
      toolName: "refund",
      toolArgs: {},
      summary: "Refund",
    });
    const decided = { ...request, status: "approved" as const };

    expect((await resumer().resume(decided)).outcome).toBe("skipped");
  });

  it("lets only one of two instances resume, when they share a lease", async () => {
    const request = await decidedGate();
    const lease = new InMemoryTurnLease();

    const outcomes = await Promise.all([
      resumer({ lease }).resume(request),
      resumer({ lease }).resume(request),
    ]);

    expect(outcomes.filter((r) => r.outcome === "resumed")).toHaveLength(1);
    expect(workflows.resumed).toHaveLength(1);
  });

  it("keys the lease per approval, so one gate does not block another", async () => {
    const lease = new InMemoryTurnLease();
    const acquire = vi.spyOn(lease, "acquire");
    const request = await decidedGate();

    await resumer({ lease }).resume(request);

    // Not the session id: sharing that key with turn-taking would make a
    // resume and an agent run fight over the same lock.
    expect(acquire.mock.calls[0]![0]).toBe(`approval:${request.id}`);
    expect(acquire.mock.calls[0]![0]).not.toBe("s1");
  });

  it("releases the lease even when the resume fails", async () => {
    const request = await decidedGate();
    const lease = new InMemoryTurnLease();
    workflows.throwOnResume = new Error("nope");

    await resumer({ lease }).resume(request);

    workflows.throwOnResume = undefined;
    expect((await resumer({ lease }).resume(request)).outcome).toBe("resumed");
  });

  it("resumes on a decision made in this process once started", async () => {
    const request = await approvals.request({
      sessionId: "s1",
      requestedBy: "agent",
      toolName: "refund",
      toolArgs: {},
      summary: "Refund",
      workflowId: "refund",
      runId: "run-1",
      stepId: "gate",
    });
    workflows.runs.set("run-1", { status: "suspended", suspendedPaths: { gate: [0] } });

    const instance = resumer();
    await instance.start();
    await approvals.vote(request.id, "alice", "approve");
    await instance.idle();

    expect(workflows.resumed).toHaveLength(1);
    instance.stop();
  });

  it("stops resuming once stopped", async () => {
    const request = await approvals.request({
      sessionId: "s1",
      requestedBy: "agent",
      toolName: "refund",
      toolArgs: {},
      summary: "Refund",
      workflowId: "refund",
      runId: "run-1",
      stepId: "gate",
    });
    workflows.runs.set("run-1", { status: "suspended", suspendedPaths: { gate: [0] } });

    const instance = resumer();
    await instance.start();
    instance.stop();
    await approvals.vote(request.id, "alice", "approve");
    await instance.idle();

    expect(workflows.resumed).toEqual([]);
  });

  it("reconciles across every session on start", async () => {
    await store.createSession({
      id: "s2",
      threadId: "t2",
      agentId: "agent",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await decidedGate();
    const other = await approvals.request({
      sessionId: "s2",
      requestedBy: "agent",
      toolName: "deploy",
      toolArgs: {},
      summary: "Deploy",
      workflowId: "deploy",
      runId: "run-2",
      stepId: "gate",
    });
    await store.saveApproval({ ...other, status: "denied" });
    workflows.runs.set("run-2", { status: "suspended", suspendedPaths: { gate: [0] } });

    const instance = resumer();
    await instance.start();
    await instance.idle();

    // Both sessions swept, and an expired or denied gate is resumed exactly
    // like an approved one — otherwise a refusal is the case that hangs.
    expect(workflows.resumed).toHaveLength(2);
    instance.stop();
  });

  it("survives a handler that throws without failing the vote", async () => {
    const request = await approvals.request({
      sessionId: "s1",
      requestedBy: "agent",
      toolName: "refund",
      toolArgs: {},
      summary: "Refund",
    });
    approvals.onResolved(() => {
      throw new Error("resumer exploded");
    });

    await expect(approvals.vote(request.id, "alice", "approve")).resolves.toMatchObject({
      status: "approved",
    });
  });
});

describe("approvalStep", () => {
  let store: InMemoryMultiplayerStore;
  let approvals: ApprovalGate;

  beforeEach(async () => {
    store = new InMemoryMultiplayerStore();
    approvals = new ApprovalGate(store, new EventBus(), { name: "one" }, silentLogger);
    await store.createSession({
      id: "s1",
      threadId: "t1",
      agentId: "agent",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await store.addParticipant("s1", alice);
  });

  function gate(overrides: Record<string, unknown> = {}) {
    return approvalStep<unknown, unknown, { amountCents: number }>(
      { approvals, store },
      {
        id: "gate",
        inputSchema: {},
        outputSchema: {},
        workflowId: "refund",
        toolName: "refund",
        sessionId: "s1",
        requestedBy: "agent",
        summary: "Refund",
        ...overrides,
      },
    );
  }

  const harness = () => {
    const calls = { suspended: [] as unknown[], bailed: [] as unknown[] };
    return {
      calls,
      params: (extra: Record<string, unknown> = {}) => ({
        inputData: { amountCents: 100 },
        suspend: (payload?: unknown) => {
          calls.suspended.push(payload);
          return "suspended";
        },
        bail: (result: unknown) => {
          calls.bailed.push(result);
          return "bailed";
        },
        runId: "run-1",
        ...extra,
      }),
    };
  };

  it("opens a request and suspends when there is no resume data", async () => {
    const { calls, params } = harness();

    const outcome = await gate().execute(params() as never);

    expect(outcome).toBe("suspended");
    const [request] = await approvals.pending("s1");
    expect(request!.workflowId).toBe("refund");
    expect(request!.runId).toBe("run-1");
    expect(request!.stepId).toBe("gate");
    expect(calls.suspended[0]).toMatchObject({
      approvalId: request!.id,
      toolName: "refund",
      votesNeeded: 1,
    });
  });

  it("binds to the resolved arguments, not the raw input, when told to", async () => {
    const { params } = harness();

    await gate({ toolArgs: () => ({ normalized: true }) }).execute(params() as never);

    const [request] = await approvals.pending("s1");
    expect(request!.bindingHash).toBe(bindingHashFor("refund", { normalized: true }));
  });

  it("passes the input through on approval", async () => {
    const { params } = harness();
    const step = gate();
    await step.execute(params() as never);
    const [request] = await approvals.pending("s1");
    await approvals.vote(request!.id, "alice", "approve");

    const outcome = await step.execute(
      params({ resumeData: { approvalId: request!.id } }) as never,
    );

    expect(outcome).toEqual({ amountCents: 100 });
  });

  it("bails on a denial rather than throwing", async () => {
    const { calls, params } = harness();
    const step = gate();
    await step.execute(params() as never);
    const [request] = await approvals.pending("s1");
    await approvals.vote(request!.id, "alice", "deny");

    const outcome = await step.execute(
      params({ resumeData: { approvalId: request!.id } }) as never,
    );

    expect(outcome).toBe("bailed");
    expect(calls.bailed[0]).toEqual({
      approved: false,
      approvalId: request!.id,
      status: "denied",
    });
  });

  it("throws rather than bailing when the arguments no longer match the approval", async () => {
    const { params } = harness();
    const step = gate();
    await step.execute(params() as never);
    const [request] = await approvals.pending("s1");
    await approvals.vote(request!.id, "alice", "approve");

    // The run resumes with different arguments than were approved. This is not
    // a refusal to record — it is an unauthorized call, and it must not be a
    // quiet `bail`.
    await expect(
      step.execute({
        ...params({ resumeData: { approvalId: request!.id } }),
        inputData: { amountCents: 999_999 },
      } as never),
    ).rejects.toThrow(/does not match/);
  });

  it("throws when resumed without an approval id", async () => {
    const { params } = harness();

    await expect(
      gate().execute(params({ resumeData: { approvalId: "" } }) as never),
    ).rejects.toThrow(/without an approvalId/);
  });

  it("throws when the approval it was waiting on has vanished", async () => {
    const { params } = harness();

    await expect(
      gate().execute(params({ resumeData: { approvalId: "gone" } }) as never),
    ).rejects.toThrow(/no longer exists/);
  });
});
