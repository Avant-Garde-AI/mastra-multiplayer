/**
 * A refund that cannot happen until two different people sign off, and never
 * the person who asked for it.
 *
 * Nothing here waits. The gate step opens an approval request and suspends;
 * Mastra writes the run to its snapshot and the process is free. Whenever the
 * votes land — a minute later, or after a deploy — the resumer wakes the run
 * and `issueRefund` finally executes, with the binding re-checked against the
 * arguments it is about to use.
 *
 * Compare [`refund-tool-polling.ts`](./refund-tool-polling.ts), which does the
 * same governance by blocking inside a tool. That version holds an agent run
 * open for the length of a human decision and loses it on restart.
 */
// @ts-nocheck
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import { fourEyes } from "@avant-garde-ai/mastra-multiplayer";
import { approvalStep, approvalResumer } from "@avant-garde-ai/mastra-multiplayer/workflows";
import { multiplayer } from "../shared-session/mastra.js";

const refundArgs = z.object({
  sessionId: z.string(),
  requestedBy: z.string(),
  orderId: z.string(),
  amountCents: z.number().int().positive(),
  reason: z.string(),
});

type RefundArgs = z.infer<typeof refundArgs>;

/**
 * The gate. Its `workflowId` must match what the workflow is registered under,
 * because that is how a resumer in another process finds the run again.
 */
const approveRefund = createStep(
  approvalStep<typeof refundArgs, typeof refundArgs, RefundArgs>(multiplayer, {
    id: "approve-refund",
    inputSchema: refundArgs,
    outputSchema: refundArgs,
    workflowId: "refund",
    toolName: "refund-order",
    // Two approvals, and the requester is not eligible to be one of them.
    policy: fourEyes({ expiresAfterMs: 10 * 60 * 1000 }),
    sessionId: ({ inputData }) => inputData.sessionId,
    requestedBy: ({ inputData }) => inputData.requestedBy,
    summary: ({ inputData }) =>
      `Refund $${(inputData.amountCents / 100).toFixed(2)} on order ${inputData.orderId}`,
  }),
);

/**
 * Runs only on approval.
 *
 * There is no `if (approved)` here, and there should not be: a denied or
 * expired gate bails the run before this step is reached. A check would be a
 * second copy of the rule, free to disagree with the first.
 */
const issueRefund = createStep({
  id: "issue-refund",
  inputSchema: refundArgs,
  outputSchema: z.object({ status: z.literal("refunded"), orderId: z.string() }),
  execute: async ({ inputData }) => {
    // Your payment provider call goes here.
    console.log(`Refunding ${inputData.amountCents} on ${inputData.orderId}`);
    return { status: "refunded" as const, orderId: inputData.orderId };
  },
});

export const refundWorkflow = createWorkflow({
  id: "refund",
  inputSchema: refundArgs,
  outputSchema: z.object({ status: z.string(), orderId: z.string() }),
})
  .then(approveRefund)
  .then(issueRefund)
  .commit();

/**
 * Start this once per process, wherever you construct `mastra`.
 *
 * `start()` also reconciles: any gate decided while this process was down is
 * found and resumed on the way up. Without that, a vote taken during a deploy
 * leaves the run suspended for ever with the ledger insisting it was approved.
 *
 * Behind more than one instance, pass a `RedisTurnLease` so only one of them
 * resumes each run.
 */
export async function startResumer(mastra) {
  const resumer = approvalResumer(multiplayer, mastra);
  const stop = await resumer.start();

  // Expiry fires nothing on its own, and an expired gate has to wake its run
  // exactly like a denied one. Sweeping publishes those decisions, and the
  // resumer is already listening.
  const sweep = setInterval(() => {
    void multiplayer.sweepExpiredApprovals();
  }, 60_000);

  return async () => {
    clearInterval(sweep);
    stop();
    await resumer.idle();
  };
}
