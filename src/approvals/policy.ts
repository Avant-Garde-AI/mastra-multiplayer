import type {
  ApprovalRequest,
  ApprovalStatus,
  Participant,
  ParticipantId,
  ParticipantRole,
} from "../types.js";

export interface ApprovalPolicy {
  name: string;
  /** How many approve votes are needed. Default 1. */
  quorum?: number;
  /**
   * When true, the participant who requested the action cannot approve it.
   * This is the four-eyes / maker-checker rule.
   */
  excludeRequester?: boolean;
  /** Only these roles may vote. Default: owner, editor, approver. */
  allowedRoles?: ParticipantRole[];
  /** Explicit allowlist of participant ids, checked in addition to roles. */
  allowedParticipants?: ParticipantId[];
  /** A single deny resolves the request. Default true. */
  denyIsFinal?: boolean;
  /** How long the request stays open. Default 15 minutes. */
  expiresAfterMs?: number;
  /**
   * What happens when the request expires with no resolution.
   * Default "deny" — silence is not consent.
   */
  onExpiry?: "deny" | "approve";
}

export const DEFAULT_POLICY: Required<
  Pick<
    ApprovalPolicy,
    | "quorum"
    | "excludeRequester"
    | "allowedRoles"
    | "denyIsFinal"
    | "expiresAfterMs"
    | "onExpiry"
  >
> = {
  quorum: 1,
  excludeRequester: false,
  allowedRoles: ["owner", "editor", "approver"],
  denyIsFinal: true,
  expiresAfterMs: 15 * 60 * 1000,
  onExpiry: "deny",
};

export type ResolvedPolicy = typeof DEFAULT_POLICY;

/**
 * Layers a policy over the defaults, ignoring keys that are explicitly
 * `undefined`.
 *
 * A plain spread does not do this, and three keys fail badly when it happens —
 * which it does whenever a policy is assembled from optional config, as in
 * `fourEyes({ quorum: config.approvers })` with `approvers` unset:
 *
 * - `quorum: undefined` makes `approvals.length >= quorum` false forever, so
 *   the gate never approves.
 * - `denyIsFinal: undefined` is falsy, so a deny stops resolving the request.
 * - `allowedRoles: undefined` makes `canVote` throw on `.includes()`.
 *
 * Two directions of failure for a governance control, plus a crash, all
 * reached through ordinary-looking calling code — so it is handled in one
 * place rather than at every call site.
 */
export function mergePolicy(policy: ApprovalPolicy): ResolvedPolicy {
  const merged: Record<string, unknown> = { ...DEFAULT_POLICY };
  for (const [key, value] of Object.entries(policy)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as ResolvedPolicy;
}

/** Two different people must sign off. The requester is not one of them. */
export const fourEyes = (overrides: Partial<ApprovalPolicy> = {}): ApprovalPolicy => ({
  name: "four-eyes",
  quorum: 2,
  excludeRequester: true,
  ...overrides,
});

/** Any n of the eligible participants. */
export const quorumOf = (
  n: number,
  overrides: Partial<ApprovalPolicy> = {},
): ApprovalPolicy => ({
  name: `quorum-${n}`,
  quorum: n,
  ...overrides,
});

/** Only designated approvers, one signature. */
export const approverOnly = (
  overrides: Partial<ApprovalPolicy> = {},
): ApprovalPolicy => ({
  name: "approver-only",
  quorum: 1,
  allowedRoles: ["approver", "owner"],
  ...overrides,
});

export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
}

/** Whether this participant is allowed to vote on this request. */
export function canVote(
  policy: ApprovalPolicy,
  request: ApprovalRequest,
  participant: Participant,
): EligibilityResult {
  const merged = mergePolicy(policy);

  if (merged.excludeRequester && participant.id === request.requestedBy) {
    return {
      eligible: false,
      reason: "Requester cannot approve their own action under this policy.",
    };
  }

  if (!merged.allowedRoles.includes(participant.role)) {
    const allowlisted = policy.allowedParticipants?.includes(participant.id) ?? false;
    if (!allowlisted) {
      return {
        eligible: false,
        reason: `Role "${participant.role}" is not permitted to vote on this action.`,
      };
    }
  }

  if (request.votes.some((vote) => vote.participantId === participant.id)) {
    return { eligible: false, reason: "Participant has already voted." };
  }

  if (request.status !== "pending") {
    return { eligible: false, reason: `Request is already ${request.status}.` };
  }

  return { eligible: true };
}

/**
 * Pure function: given a policy and the votes so far, what is the status?
 * Kept side-effect free so it can be unit tested and reused on the client to
 * render "1 of 2 approvals" without asking the server.
 */
export function evaluate(
  policy: ApprovalPolicy,
  request: ApprovalRequest,
  now = Date.now(),
): ApprovalStatus {
  const merged = mergePolicy(policy);

  if (request.status !== "pending") return request.status;

  const denies = request.votes.filter((v) => v.decision === "deny");
  if (merged.denyIsFinal && denies.length > 0) return "denied";

  const approvals = request.votes.filter((v) => v.decision === "approve");
  if (approvals.length >= merged.quorum) return "approved";

  if (now >= request.expiresAt) {
    return merged.onExpiry === "approve" ? "approved" : "expired";
  }

  return "pending";
}

/** How many more approvals are needed. Useful for UI copy. */
export function remainingApprovals(
  policy: ApprovalPolicy,
  request: ApprovalRequest,
): number {
  const { quorum } = mergePolicy(policy);
  const approvals = request.votes.filter((v) => v.decision === "approve").length;
  return Math.max(0, quorum - approvals);
}
