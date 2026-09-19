import type {
  ReactionDecision,
  ReactionPolicy,
  ReactionSnapshot,
  StoredReactionEvent,
} from "./types.js";

export interface BurstReactionPolicyOptions {
  /** Silence after the latest ordinary contribution. Default 3 seconds. */
  quietMs?: number;
  /** Hard bound from the first pending event. Default 15 seconds. */
  maxWaitMs?: number;
  /** Short coalescing delay for direct questions. Default 500ms. */
  addressedDelayMs?: number;
  /** A full batch runs immediately. Default 20 events. */
  maxBatchSize?: number;
  /** Response budget class for addressed/direct traffic. */
  solicitedBudgetClass?: string;
  /** Response budget class for ambient group traffic. */
  unsolicitedBudgetClass?: string;
  /** Whether ordinary non-addressed conversation may produce a reply. Default true. */
  respondToAmbient?: boolean;
  id?: string;
  version?: string;
}

/**
 * A deterministic trailing-edge burst policy for group conversations.
 * Provider adapters remain responsible for trustworthy mention/urgency signals.
 */
export function createBurstReactionPolicy(
  options: BurstReactionPolicyOptions = {},
): ReactionPolicy {
  const quietMs = options.quietMs ?? 3_000;
  const maxWaitMs = options.maxWaitMs ?? 15_000;
  const addressedDelayMs = options.addressedDelayMs ?? 500;
  const maxBatchSize = options.maxBatchSize ?? 20;

  if (quietMs < 0 || maxWaitMs < 0 || addressedDelayMs < 0) {
    throw new RangeError("Reaction policy delays must be non-negative");
  }
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1) {
    throw new RangeError("maxBatchSize must be a positive integer");
  }

  return {
    id: options.id ?? "burst",
    version: options.version ?? "1",
    decide(snapshot, now) {
      return decideBurst(snapshot, now, {
        quietMs,
        maxWaitMs,
        addressedDelayMs,
        maxBatchSize,
        solicitedBudgetClass: options.solicitedBudgetClass ?? "solicited",
        unsolicitedBudgetClass: options.unsolicitedBudgetClass ?? "unsolicited",
        respondToAmbient: options.respondToAmbient ?? true,
      });
    },
  };
}

interface ResolvedOptions {
  quietMs: number;
  maxWaitMs: number;
  addressedDelayMs: number;
  maxBatchSize: number;
  solicitedBudgetClass: string;
  unsolicitedBudgetClass: string;
  respondToAmbient: boolean;
}

function decideBurst(
  snapshot: ReactionSnapshot,
  now: number,
  options: ResolvedOptions,
): ReactionDecision {
  const bounded = snapshot.pending.slice(0, options.maxBatchSize);
  const through = bounded.at(-1)!.cursor;

  if (snapshot.state.paused) {
    return { kind: "suppress", action: "consume", through, reason: "session_paused" };
  }

  if (bounded.every(isNonVerbalReaction)) {
    return { kind: "suppress", action: "consume", through, reason: "reaction_only" };
  }

  const addressed = bounded.some((event) => event.signals?.addressedToAgent);
  const urgent = bounded.some((event) => event.signals?.urgency === "urgent");
  const full = bounded.length >= options.maxBatchSize;
  const latestReceivedAt = bounded.at(-1)!.receivedAt;
  const quietDeadline = latestReceivedAt + (addressed
    ? options.addressedDelayMs
    : options.quietMs);
  const maxDeadline = snapshot.firstReceivedAt + options.maxWaitMs;
  const deadline = Math.min(quietDeadline, maxDeadline);

  if (!urgent && !full && now < deadline) {
    return {
      kind: "wait",
      until: deadline,
      reason: addressed ? "coalesce_direct_address" : "await_quiet_window",
    };
  }

  return {
    kind: "run",
    through,
    reason: urgent
      ? "trusted_urgent_signal"
      : full
        ? "batch_size_limit"
        : now >= maxDeadline
          ? "maximum_wait_elapsed"
          : addressed
            ? "direct_address_ready"
            : "quiet_window_elapsed",
    response: {
      maxIntents: addressed || options.respondToAmbient ? 1 : 0,
      budgetClass: addressed
        ? options.solicitedBudgetClass
        : options.unsolicitedBudgetClass,
    },
  };
}

function isNonVerbalReaction(event: StoredReactionEvent): boolean {
  return event.kind === "reaction" && event.content.length === 0;
}
