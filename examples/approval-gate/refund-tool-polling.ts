/**
 * A gated tool for an agent with no workflows: request approval, then block
 * until someone decides.
 *
 * **Prefer [`refund-workflow.ts`](./refund-workflow.ts) if you have workflows.**
 * Waiting inside `execute` holds an agent run open for as long as the humans
 * take, and the wait dies with the process — a restart mid-approval loses the
 * refund even though the ledger records a decision. A suspended workflow step
 * survives both, because the waiting lives in Mastra's durable snapshot rather
 * than in a promise.
 *
 * This version stays because not every agent has a workflow to hang the gate
 * on, and a ten-minute wait in a long-lived process is a real, working answer.
 * The governance is identical either way: same policies, same binding, same
 * ledger.
 */
// @ts-nocheck
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { fourEyes } from "@avant-garde-ai/mastra-multiplayer";
import { multiplayer } from "../shared-session/mastra.js";

export const refundTool = createTool({
  id: "refund-order",
  description: "Issue a refund against a customer order.",
  inputSchema: z.object({
    orderId: z.string(),
    amountCents: z.number().int().positive(),
    reason: z.string(),
  }),
  outputSchema: z.object({
    status: z.enum(["refunded", "denied", "expired"]),
    approvalId: z.string(),
  }),
  execute: async ({ context, runtimeContext }) => {
    const sessionId = runtimeContext.get("sessionId");
    const requestedBy = runtimeContext.get("participantId");

    const request = await multiplayer.approvals.request({
      sessionId,
      requestedBy,
      toolName: "refund-order",
      toolArgs: context,
      summary: `Refund $${(context.amountCents / 100).toFixed(2)} on order ${context.orderId}`,
      // Two approvals, and the requester is not eligible to be one of them.
      policy: fourEyes({ expiresAfterMs: 10 * 60 * 1000 }),
    });

    const decision = await waitForDecision(request.id);

    if (decision.status !== "approved") {
      return { status: decision.status === "denied" ? "denied" : "expired", approvalId: request.id };
    }

    // Re-verify before acting: the approval must still match these exact args.
    multiplayer.approvals.assertBinding(decision, "refund-order", context);

    await issueRefund(context.orderId, context.amountCents);
    return { status: "refunded", approvalId: request.id };
  },
});

/** Resolves when the approval leaves `pending`, or when it expires. */
function waitForDecision(approvalId: string) {
  return new Promise(async (resolve) => {
    const initial = await multiplayer.store.getApproval(approvalId);
    if (!initial) throw new Error("Approval vanished");

    const unsubscribe = multiplayer.bus.subscribe(initial.sessionId, (event) => {
      if (
        event.type === "approval.resolved" &&
        event.request.id === approvalId
      ) {
        unsubscribe();
        clearInterval(poll);
        resolve(event.request);
      }
    });

    // Expiry produces no vote, so poll the clock as well as the bus.
    const poll = setInterval(async () => {
      const refreshed = await multiplayer.approvals.refresh(approvalId);
      if (refreshed && refreshed.status !== "pending") {
        unsubscribe();
        clearInterval(poll);
        resolve(refreshed);
      }
    }, 5_000);
  });
}

async function issueRefund(orderId: string, amountCents: number) {
  // Your payment provider call goes here.
  console.log(`Refunding ${amountCents} on ${orderId}`);
}
