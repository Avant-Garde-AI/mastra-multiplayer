/**
 * The gate and the resumer against the real `@mastra/core` workflow engine.
 *
 * Everything else in this suite fakes the Mastra surface, which is the right
 * default — the package must build and test with no peer installed. But this is
 * the one feature where a fake proves nothing: the whole design rests on how
 * `suspend`, `bail`, `resumeData` and `createRun({ runId })` actually behave,
 * and a fake that agrees with my reading of the types would agree with a
 * misreading just as happily.
 *
 * `@mastra/core` is a devDependency here and an optional peer for consumers, so
 * this file skips when it is not installed rather than failing.
 */
import { describe, expect, it } from "vitest";

import { InMemoryTurnLease } from "../src/concurrency/lease.js";
import { InMemoryMultiplayerStore } from "../src/storage/index.js";
import { MultiplayerSession } from "../src/session.js";
import { fourEyes } from "../src/approvals/policy.js";
import { silentLogger } from "../src/internal/logger.js";
import {
  approvalResumer,
  approvalStep,
  type WorkflowRegistryLike,
} from "../src/workflows/index.js";
import type { Participant } from "../src/types.js";

const mastraCore = await import("@mastra/core").catch(() => null);
const mastraWorkflows = await import("@mastra/core/workflows").catch(() => null);
const zod = await import("zod").catch(() => null);

const canRun = Boolean(mastraCore && mastraWorkflows && zod);

const agent = {
  id: "test-agent",
  stream: async () => ({
    textStream: (async function* () {
      yield "ok";
    })(),
  }),
};

function participant(id: string, role: Participant["role"] = "approver"): Participant {
  return { id, displayName: id, role, surface: "web" };
}

describe.skipIf(!canRun)("workflow approval gates against @mastra/core", () => {
  const { Mastra } = mastraCore!;
  const { createWorkflow, createStep } = mastraWorkflows!;
  const { z } = zod!;

  const refundArgs = z.object({ amountCents: z.number(), orderId: z.string() });
  type RefundArgs = { amountCents: number; orderId: string };

  /**
   * A refund workflow whose second step must not run without sign-off, wired to
   * a fresh multiplayer session.
   */
  async function build(options: { policy?: ReturnType<typeof fourEyes> } = {}) {
    const store = new InMemoryMultiplayerStore();
    const multiplayer = new MultiplayerSession({
      agent,
      store,
      logger: silentLogger,
    });
    const session = await multiplayer.createSession({ threadId: "thread-1" });
    await multiplayer.join(session.id, participant("alice"));
    await multiplayer.join(session.id, participant("bob"));

    const refunded: Array<{ orderId: string; amountCents: number }> = [];

    const gate = createStep(
      approvalStep<typeof refundArgs, typeof refundArgs, RefundArgs>(
        multiplayer,
        {
          id: "refund-approval",
          inputSchema: refundArgs,
          outputSchema: refundArgs,
          resumeSchema: z.object({ approvalId: z.string(), status: z.string().optional() }),
          suspendSchema: z.object({
            approvalId: z.string(),
            toolName: z.string(),
            summary: z.string(),
            votesNeeded: z.number(),
            expiresAt: z.number(),
          }),
          workflowId: "refund",
          toolName: "refund-order",
          policy: options.policy ?? fourEyes(),
          sessionId: session.id,
          requestedBy: "support-agent",
          summary: ({ inputData }) => `Refund $${inputData.amountCents / 100}`,
          onDenied: ({ inputData }) => ({ amountCents: 0, orderId: inputData.orderId }),
        },
      ),
    );

    const doRefund = createStep({
      id: "do-refund",
      inputSchema: refundArgs,
      outputSchema: refundArgs,
      execute: async ({ inputData }) => {
        refunded.push(inputData);
        return inputData;
      },
    });

    const workflow = createWorkflow({
      id: "refund",
      inputSchema: refundArgs,
      outputSchema: refundArgs,
    })
      .then(gate)
      .then(doRefund)
      .commit();

    const mastra = new Mastra({ workflows: { refund: workflow }, logger: false });

    // A type-level assertion, and the reason `WorkflowRegistryLike` is written
    // the way it is: a real `Mastra` has to satisfy it with no cast, or every
    // consumer writes one.
    const registry: WorkflowRegistryLike = mastra;
    void registry;

    return { multiplayer, store, session, mastra, workflow, refunded };
  }

  async function startRun(
    mastra: { getWorkflow(id: string): any },
    runId: string,
    inputData = { amountCents: 4000, orderId: "order-1" },
  ) {
    const run = await mastra.getWorkflow("refund").createRun({ runId });
    return run.start({ inputData });
  }

  it("suspends on the first execute and records the run on the request", async () => {
    const { multiplayer, session, mastra, refunded } = await build();

    const started = await startRun(mastra, "run-suspend");

    expect(started.status).toBe("suspended");
    expect(refunded).toEqual([]);

    const [request] = await multiplayer.approvals.pending(session.id);
    expect(request).toBeDefined();
    expect(request!.workflowId).toBe("refund");
    expect(request!.runId).toBe("run-suspend");
    expect(request!.stepId).toBe("refund-approval");
    // The binding covers the arguments the step will actually run with.
    expect(request!.toolArgs).toEqual({ amountCents: 4000, orderId: "order-1" });
  });

  it("resumes the run and lets the gated step through once a quorum approves", async () => {
    const { multiplayer, mastra, session, refunded } = await build();
    const resumer = approvalResumer(multiplayer, mastra, {
      logger: silentLogger,
    });
    await resumer.start();

    await startRun(mastra, "run-approve");
    const [request] = await multiplayer.approvals.pending(session.id);

    await multiplayer.approvals.vote(request!.id, "alice", "approve");
    await multiplayer.approvals.vote(request!.id, "bob", "approve");
    await resumer.idle();

    expect(refunded).toEqual([{ amountCents: 4000, orderId: "order-1" }]);

    const state = await mastra.getWorkflow("refund").getWorkflowRunById("run-approve");
    expect(state?.status).toBe("success");
    resumer.stop();
  });

  it("bails the run without executing the gated step when the gate is denied", async () => {
    const { multiplayer, mastra, session, refunded } = await build();
    const resumer = approvalResumer(multiplayer, mastra, {
      logger: silentLogger,
    });
    await resumer.start();

    await startRun(mastra, "run-deny");
    const [request] = await multiplayer.approvals.pending(session.id);

    await multiplayer.approvals.vote(request!.id, "bob", "deny");
    await resumer.idle();

    expect(refunded).toEqual([]);
    const state = await mastra.getWorkflow("refund").getWorkflowRunById("run-deny");
    // A denial is a finished run, not a failed one.
    expect(state?.status).toBe("success");
    resumer.stop();
  });

  it("resumes a run whose gate expired, so a timed-out gate does not hang", async () => {
    const { multiplayer, mastra, session, refunded } = await build({
      policy: { ...fourEyes(), name: "expiring", expiresAfterMs: 1 },
    });
    const resumer = approvalResumer(multiplayer, mastra, {
      logger: silentLogger,
    });
    await resumer.start();

    await startRun(mastra, "run-expire");
    await new Promise((done) => setTimeout(done, 5));

    const [expired] = await multiplayer.approvals.sweepExpired(session.id);
    expect(expired!.status).toBe("expired");
    await resumer.idle();

    expect(refunded).toEqual([]);
    const state = await mastra.getWorkflow("refund").getWorkflowRunById("run-expire");
    expect(state?.status).toBe("success");
    resumer.stop();
  });

  it("reconciles a decision made while no resumer was listening", async () => {
    const { multiplayer, mastra, session, refunded } = await build();

    // No resumer running: the votes land, the ledger says approved, and the run
    // stays suspended. This is the restart-shaped failure.
    await startRun(mastra, "run-reconcile");
    const [request] = await multiplayer.approvals.pending(session.id);
    await multiplayer.approvals.vote(request!.id, "alice", "approve");
    await multiplayer.approvals.vote(request!.id, "bob", "approve");

    expect(refunded).toEqual([]);
    expect(
      (await mastra.getWorkflow("refund").getWorkflowRunById("run-reconcile"))?.status,
    ).toBe("suspended");

    const resumer = approvalResumer(multiplayer, mastra, {
      logger: silentLogger,
    });
    await resumer.start();
    await resumer.idle();

    expect(refunded).toEqual([{ amountCents: 4000, orderId: "order-1" }]);
    resumer.stop();
  });

  it("resumes once when two instances react to the same decision", async () => {
    const { multiplayer, mastra, session, refunded } = await build();
    const lease = new InMemoryTurnLease();

    // Two resumers, one shared lease — the shape of two app instances behind a
    // load balancer, both listening to the same store.
    const one = approvalResumer(multiplayer, mastra, {
      lease,
      logger: silentLogger,
    });
    const two = approvalResumer(multiplayer, mastra, {
      lease,
      logger: silentLogger,
    });
    await one.start();
    await two.start();

    await startRun(mastra, "run-double");
    const [request] = await multiplayer.approvals.pending(session.id);
    await multiplayer.approvals.vote(request!.id, "alice", "approve");
    await multiplayer.approvals.vote(request!.id, "bob", "approve");

    await Promise.all([one.idle(), two.idle()]);

    // Resumed exactly once — a second resume would run the refund twice.
    //
    // This holds with the lease removed, because Mastra refuses to resume a run
    // that is not suspended, so the loser of the race fails rather than
    // double-refunding. That is the point: the lease turns a noisy, engine-caught
    // race into a quiet skip, and it is *not* the only thing standing between a
    // decision and a duplicate side effect. The lease itself is pinned by
    // "lets only one of two instances resume" in `workflows.test.ts`.
    expect(refunded).toEqual([{ amountCents: 4000, orderId: "order-1" }]);
    one.stop();
    two.stop();
  });

  it("ignores an 'approved' handed to resume for a request the store says was denied", async () => {
    const { multiplayer, mastra, session, refunded } = await build();

    await startRun(mastra, "run-forged");
    const [request] = await multiplayer.approvals.pending(session.id);
    await multiplayer.approvals.vote(request!.id, "bob", "deny");

    // Nothing resumed it yet. Now resume it by hand, claiming approval — the
    // shape of anyone who can reach `run.resume()` forging a decision.
    const run = await mastra.getWorkflow("refund").createRun({ runId: "run-forged" });
    const outcome = await run.resume({
      step: "refund-approval",
      resumeData: { approvalId: request!.id, status: "approved" },
    });

    // The step re-read the store and bailed anyway.
    expect(outcome.status).toBe("success");
    expect(refunded).toEqual([]);
  });

  it("does not re-check a gate it has already dealt with", async () => {
    const { multiplayer, mastra, session } = await build();
    const resumer = approvalResumer(multiplayer, mastra, {
      logger: silentLogger,
    });

    await startRun(mastra, "run-once");
    const [request] = await multiplayer.approvals.pending(session.id);
    await multiplayer.approvals.vote(request!.id, "alice", "approve");
    await multiplayer.approvals.vote(request!.id, "bob", "approve");

    const first = await resumer.reconcile();
    expect(first.map((r) => r.outcome)).toEqual(["resumed"]);

    // Second sweep: the request is marked, so it is not looked at again. Without
    // the marker this returns a "skipped" — one wasted round trip per sweep,
    // per approval, for the life of the deployment.
    expect(await resumer.reconcile()).toEqual([]);
  });

  it("fails the run rather than proceeding when the arguments changed under the approval", async () => {
    const { multiplayer, mastra, session } = await build();

    await startRun(mastra, "run-tamper");
    const [request] = await multiplayer.approvals.pending(session.id);
    await multiplayer.approvals.vote(request!.id, "alice", "approve");
    await multiplayer.approvals.vote(request!.id, "bob", "approve");

    // Rewrite the binding to something else, as an attacker replaying an
    // approval for a different refund would need it to be.
    const tampered = (await multiplayer.store.getApproval(request!.id))!;
    await multiplayer.store.saveApproval({ ...tampered, bindingHash: "not-the-same" });

    const run = await mastra.getWorkflow("refund").createRun({ runId: "run-tamper" });
    const outcome = await run.resume({
      step: "refund-approval",
      resumeData: { approvalId: request!.id, status: "approved" },
    });

    expect(outcome.status).toBe("failed");
  });
});
