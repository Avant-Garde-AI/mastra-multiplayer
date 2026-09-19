import type { ChannelContentPart } from "../types.js";

export type ReactionEventKind =
  | "message"
  | "reaction"
  | "correction"
  | "control";

export interface ReactionEvent {
  id: string;
  sessionId: string;
  /** Stable provider/account/route-scoped key used for idempotent ingestion. */
  dedupeKey: string;
  participantId: string | null;
  kind: ReactionEventKind;
  content: ChannelContentPart[];
  occurredAt?: number;
  receivedAt: number;
  relatesTo?: {
    eventId: string;
    relation: "reply" | "react" | "correct" | "retract";
  };
  signals?: {
    addressedToAgent?: boolean;
    urgency?: "normal" | "urgent";
    reaction?: { value: string; operation: "add" | "remove" };
  };
  metadata?: Record<string, unknown>;
}

export interface StoredReactionEvent extends ReactionEvent {
  /** Store-assigned, monotonically increasing cursor within the session. */
  cursor: string;
}

export interface ReactionSessionState {
  consentRevision: string;
  rosterRevision: string;
  paused: boolean;
  metadata?: Record<string, unknown>;
}

export interface ReactionBudgetUsage {
  budgetClass: string;
  limit: number | null;
  reserved: number;
  committed: number;
}

export interface ReactionSnapshot {
  sessionId: string;
  revision: string;
  pending: readonly StoredReactionEvent[];
  firstReceivedAt: number;
  latestReceivedAt: number;
  state: ReactionSessionState;
  budgets: readonly ReactionBudgetUsage[];
  lastCommittedAt?: number;
}

export type ReactionDecision =
  | { kind: "wait"; until: number; reason: string }
  | {
      kind: "suppress";
      /** Consume is a durable successful silence; defer leaves the input pending. */
      action: "consume" | "defer";
      through?: string;
      until?: number;
      reason: string;
    }
  | {
      kind: "run";
      through: string;
      reason: string;
      response: {
        maxIntents: 0 | 1;
        budgetClass: string;
      };
    };

export interface ReactionPolicy {
  id: string;
  version: string;
  decide(
    snapshot: ReactionSnapshot,
    now: number,
  ): ReactionDecision | Promise<ReactionDecision>;
}

export interface ReactionClaim {
  /** Stable across retries. */
  batchId: string;
  /** Unique to this ownership attempt. */
  attemptId: string;
  workerId: string;
  sessionId: string;
  events: readonly StoredReactionEvent[];
  /** Monotonically increasing ownership epoch for this batch. */
  fence: number;
  expiresAt: number;
  policyId: string;
  policyVersion: string;
  policyReason: string;
  consentRevision: string;
  rosterRevision: string;
  response: {
    maxIntents: 0 | 1;
    budgetClass: string;
  };
  budgetReservationId?: string;
  signal: AbortSignal;
}

export interface ReactionResponseIntent {
  kind: "text" | "reaction";
  text?: string;
  targetEventId?: string;
  reaction?: string;
  metadata?: Record<string, unknown>;
}

export interface ReactionOutput<TResult = unknown> {
  result: TResult;
  response?: ReactionResponseIntent;
}

export type ReactionCompletion<TResult = unknown> =
  | {
      status: "committed" | "already_committed";
      batchId: string;
      output: ReactionOutput<TResult>;
      responseIntentId?: string;
    }
  | { status: "stale" | "suppressed"; batchId: string; reason: string };

export interface ReactionSuppression {
  status: "suppressed";
  sessionId: string;
  eventIds: string[];
  reason: string;
}

export type ReactionClaimResult =
  | { status: "claimed"; claim: ReactionClaim }
  | ReactionSuppression
  | null;

export interface ReactionClaimOptions {
  now?: number;
  leaseMs?: number;
  candidateLimit?: number;
}

export interface ReactionStore {
  ingest(event: ReactionEvent): Promise<{ inserted: boolean; cursor: string }>;
  setSessionState(
    sessionId: string,
    state: Partial<ReactionSessionState>,
  ): Promise<ReactionSessionState>;
  claimDue(
    workerId: string,
    policy: ReactionPolicy,
    options?: ReactionClaimOptions,
  ): Promise<ReactionClaimResult>;
  renew(claim: ReactionClaim, now?: number, leaseMs?: number): Promise<boolean>;
  release(
    claim: ReactionClaim,
    retryAt: number,
    reason: string,
  ): Promise<boolean>;
  complete<TResult>(
    claim: ReactionClaim,
    output: ReactionOutput<TResult>,
    now?: number,
  ): Promise<ReactionCompletion<TResult>>;
}

export interface ReactionRunner<TResult = unknown> {
  run(claim: ReactionClaim): Promise<ReactionOutput<TResult>>;
}

export type ReactionRunResult<TResult = unknown> =
  | { status: "idle" }
  | ReactionSuppression
  | ({ status: "failed"; batchId: string; error: unknown })
  | ReactionCompletion<TResult>;
