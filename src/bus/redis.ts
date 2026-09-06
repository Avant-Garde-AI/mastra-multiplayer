/**
 * A `MultiplayerBus` on Redis, for deployments running more than one process.
 *
 * The in-process `EventBus` fans out inside one Node process. Behind two server
 * instances a message published on A never reaches the SSE stream held open on
 * B, and half the room silently sees a different conversation.
 *
 * Fan-out is the easy half. **Sequencing is the hard half**: every client
 * tracks the highest `seq` it has seen and discards anything at or below it, so
 * two instances minting the same number would make clients throw away real
 * events while believing they were duplicates. That failure is invisible from
 * the outside, which makes it worse than the limitation it replaces. The
 * sequence therefore comes from Redis `INCR` — never from a read, an increment,
 * and a write.
 *
 * ```ts
 * import { Redis } from "ioredis";
 * import { RedisEventBus } from "mastra-multiplayer/bus/redis";
 *
 * const bus = new RedisEventBus({
 *   client: new Redis(url),
 *   subscriber: new Redis(url),   // must be its own connection
 * });
 *
 * const multiplayer = createMultiplayer({ agent, store, bus });
 * ```
 *
 * `ioredis` is an optional peer dependency and is imported by nothing — the
 * clients are passed in and typed structurally, so any client of the same shape
 * works and the core package stays dependency-free.
 */
import type { SessionId } from "../types.js";
import type { MultiplayerBus, PublishInput } from "./bus.js";
import type { EventHandler, MultiplayerEvent } from "./events.js";

/** The command surface used here. Satisfied by `ioredis`. */
export interface RedisLikeClient {
  eval(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<unknown>;
}

/**
 * A connection in subscriber mode.
 *
 * Redis will not accept ordinary commands on a connection that has subscribed,
 * so this must be a *different* connection from `client` — passing the same one
 * twice deadlocks the first time anything is published.
 */
export interface RedisLikeSubscriber {
  subscribe(...channels: string[]): Promise<unknown>;
  unsubscribe(...channels: string[]): Promise<unknown>;
  on(
    event: "message",
    listener: (channel: string, message: string) => void,
  ): unknown;
}

export interface RedisEventBusOptions {
  client: RedisLikeClient;
  /** A second connection, in subscriber mode. */
  subscriber: RedisLikeSubscriber;
  /** Namespace for every key and channel. Default `mp`. */
  keyPrefix?: string;
  /** Events retained per session for reconnect replay. Default 200, 0 disables. */
  replayBufferSize?: number;
  /** Called when a payload cannot be parsed. Defaults to `console.error`. */
  onError?: (error: unknown, context: string) => void;
}

/**
 * Assign the sequence, record for replay, and fan out — atomically, in one
 * round trip.
 *
 * Doing this as separate commands would let two concurrent publishers append to
 * the replay list in a different order than they took their sequence numbers,
 * so a reconnecting client would replay events out of order.
 *
 * The event JSON arrives already serialized and is spliced, not re-encoded:
 * `cjson` cannot round-trip an empty array (`[]` decodes to a Lua table that
 * re-encodes as `{}`), and `presence.updated` legitimately carries an empty
 * `presence` array. Prepending `"seq":N` to the body is exact.
 */
const PUBLISH_SCRIPT = `
local seq = redis.call('INCR', KEYS[1])
local body = ARGV[1]
local encoded
if body == '{}' then
  encoded = '{"seq":' .. seq .. '}'
else
  encoded = '{"seq":' .. seq .. ',' .. string.sub(body, 2)
end
local size = tonumber(ARGV[2])
if size > 0 then
  redis.call('RPUSH', KEYS[2], encoded)
  redis.call('LTRIM', KEYS[2], -size, -1)
end
redis.call('PUBLISH', KEYS[3], encoded)
return encoded
`;

export class RedisEventBus implements MultiplayerBus {
  private readonly client: RedisLikeClient;
  private readonly subscriber: RedisLikeSubscriber;
  private readonly prefix: string;
  private readonly replayBufferSize: number;
  private readonly onError: (error: unknown, context: string) => void;

  /** Local subscribers per session. Redis fans out; this dispatches. */
  private handlers = new Map<SessionId, Set<EventHandler>>();
  /** Channel → session, so one message listener can route every session. */
  private channels = new Map<string, SessionId>();
  /**
   * In-flight `SUBSCRIBE` calls, keyed by channel.
   *
   * Without this, a second `attach` for the same channel sees the channel map
   * already populated and returns immediately — while the first `SUBSCRIBE` is
   * still in flight. `subscribeFrom` would then report a live subscription and
   * miss anything published in the next few milliseconds.
   */
  private attaching = new Map<string, Promise<void>>();
  private listening = false;

  constructor(options: RedisEventBusOptions) {
    this.client = options.client;
    this.subscriber = options.subscriber;
    this.prefix = options.keyPrefix ?? "mp";
    this.replayBufferSize = options.replayBufferSize ?? 200;
    this.onError =
      options.onError ??
      ((error, context) =>
        console.error(`[mastra-multiplayer] ${context}`, error));
  }

  async publish(input: PublishInput): Promise<MultiplayerEvent> {
    const sessionId = input.sessionId;
    // `seq` is assigned by Redis; anything the caller passed is ignored, since
    // honouring it would break the one guarantee this class exists to provide.
    const { seq: _ignored, ...rest } = input as PublishInput & { seq?: number };
    const body = JSON.stringify({ ...rest, at: input.at ?? Date.now() });

    const encoded = await this.client.eval(
      PUBLISH_SCRIPT,
      3,
      this.seqKey(sessionId),
      this.listKey(sessionId),
      this.channel(sessionId),
      body,
      this.replayBufferSize,
    );

    return JSON.parse(String(encoded)) as MultiplayerEvent;
  }

  subscribe(sessionId: SessionId, handler: EventHandler): () => void {
    let set = this.handlers.get(sessionId);
    if (!set) {
      set = new Set();
      this.handlers.set(sessionId, set);
      // Fire-and-forget so the signature stays synchronous. Callers that need
      // the subscription to be live before reading use `subscribeFrom`.
      void this.attach(sessionId);
    }
    set.add(handler);

    return () => {
      const current = this.handlers.get(sessionId);
      if (!current) return;
      current.delete(handler);
      if (current.size > 0) return;

      this.handlers.delete(sessionId);
      const channel = this.channel(sessionId);
      this.channels.delete(channel);
      this.attaching.delete(channel);
      void Promise.resolve(this.subscriber.unsubscribe(channel)).catch((error) =>
        this.onError(error, `failed to unsubscribe from ${channel}`),
      );
    };
  }

  async subscribeFrom(
    sessionId: SessionId,
    afterSeq: number,
    handler: EventHandler,
  ): Promise<() => void> {
    // Buffer anything that arrives while the replay is being read, then flush
    // it in order once the replay has been delivered. Without this, a live
    // event that lands mid-replay either overtakes the replay (and the client
    // discards the older events as stale) or is lost in the gap.
    const pending: MultiplayerEvent[] = [];
    let live = false;

    const unsubscribe = this.subscribe(sessionId, (event) => {
      if (live) handler(event);
      else pending.push(event);
    });

    try {
      await this.attach(sessionId);

      let highest = afterSeq;
      for (const event of await this.replay(sessionId, afterSeq)) {
        highest = Math.max(highest, event.seq);
        handler(event);
      }

      // Anything buffered that the replay did not already cover.
      for (const event of pending.sort((a, b) => a.seq - b.seq)) {
        if (event.seq > highest) handler(event);
      }
      pending.length = 0;
      live = true;
    } catch (error) {
      unsubscribe();
      throw error;
    }

    return unsubscribe;
  }

  async replay(sessionId: SessionId, afterSeq = 0): Promise<MultiplayerEvent[]> {
    if (this.replayBufferSize === 0) return [];

    const raw = await this.client.lrange(this.listKey(sessionId), 0, -1);
    const events: MultiplayerEvent[] = [];

    for (const item of raw) {
      const event = this.parse(item, "replay");
      if (event && event.seq > afterSeq) events.push(event);
    }

    // The Lua script appends under the same lock that assigns the sequence, so
    // the list is already ordered. Sorting keeps that an invariant of this
    // method rather than of the script.
    return events.sort((a, b) => a.seq - b.seq);
  }

  async currentSeq(sessionId: SessionId): Promise<number> {
    const value = await this.client.get(this.seqKey(sessionId));
    return value === null ? 0 : Number(value);
  }

  subscriberCount(sessionId: SessionId): number {
    return this.handlers.get(sessionId)?.size ?? 0;
  }

  async clear(sessionId: SessionId): Promise<void> {
    const channel = this.channel(sessionId);
    this.handlers.delete(sessionId);
    this.channels.delete(channel);
    this.attaching.delete(channel);

    await Promise.resolve(this.subscriber.unsubscribe(channel)).catch((error) =>
      this.onError(error, `failed to unsubscribe from ${channel}`),
    );
    await this.client.del(this.seqKey(sessionId), this.listKey(sessionId));
  }

  /* ------------------------------------------------------------------ */

  /**
   * Registers the shared message listener once, then subscribes the channel.
   *
   * Concurrent callers share one promise, so awaiting this always means the
   * `SUBSCRIBE` has actually completed rather than merely been started.
   */
  private attach(sessionId: SessionId): Promise<void> {
    if (!this.listening) {
      this.listening = true;
      this.subscriber.on("message", (channel, message) => {
        const target = this.channels.get(channel);
        if (!target) return;
        const event = this.parse(message, `message on ${channel}`);
        if (event) this.dispatch(target, event);
      });
    }

    const channel = this.channel(sessionId);
    const inFlight = this.attaching.get(channel);
    if (inFlight) return inFlight;

    this.channels.set(channel, sessionId);
    const subscribing = Promise.resolve(this.subscriber.subscribe(channel))
      .then(() => undefined)
      .catch((error) => {
        // A failed subscribe must not leave a promise that resolves for ever.
        this.attaching.delete(channel);
        this.channels.delete(channel);
        throw error;
      });

    this.attaching.set(channel, subscribing);
    return subscribing;
  }

  private dispatch(sessionId: SessionId, event: MultiplayerEvent): void {
    for (const handler of this.handlers.get(sessionId) ?? []) {
      try {
        handler(event);
      } catch (error) {
        // One bad subscriber must not stop delivery to the others.
        this.onError(error, "subscriber threw");
      }
    }
  }

  private parse(raw: string, context: string): MultiplayerEvent | null {
    try {
      return JSON.parse(raw) as MultiplayerEvent;
    } catch (error) {
      this.onError(error, `could not parse event (${context})`);
      return null;
    }
  }

  private seqKey(sessionId: SessionId): string {
    return `${this.prefix}:${sessionId}:seq`;
  }

  private listKey(sessionId: SessionId): string {
    return `${this.prefix}:${sessionId}:events`;
  }

  private channel(sessionId: SessionId): string {
    return `${this.prefix}:${sessionId}:channel`;
  }
}
