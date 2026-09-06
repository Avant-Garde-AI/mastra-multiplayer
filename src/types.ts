/**
 * Core types for mastra-multiplayer.
 *
 * A "session" here is a shared agent conversation that more than one human can
 * see and act in. It maps onto a Mastra thread (`threadId`), but adds a
 * participant roster, presence, and an approval ledger on top.
 */

export type ParticipantId = string;
export type SessionId = string;

/** Where a participant is connected from. Useful for attribution and policy. */
export type ParticipantSurface =
  | "web"
  | "slack"
  | "discord"
  | "teams"
  | "github"
  | "linear"
  | "api"
  | "unknown";

export type ParticipantRole =
  | "owner"
  | "editor"
  | "approver"
  | "viewer";

export interface Participant {
  id: ParticipantId;
  /** Human-readable name shown to other participants and to the model. */
  displayName: string;
  role: ParticipantRole;
  surface: ParticipantSurface;
  /**
   * Mastra `resourceId` for this human. Convention: `${surface}:${externalId}`,
   * e.g. `slack:U06CK1E9HN2`. Used to scope per-user memory alongside the
   * shared thread.
   */
  resourceId?: string;
  email?: string;
  avatarUrl?: string;
  metadata?: Record<string, unknown>;
}

export type PresenceStatus = "active" | "idle" | "typing" | "away";

export interface PresenceState {
  participantId: ParticipantId;
  status: PresenceStatus;
  /** Epoch millis of the last heartbeat received. */
  lastSeenAt: number;
  /** Optional free-form cursor/selection payload for co-editing surfaces. */
  cursor?: unknown;
}

export interface SessionRecord {
  id: SessionId;
  /** The Mastra thread this session is bound to. */
  threadId: string;
  /** The agent answering in this session. */
  agentId: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  /** Set when the agent is mid-run, so the UI can show "agent is working". */
  runningRunId?: string;
  metadata?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Approvals                                                           */
/* ------------------------------------------------------------------ */

export type ApprovalDecision = "approve" | "deny";

/**
 * What "enough people said yes" means for one action: how many, who, what a
 * "no" means, and what silence means.
 *
 * Lives here rather than in `approvals/policy.ts` because a resolved policy is
 * stored on every `ApprovalRequest` — the record has to be able to describe
 * itself without importing the module that builds it.
 */
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

/**
 * A policy with every defaultable field filled in.
 *
 * This is the shape that gets persisted, because the decision a requester saw
 * has to be the decision that resolves — including after a restart, and
 * including after a later release changes a default.
 */
export type ResolvedPolicy = ApprovalPolicy &
  Required<
    Pick<
      ApprovalPolicy,
      | "quorum"
      | "excludeRequester"
      | "allowedRoles"
      | "denyIsFinal"
      | "expiresAfterMs"
      | "onExpiry"
    >
  >;

export interface ApprovalVote {
  participantId: ParticipantId;
  decision: ApprovalDecision;
  reason?: string;
  votedAt: number;
}

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled";

/**
 * A request for humans to authorize one specific action. The action is bound
 * to the tool and its arguments so an approval cannot be replayed against a
 * different call.
 */
export interface ApprovalRequest {
  id: string;
  sessionId: SessionId;
  /** Who (or what) asked for this action. */
  requestedBy: ParticipantId;
  toolName: string;
  /** Serialized tool arguments. Hashed into `bindingHash`. */
  toolArgs: unknown;
  /** Stable hash of `${toolName}:${toolArgs}` — the thing being approved. */
  bindingHash: string;
  summary: string;
  /**
   * The resolved policy this request is governed by, stored on the record
   * rather than held in memory.
   *
   * A gate whose policy lives in the process loses it on restart and silently
   * falls back to the default — a four-eyes rule becoming a one-signature rule
   * across a deploy, with nothing in the audit trail to show it.
   */
  policy: ResolvedPolicy;
  status: ApprovalStatus;
  votes: ApprovalVote[];
  createdAt: number;
  expiresAt: number;
  resolvedAt?: number;
  /** Mastra workflow run this gate is suspended inside, when applicable. */
  runId?: string;
  stepId?: string;
}

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

export type AuditAction =
  | "session.created"
  | "participant.joined"
  | "participant.left"
  | "message.sent"
  | "agent.run.started"
  | "agent.run.finished"
  | "agent.run.interrupted"
  | "approval.requested"
  | "approval.voted"
  | "approval.resolved"
  | "tool.executed";

export interface AuditEntry {
  id: string;
  sessionId: SessionId;
  action: AuditAction;
  /** Null for agent-originated entries. */
  actorId: ParticipantId | null;
  at: number;
  detail?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Concurrency                                                         */
/* ------------------------------------------------------------------ */

/**
 * How to handle a new human message that arrives while the agent is already
 * running. Mirrors the modes in Mastra's Signal API so the two can be wired
 * together without translation.
 */
export type ConcurrencyMode = "queue" | "debounce" | "batch" | "skip" | "preempt";

export interface InboundMessage {
  sessionId: SessionId;
  participantId: ParticipantId;
  text: string;
  receivedAt: number;
  /** True when the message explicitly @-mentions the agent. */
  addressedToAgent: boolean;
  metadata?: Record<string, unknown>;
}
