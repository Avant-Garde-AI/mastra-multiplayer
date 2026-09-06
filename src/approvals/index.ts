import { createHash, randomUUID } from "node:crypto";

import type { EventBus } from "../bus/event-bus.js";
import type { MultiplayerStore } from "../storage/index.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  AuditAction,
  ParticipantId,
  SessionId,
} from "../types.js";
import {
  canVote,
  evaluate,
  mergePolicy,
  type ApprovalPolicy,
  type ResolvedPolicy,
} from "./policy.js";

export * from "./policy.js";

export interface RequestApprovalInput {
  sessionId: SessionId;
  requestedBy: ParticipantId;
  toolName: string;
  toolArgs: unknown;
  summary: string;
  policy?: ApprovalPolicy;
  runId?: string;
  stepId?: string;
}

export class ApprovalError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "not_eligible"
      | "already_resolved"
      | "binding_mismatch",
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

/**
 * Binds an approval to one exact call. Approving "refund $40 to order 123"
 * must not authorize "refund $4000 to order 456", so the hash covers the tool
 * name and a stable serialization of its arguments.
 */
export function bindingHashFor(toolName: string, toolArgs: unknown): string {
  return createHash("sha256")
    .update(`${toolName}::${stableStringify(toolArgs)}`)
    .digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Manages the request → vote → resolve lifecycle for actions that need human
 * sign-off, with every step written to the audit ledger.
 */
export class ApprovalGate {
  constructor(
    private readonly store: MultiplayerStore,
    private readonly bus: EventBus,
    private readonly defaultPolicy: ApprovalPolicy = { name: "default" },
  ) {}

  async request(input: RequestApprovalInput): Promise<ApprovalRequest> {
    // Resolved once, here, and stored. The governance decision a requester saw
    // is the one that must resolve the gate — after a restart, and after a
    // later release changes a default.
    const policy = mergePolicy(input.policy ?? this.defaultPolicy);
    const now = Date.now();

    const request: ApprovalRequest = {
      id: randomUUID(),
      sessionId: input.sessionId,
      requestedBy: input.requestedBy,
      toolName: input.toolName,
      toolArgs: input.toolArgs,
      bindingHash: bindingHashFor(input.toolName, input.toolArgs),
      summary: input.summary,
      policy,
      status: "pending",
      votes: [],
      createdAt: now,
      expiresAt: now + policy.expiresAfterMs,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.stepId ? { stepId: input.stepId } : {}),
    };

    await this.store.saveApproval(request);
    await this.audit(request.sessionId, "approval.requested", input.requestedBy, {
      approvalId: request.id,
      toolName: request.toolName,
      policy: policy.name,
    });

    this.bus.publish({
      type: "approval.requested",
      sessionId: request.sessionId,
      request,
    });

    return request;
  }

  async vote(
    approvalId: string,
    participantId: ParticipantId,
    decision: ApprovalDecision,
    reason?: string,
  ): Promise<ApprovalRequest> {
    const request = await this.store.getApproval(approvalId);
    if (!request) throw new ApprovalError("Approval request not found", "not_found");
    if (request.status !== "pending") {
      throw new ApprovalError(
        `Approval request is already ${request.status}`,
        "already_resolved",
      );
    }

    const participant = await this.store.getParticipant(
      request.sessionId,
      participantId,
    );
    if (!participant) {
      throw new ApprovalError("Participant is not in this session", "not_eligible");
    }

    const policy = this.policyFor(request);
    const eligibility = canVote(policy, request, participant);
    if (!eligibility.eligible) {
      throw new ApprovalError(eligibility.reason ?? "Not eligible", "not_eligible");
    }

    request.votes.push({
      participantId,
      decision,
      ...(reason ? { reason } : {}),
      votedAt: Date.now(),
    });

    const status = evaluate(policy, request);
    const resolved = status !== "pending";
    request.status = status;
    if (resolved) request.resolvedAt = Date.now();

    await this.store.saveApproval(request);
    await this.audit(request.sessionId, "approval.voted", participantId, {
      approvalId,
      decision,
      status,
    });

    this.bus.publish({
      type: resolved ? "approval.resolved" : "approval.updated",
      sessionId: request.sessionId,
      request,
    });

    if (resolved) {
      await this.audit(request.sessionId, "approval.resolved", null, {
        approvalId,
        status,
      });
    }

    return request;
  }

  /**
   * Re-evaluates a pending request against the clock. Call this from a timer
   * or lazily before acting on a decision, so expiry is enforced even if no
   * one voted.
   */
  async refresh(approvalId: string): Promise<ApprovalRequest | null> {
    const request = await this.store.getApproval(approvalId);
    if (!request || request.status !== "pending") return request;

    const status = evaluate(this.policyFor(request), request);
    if (status === "pending") return request;

    request.status = status;
    request.resolvedAt = Date.now();
    await this.store.saveApproval(request);
    this.bus.publish({
      type: "approval.resolved",
      sessionId: request.sessionId,
      request,
    });
    await this.audit(request.sessionId, "approval.resolved", null, {
      approvalId,
      status,
    });
    return request;
  }

  /**
   * Verifies that a decision still authorizes the call about to be made.
   * Guards against an approved request being reused for different arguments.
   */
  assertBinding(request: ApprovalRequest, toolName: string, toolArgs: unknown): void {
    const expected = bindingHashFor(toolName, toolArgs);
    if (expected !== request.bindingHash) {
      throw new ApprovalError(
        "Approval does not match the action being executed",
        "binding_mismatch",
      );
    }
  }

  async pending(sessionId: SessionId): Promise<ApprovalRequest[]> {
    return this.store.listApprovals(sessionId, "pending");
  }

  /**
   * The policy governing a request.
   *
   * Falls back to the configured default only for a record written before
   * policies were persisted. That fallback is the exact failure this method
   * exists to end, so it is loud rather than silent — a four-eyes gate
   * quietly resolving under `quorum: 1` is the worst-shaped bug this package
   * can have.
   */
  private policyFor(request: ApprovalRequest): ResolvedPolicy {
    if (request.policy) return request.policy;
    console.error(
      `[mastra-multiplayer] approval ${request.id} has no stored policy; ` +
        `falling back to "${this.defaultPolicy.name}". It was created by an ` +
        `older version and its original policy is unrecoverable.`,
    );
    return mergePolicy(this.defaultPolicy);
  }

  private async audit(
    sessionId: SessionId,
    action: AuditAction,
    actorId: ParticipantId | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.store.appendAudit({
      id: randomUUID(),
      sessionId,
      action,
      actorId,
      at: Date.now(),
      detail,
    });
  }
}
