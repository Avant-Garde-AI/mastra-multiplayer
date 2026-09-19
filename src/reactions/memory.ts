import { randomUUID } from "node:crypto";

import type {
  ReactionBudgetUsage,
  ReactionClaim,
  ReactionClaimOptions,
  ReactionClaimResult,
  ReactionCompletion,
  ReactionDecision,
  ReactionEvent,
  ReactionOutput,
  ReactionPolicy,
  ReactionSessionState,
  ReactionSnapshot,
  ReactionStore,
  StoredReactionEvent,
} from "./types.js";

interface StoredEventRecord {
  event: StoredReactionEvent;
  consumed: boolean;
}

interface BatchRecord {
  id: string;
  sessionId: string;
  events: StoredReactionEvent[];
  policyId: string;
  policyVersion: string;
  policyReason: string;
  consentRevision: string;
  rosterRevision: string;
  response: ReactionClaim["response"];
  budgetReservationId?: string;
  fence: number;
  attemptId?: string;
  workerId?: string;
  expiresAt?: number;
  retryAt: number;
  status: "ready" | "active" | "committed";
  controller?: AbortController;
  output?: ReactionOutput;
  responseIntentId?: string;
  committedAt?: number;
}

interface SessionBucket {
  nextCursor: number;
  revision: number;
  events: StoredEventRecord[];
  dedupe: Map<string, string>;
  state: ReactionSessionState;
  deferredUntil: number;
  lastCommittedAt?: number;
}

export interface InMemoryReactionStoreOptions {
  /** Per-session limits. Omitted classes are unlimited. */
  budgetLimits?: Record<string, number>;
  now?: () => number;
}

/**
 * Reference implementation for tests and single-process prototypes.
 * Persistence adapters should run the same operations transactionally.
 */
export class InMemoryReactionStore implements ReactionStore {
  private readonly sessions = new Map<string, SessionBucket>();
  private readonly batches = new Map<string, BatchRecord>();
  private readonly budgetLimits: Record<string, number>;
  private readonly now: () => number;

  constructor(options: InMemoryReactionStoreOptions = {}) {
    this.budgetLimits = { ...options.budgetLimits };
    this.now = options.now ?? Date.now;
  }

  async ingest(event: ReactionEvent): Promise<{ inserted: boolean; cursor: string }> {
    const bucket = this.bucket(event.sessionId);
    const duplicate = bucket.dedupe.get(event.dedupeKey);
    if (duplicate) return { inserted: false, cursor: duplicate };

    const cursor = String(++bucket.nextCursor);
    bucket.events.push({ event: cloneEvent({ ...event, cursor }), consumed: false });
    bucket.dedupe.set(event.dedupeKey, cursor);
    bucket.revision += 1;
    // A new contribution can shorten or extend the policy deadline (for
    // example, a trusted urgent message arriving during a quiet wait).
    bucket.deferredUntil = 0;
    return { inserted: true, cursor };
  }

  async setSessionState(
    sessionId: string,
    patch: Partial<ReactionSessionState>,
  ): Promise<ReactionSessionState> {
    const bucket = this.bucket(sessionId);
    bucket.state = {
      ...bucket.state,
      ...structuredClone(patch),
      metadata: patch.metadata
        ? { ...bucket.state.metadata, ...structuredClone(patch.metadata) }
        : bucket.state.metadata,
    };
    bucket.revision += 1;
    return structuredClone(bucket.state);
  }

  async claimDue(
    workerId: string,
    policy: ReactionPolicy,
    options: ReactionClaimOptions = {},
  ): Promise<ReactionClaimResult> {
    const now = options.now ?? this.now();
    const leaseMs = options.leaseMs ?? 30_000;

    const retry = this.claimRetry(workerId, now, leaseMs);
    if (retry) return { status: "claimed", claim: retry };

    const candidates = [...this.sessions.entries()]
      .map(([sessionId, bucket]) => ({
        sessionId,
        bucket,
        pending: this.pending(sessionId, bucket),
      }))
      .filter(({ bucket, pending: items }) =>
        items.length > 0 && bucket.deferredUntil <= now,
      )
      .sort((left, right) =>
        left.pending[0]!.receivedAt - right.pending[0]!.receivedAt,
      )
      .slice(0, options.candidateLimit ?? 100);

    for (const { sessionId, bucket, pending: items } of candidates) {
      const snapshot = this.snapshot(sessionId, bucket, items);
      const decision = await policy.decide(snapshot, now);

      if (decision.kind === "wait") {
        bucket.deferredUntil = Math.max(bucket.deferredUntil, decision.until);
        continue;
      }

      if (decision.kind === "suppress") {
        if (decision.action === "defer") {
          bucket.deferredUntil = Math.max(bucket.deferredUntil, decision.until ?? now);
          continue;
        }
        const selected = through(items, decision.through ?? items.at(-1)!.cursor);
        this.consume(bucket, selected);
        return {
          status: "suppressed",
          sessionId,
          eventIds: selected.map((event) => event.id),
          reason: decision.reason,
        };
      }

      const selected = through(items, decision.through);
      if (selected.length === 0) continue;
      if (!this.reserveBudget(sessionId, decision)) continue;

      const first = selected[0]!.cursor;
      const last = selected.at(-1)!.cursor;
      const batchId = `reaction:${encodeURIComponent(sessionId)}:${first}-${last}`;
      const reservationId =
        decision.response.maxIntents === 1 ? `budget:${batchId}` : undefined;
      const record: BatchRecord = {
        id: batchId,
        sessionId,
        events: selected.map(cloneEvent),
        policyId: policy.id,
        policyVersion: policy.version,
        policyReason: decision.reason,
        consentRevision: bucket.state.consentRevision,
        rosterRevision: bucket.state.rosterRevision,
        response: { ...decision.response },
        budgetReservationId: reservationId,
        fence: 0,
        retryAt: now,
        status: "ready",
      };
      this.batches.set(batchId, record);
      return { status: "claimed", claim: this.activate(record, workerId, now, leaseMs) };
    }

    return null;
  }

  async renew(claim: ReactionClaim, now = this.now(), leaseMs = 30_000): Promise<boolean> {
    const record = this.batches.get(claim.batchId);
    if (!this.owns(record, claim, now)) return false;
    record.expiresAt = now + leaseMs;
    return true;
  }

  async release(
    claim: ReactionClaim,
    retryAt: number,
    _reason: string,
  ): Promise<boolean> {
    const record = this.batches.get(claim.batchId);
    if (!record || record.status !== "active" || !sameOwner(record, claim)) return false;
    record.controller?.abort();
    record.status = "ready";
    record.retryAt = retryAt;
    record.workerId = undefined;
    record.attemptId = undefined;
    record.expiresAt = undefined;
    return true;
  }

  async complete<TResult>(
    claim: ReactionClaim,
    output: ReactionOutput<TResult>,
    now = this.now(),
  ): Promise<ReactionCompletion<TResult>> {
    const record = this.batches.get(claim.batchId);
    if (!record) return { status: "stale", batchId: claim.batchId, reason: "unknown_batch" };
    if (record.status === "committed") {
      return {
        status: "already_committed",
        batchId: record.id,
        output: structuredClone(record.output) as ReactionOutput<TResult>,
        responseIntentId: record.responseIntentId,
      };
    }
    if (!this.owns(record, claim, now)) {
      return { status: "stale", batchId: claim.batchId, reason: "claim_lost" };
    }

    const bucket = this.bucket(record.sessionId);
    if (
      bucket.state.consentRevision !== record.consentRevision ||
      bucket.state.rosterRevision !== record.rosterRevision ||
      bucket.state.paused
    ) {
      record.controller?.abort();
      this.batches.delete(record.id);
      return {
        status: "suppressed",
        batchId: record.id,
        reason: bucket.state.paused ? "session_paused" : "session_state_changed",
      };
    }

    if (output.response && record.response.maxIntents === 0) {
      throw new Error(`Batch ${record.id} does not allow a response intent`);
    }

    record.status = "committed";
    record.output = structuredClone(output);
    record.committedAt = now;
    record.controller = undefined;
    record.responseIntentId = output.response ? `response:${record.id}` : undefined;
    bucket.lastCommittedAt = now;
    this.consume(bucket, record.events);

    return {
      status: "committed",
      batchId: record.id,
      output: structuredClone(output),
      responseIntentId: record.responseIntentId,
    };
  }

  private bucket(sessionId: string): SessionBucket {
    let bucket = this.sessions.get(sessionId);
    if (!bucket) {
      bucket = {
        nextCursor: 0,
        revision: 0,
        events: [],
        dedupe: new Map(),
        state: {
          consentRevision: "0",
          rosterRevision: "0",
          paused: false,
        },
        deferredUntil: 0,
      };
      this.sessions.set(sessionId, bucket);
    }
    return bucket;
  }

  private snapshot(
    sessionId: string,
    bucket: SessionBucket,
    items: StoredReactionEvent[],
  ): ReactionSnapshot {
    return {
      sessionId,
      revision: String(bucket.revision),
      pending: items.map(cloneEvent),
      firstReceivedAt: items[0]!.receivedAt,
      latestReceivedAt: items.at(-1)!.receivedAt,
      state: structuredClone(bucket.state),
      budgets: this.budgetUsage(sessionId),
      lastCommittedAt: bucket.lastCommittedAt,
    };
  }

  private claimRetry(workerId: string, now: number, leaseMs: number): ReactionClaim | null {
    const eligible = [...this.batches.values()]
      .filter((record) => {
        if (record.status === "ready") return record.retryAt <= now;
        if (record.status === "active" && (record.expiresAt ?? 0) <= now) {
          record.controller?.abort();
          record.status = "ready";
          return true;
        }
        return false;
      })
      .sort((left, right) => left.retryAt - right.retryAt)[0];
    return eligible ? this.activate(eligible, workerId, now, leaseMs) : null;
  }

  private activate(
    record: BatchRecord,
    workerId: string,
    now: number,
    leaseMs: number,
  ): ReactionClaim {
    record.fence += 1;
    record.status = "active";
    record.workerId = workerId;
    record.attemptId = randomUUID();
    record.expiresAt = now + leaseMs;
    record.controller = new AbortController();
    return {
      batchId: record.id,
      attemptId: record.attemptId,
      workerId,
      sessionId: record.sessionId,
      events: record.events.map(cloneEvent),
      fence: record.fence,
      expiresAt: record.expiresAt,
      policyId: record.policyId,
      policyVersion: record.policyVersion,
      policyReason: record.policyReason,
      consentRevision: record.consentRevision,
      rosterRevision: record.rosterRevision,
      response: { ...record.response },
      budgetReservationId: record.budgetReservationId,
      signal: record.controller.signal,
    };
  }

  private owns(record: BatchRecord | undefined, claim: ReactionClaim, now: number): record is BatchRecord {
    if (!record || record.status !== "active" || !sameOwner(record, claim)) return false;
    if ((record.expiresAt ?? 0) <= now) {
      record.controller?.abort();
      record.status = "ready";
      record.retryAt = now;
      return false;
    }
    return true;
  }

  private consume(bucket: SessionBucket, events: readonly StoredReactionEvent[]): void {
    const ids = new Set(events.map((event) => event.id));
    for (const record of bucket.events) {
      if (ids.has(record.event.id)) record.consumed = true;
    }
    bucket.revision += 1;
    bucket.deferredUntil = 0;
  }

  private pending(sessionId: string, bucket: SessionBucket): StoredReactionEvent[] {
    const hasOpenBatch = [...this.batches.values()].some(
      (batch) => batch.sessionId === sessionId && batch.status !== "committed",
    );
    if (hasOpenBatch) return [];
    return bucket.events
      .filter((record) => !record.consumed)
      .map((record) => cloneEvent(record.event));
  }

  private reserveBudget(sessionId: string, decision: Extract<ReactionDecision, { kind: "run" }>): boolean {
    if (decision.response.maxIntents === 0) return true;
    const usage = this.usageFor(sessionId, decision.response.budgetClass);
    return usage.limit === null || usage.reserved + usage.committed < usage.limit;
  }

  private budgetUsage(sessionId: string): ReactionBudgetUsage[] {
    const classes = new Set(Object.keys(this.budgetLimits));
    for (const batch of this.batches.values()) {
      if (batch.sessionId === sessionId) classes.add(batch.response.budgetClass);
    }
    return [...classes].map((budgetClass) => this.usageFor(sessionId, budgetClass));
  }

  private usageFor(sessionId: string, budgetClass: string): ReactionBudgetUsage {
    let reserved = 0;
    let committed = 0;
    for (const batch of this.batches.values()) {
      if (
        batch.sessionId !== sessionId ||
        batch.response.maxIntents === 0 ||
        batch.response.budgetClass !== budgetClass
      ) continue;
      if (batch.status === "committed") committed += batch.responseIntentId ? 1 : 0;
      else reserved += 1;
    }
    return {
      budgetClass,
      limit: this.budgetLimits[budgetClass] ?? null,
      reserved,
      committed,
    };
  }

}

function through(
  events: readonly StoredReactionEvent[],
  cursor: string,
): StoredReactionEvent[] {
  const index = events.findIndex((event) => event.cursor === cursor);
  return index < 0 ? [] : events.slice(0, index + 1).map(cloneEvent);
}

function cloneEvent<T extends StoredReactionEvent>(event: T): T {
  return structuredClone(event);
}

function sameOwner(record: BatchRecord, claim: ReactionClaim): boolean {
  return (
    record.workerId === claim.workerId &&
    record.attemptId === claim.attemptId &&
    record.fence === claim.fence
  );
}
