import type {
  ReactionEvent,
  ReactionPolicy,
  ReactionRunResult,
  ReactionRunner,
  ReactionStore,
} from "./types.js";

export interface ReactionBusOptions<TResult> {
  store: ReactionStore;
  policy: ReactionPolicy;
  runner: ReactionRunner<TResult> | ReactionRunner<TResult>["run"];
  leaseMs?: number;
  retryDelayMs?: number;
  now?: () => number;
}

export interface RunNextOptions {
  workerId: string;
  now?: number;
}

/**
 * Durable reaction orchestration. The host scheduler calls `runNext`; this
 * class deliberately owns no timer and never sends directly to a provider.
 */
export class ReactionBus<TResult = unknown> {
  private readonly runClaim: ReactionRunner<TResult>["run"];
  private readonly now: () => number;

  constructor(private readonly options: ReactionBusOptions<TResult>) {
    this.runClaim =
      typeof options.runner === "function"
        ? options.runner
        : options.runner.run.bind(options.runner);
    this.now = options.now ?? Date.now;
  }

  ingest(event: ReactionEvent): Promise<{ inserted: boolean; cursor: string }> {
    return this.options.store.ingest(event);
  }

  async runNext(options: RunNextOptions): Promise<ReactionRunResult<TResult>> {
    const now = options.now ?? this.now();
    const next = await this.options.store.claimDue(
      options.workerId,
      this.options.policy,
      { now, leaseMs: this.options.leaseMs },
    );

    if (!next) return { status: "idle" };
    if (next.status === "suppressed") return next;

    const { claim } = next;
    try {
      const output = await this.runClaim(claim);
      return await this.options.store.complete(claim, output, this.now());
    } catch (error) {
      await this.options.store.release(
        claim,
        this.now() + (this.options.retryDelayMs ?? 1_000),
        error instanceof Error ? error.message : String(error),
      );
      return { status: "failed", batchId: claim.batchId, error };
    }
  }
}

export function createReactionBus<TResult = unknown>(
  options: ReactionBusOptions<TResult>,
): ReactionBus<TResult> {
  return new ReactionBus(options);
}
