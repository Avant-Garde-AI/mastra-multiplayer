import type { SessionId } from "../types.js";
import type { EventHandler, MultiplayerEvent } from "./events.js";
import type { MultiplayerBus, PublishInput } from "./bus.js";
import { consoleLogger, safeLogger, type Logger } from "../internal/logger.js";

export interface EventBusOptions {
  /**
   * How many recent events to retain per session for reconnect replay.
   * Default 200. Set to 0 to disable replay.
   */
  replayBufferSize?: number;
  /** Where to report a subscriber that throws. Defaults to `console`. */
  logger?: Logger;
}

/**
 * In-process pub/sub for a shared session.
 *
 * This is deliberately the smallest thing that works: one Node process, one
 * bus. For multi-instance deployments, swap this for a Redis/Postgres-backed
 * implementation of the same shape — the rest of the package only depends on
 * `publish` / `subscribe` / `replay`.
 */
export class EventBus implements MultiplayerBus {
  private handlers = new Map<SessionId, Set<EventHandler>>();
  private buffers = new Map<SessionId, MultiplayerEvent[]>();
  private sequences = new Map<SessionId, number>();
  private readonly replayBufferSize: number;
  private readonly logger: Logger;

  constructor(options: EventBusOptions = {}) {
    this.replayBufferSize = options.replayBufferSize ?? 200;
    this.logger = safeLogger(options.logger ?? consoleLogger);
  }

  /**
   * Assigns the next sequence number, buffers, and fans out to subscribers.
   *
   * Async to satisfy `MultiplayerBus`, though nothing here yields — the whole
   * point of this implementation is that there is no round trip.
   */
  async publish(input: PublishInput): Promise<MultiplayerEvent> {
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
          this.logger.error("subscriber threw", { sessionId: event.sessionId, error });
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
  async replay(sessionId: SessionId, afterSeq = 0): Promise<MultiplayerEvent[]> {
    const buffer = this.buffers.get(sessionId) ?? [];
    return buffer.filter((event) => event.seq > afterSeq);
  }

  /**
   * Replay and subscribe with nothing able to slip between them.
   *
   * In one process this needs no buffering — the subscription is registered and
   * the buffer read without yielding, so no publish can interleave. Awaiting
   * between the two steps, as a caller doing it by hand would, is exactly what
   * opens the gap.
   */
  async subscribeFrom(
    sessionId: SessionId,
    afterSeq: number,
    handler: EventHandler,
  ): Promise<() => void> {
    const unsubscribe = this.subscribe(sessionId, (event) => {
      if (event.seq > afterSeq) handler(event);
    });

    for (const event of this.buffers.get(sessionId) ?? []) {
      if (event.seq > afterSeq) handler(event);
    }

    return unsubscribe;
  }

  /**
   * The highest sequence assigned for this session so far. A snapshot taken
   * now is consistent with this number, so a client can reconnect the stream
   * from it and neither miss an event nor apply one twice.
   */
  async currentSeq(sessionId: SessionId): Promise<number> {
    return this.sequences.get(sessionId) ?? 0;
  }

  subscriberCount(sessionId: SessionId): number {
    return this.handlers.get(sessionId)?.size ?? 0;
  }

  /** Drops all buffered events and subscribers for a session. */
  async clear(sessionId: SessionId): Promise<void> {
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
