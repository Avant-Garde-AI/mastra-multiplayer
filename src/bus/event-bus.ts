import type { SessionId } from "../types.js";
import type { EventHandler, MultiplayerEvent } from "./events.js";

export interface EventBusOptions {
  /**
   * How many recent events to retain per session for reconnect replay.
   * Default 200. Set to 0 to disable replay.
   */
  replayBufferSize?: number;
}

/**
 * `Omit` collapses a union into its common keys. This distributes over each
 * member instead, so `publish({ type: "agent.delta", runId, delta })` keeps
 * its own fields.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

type PublishInput = DistributiveOmit<MultiplayerEvent, "seq" | "at"> & {
  seq?: number;
  at?: number;
};

/**
 * In-process pub/sub for a shared session.
 *
 * This is deliberately the smallest thing that works: one Node process, one
 * bus. For multi-instance deployments, swap this for a Redis/Postgres-backed
 * implementation of the same shape — the rest of the package only depends on
 * `publish` / `subscribe` / `replay`.
 */
export class EventBus {
  private handlers = new Map<SessionId, Set<EventHandler>>();
  private buffers = new Map<SessionId, MultiplayerEvent[]>();
  private sequences = new Map<SessionId, number>();
  private readonly replayBufferSize: number;

  constructor(options: EventBusOptions = {}) {
    this.replayBufferSize = options.replayBufferSize ?? 200;
  }

  /** Assigns the next sequence number, buffers, and fans out to subscribers. */
  publish(input: PublishInput): MultiplayerEvent {
    const seq = input.seq ?? this.nextSeq(input.sessionId);
    const event = {
      ...input,
      seq,
      at: input.at ?? Date.now(),
    } as MultiplayerEvent;

    this.buffer(event);

    const subscribers = this.handlers.get(event.sessionId);
    if (subscribers) {
      for (const handler of subscribers) {
        try {
          handler(event);
        } catch (error) {
          // One bad subscriber must not stop delivery to the others.
          console.error("[mastra-multiplayer] subscriber threw", error);
        }
      }
    }

    return event;
  }

  /** Returns an unsubscribe function. */
  subscribe(sessionId: SessionId, handler: EventHandler): () => void {
    let set = this.handlers.get(sessionId);
    if (!set) {
      set = new Set();
      this.handlers.set(sessionId, set);
    }
    set.add(handler);

    return () => {
      const current = this.handlers.get(sessionId);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.handlers.delete(sessionId);
    };
  }

  /** Events after `afterSeq`, oldest first. Used on reconnect. */
  replay(sessionId: SessionId, afterSeq = 0): MultiplayerEvent[] {
    const buffer = this.buffers.get(sessionId) ?? [];
    return buffer.filter((event) => event.seq > afterSeq);
  }

  /**
   * The highest sequence assigned for this session so far. A snapshot taken
   * now is consistent with this number, so a client can reconnect the stream
   * from it and neither miss an event nor apply one twice.
   */
  currentSeq(sessionId: SessionId): number {
    return this.sequences.get(sessionId) ?? 0;
  }

  subscriberCount(sessionId: SessionId): number {
    return this.handlers.get(sessionId)?.size ?? 0;
  }

  /** Drops all buffered events and subscribers for a session. */
  clear(sessionId: SessionId): void {
    this.handlers.delete(sessionId);
    this.buffers.delete(sessionId);
    this.sequences.delete(sessionId);
  }

  private nextSeq(sessionId: SessionId): number {
    const next = (this.sequences.get(sessionId) ?? 0) + 1;
    this.sequences.set(sessionId, next);
    return next;
  }

  private buffer(event: MultiplayerEvent): void {
    if (this.replayBufferSize === 0) return;
    const buffer = this.buffers.get(event.sessionId) ?? [];
    buffer.push(event);
    if (buffer.length > this.replayBufferSize) {
      buffer.splice(0, buffer.length - this.replayBufferSize);
    }
    this.buffers.set(event.sessionId, buffer);
  }
}
