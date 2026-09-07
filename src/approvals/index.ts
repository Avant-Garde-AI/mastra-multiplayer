import { createHash, randomUUID } from "node:crypto";

import type { MultiplayerBus } from "../bus/bus.js";
import type { MultiplayerStore } from "../storage/index.js";
import { consoleLogger, safeLogger, type Logger } from "../internal/logger.js";
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
    private readonly bus: MultiplayerBus,
    private readonly defaultPolicy: ApprovalPolicy = { name: "default" },
    logger: Logger = consoleLogger,
  ) {
    this.logger = safeLogger(logger);
  }

  private readonly logger: Logger;

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

    await this.bus.publish({
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
    if (resolved) {
      // A vote that lands after expiry resolves the request as of the expiry,
      // not as of the late vote.
      request.resolvedAt = status === "expired" ? request.expiresAt : Date.now();
    }

    await this.store.saveApproval(request);
    await this.audit(request.sessionId, "approval.voted", participantId, {
      approvalId,
      decision,
      status,
    });

    await this.bus.publish({
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
    // The request resolved when it expired, not when a sweep got round to
    // noticing. Recording `Date.now()` would put a 3am expiry in the ledger at
    // whatever time someone next looked, which is the wrong answer to "when was
    // this decided".
    request.resolvedAt = request.expiresAt;
    await this.store.saveApproval(request);
    await this.bus.publish({
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
   * Resolves every request in a session whose deadline has passed.
   *
   * Expiry is evaluated against the clock, but nothing fires on its own — a
   * gate that expires at 3am sits `pending` in the store until someone votes or
   * refreshes it. Call this from whatever scheduler your application already
   * runs, so a deny-on-expiry is a decision made at the deadline rather than at
   * the next page load.
   *
   * There is deliberately no timer inside this package: the right cadence
   * depends on how tight your approval windows are, and a library that owns a
   * scheduler owns a shutdown story too.
   *
   * Returns the requests that resolved, so a caller can log or react.
   */
  async sweepExpired(sessionId: SessionId): Promise<ApprovalRequest[]> {
    const pending = await this.store.listApprovals(sessionId, "pending");
    const resolved: ApprovalRequest[] = [];

    for (const request of pending) {
      // `refresh` re-reads and re-evaluates; it is a no-op for anything still
      // inside its window.
      const refreshed = await this.refresh(request.id).catch((error) => {
        this.logger.error("could not refresh an approval during the sweep", {
          approvalId: request.id,
          sessionId,
          error,
        });
        return null;
      });
      if (refreshed && refreshed.status !== "pending") resolved.push(refreshed);
    }

    return resolved;
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
    this.logger.error(
      "approval has no stored policy; falling back to the default. It was " +
        "created by an older version and its original policy is unrecoverable.",
      { approvalId: request.id, fallbackPolicy: this.defaultPolicy.name },
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
