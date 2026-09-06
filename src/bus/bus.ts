import type { SessionId } from "../types.js";
import type { EventHandler, MultiplayerEvent } from "./events.js";

/**
 * `Omit` collapses a union into its common keys. This distributes over each
 * member instead, so `publish({ type: "agent.delta", runId, delta })` keeps
 * its own fields.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** An event without the fields the bus assigns. */
export type PublishInput = DistributiveOmit<MultiplayerEvent, "seq" | "at"> & {
  seq?: number;
  at?: number;
};

/**
 * The pub/sub contract everything else depends on.
 *
 * Narrow on purpose: `EventBus` (in-process) and `RedisEventBus` (multi-process)
 * are the two implementations, and nothing outside `src/bus/` knows which it
 * has.
 *
 * Every method that could require a network round trip is async, including
 * `publish`. That is not incidental — a bus that allocated sequence numbers
 * without awaiting could hand two events the same `seq` across processes, and
 * clients would silently drop half of what they were sent. Losing events while
 * believing you have them all is worse than the single-process limitation this
 * interface exists to remove.
 */
export interface MultiplayerBus {
  /** Assigns the next sequence, records for replay, and fans out. */
  publish(input: PublishInput): Promise<MultiplayerEvent>;

  /**
   * Subscribes to live events. The returned unsubscribe is synchronous so it
   * can be called from teardown paths that cannot await — an SSE stream's
   * `cancel`, a React effect cleanup.
   */
  subscribe(sessionId: SessionId, handler: EventHandler): () => void;

  /**
   * Subscribes *and* replays everything after `afterSeq`, with no gap between
   * them.
   *
   * Doing it in two steps — replay, then subscribe — drops anything published
   * in between. Doing it the other way round delivers live events before older
   * replayed ones, and a client that tracks the highest sequence it has seen
   * will discard the replay as stale. Both lose data quietly, which is why
   * this is one operation rather than a documented ordering rule.
   */
  subscribeFrom(
    sessionId: SessionId,
    afterSeq: number,
    handler: EventHandler,
  ): Promise<() => void>;

  /** Buffered events after `afterSeq`, oldest first. */
  replay(sessionId: SessionId, afterSeq?: number): Promise<MultiplayerEvent[]>;

  /**
   * The highest sequence assigned so far. A snapshot taken now is consistent
   * with this number, so a client can reconnect from it and neither miss an
   * event nor apply one twice.
   */
  currentSeq(sessionId: SessionId): Promise<number>;

  /** Local subscriber count. Diagnostics only — never a cluster-wide total. */
  subscriberCount(sessionId: SessionId): number;

  /** Drops buffered events and subscribers for a session. */
  clear(sessionId: SessionId): Promise<void>;
}
