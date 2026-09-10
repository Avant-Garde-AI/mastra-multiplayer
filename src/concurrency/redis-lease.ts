/**
 * A `TurnLease` on Redis, so "one agent run at a time per session" holds across
 * instances.
 *
 * ```ts
 * import { Redis } from "ioredis";
 * import { RedisTurnLease } from "@avant-garde-ai/mastra-multiplayer/concurrency/redis-lease";
 *
 * createMultiplayer({
 *   agent,
 *   bus,
 *   concurrency: { lease: new RedisTurnLease(new Redis(url)) },
 * });
 * ```
 *
 * `ioredis` is an optional peer dependency and is imported by nothing — the
 * client is passed in and typed structurally.
 */

/** The command surface used here. Satisfied by `ioredis`. */
export interface RedisLeaseClient {
  set(
    key: string,
    value: string,
    mode: "PX",
    ttlMs: number,
    condition: "NX",
  ): Promise<string | null>;
  eval(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
}

/**
 * Renew and release must both check ownership before acting, or an instance
 * whose lease already expired would extend — or delete — a lease that now
 * belongs to someone else. `GET` then `PEXPIRE` as separate commands leaves
 * exactly that window, so both run as scripts.
 */
const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export interface RedisTurnLeaseOptions {
  /** Namespace for lease keys. Default `mp`. */
  keyPrefix?: string;
}

export class RedisTurnLease {
  private readonly prefix: string;

  constructor(
    private readonly client: RedisLeaseClient,
    options: RedisTurnLeaseOptions = {},
  ) {
    this.prefix = options.keyPrefix ?? "mp";
  }

  async acquire(sessionId: string, holder: string, ttlMs: number): Promise<boolean> {
    // SET NX PX is one atomic operation: take it only if free, and never
    // without an expiry, so a crashed holder cannot wedge the session for ever.
    const result = await this.client.set(
      this.key(sessionId),
      holder,
      "PX",
      ttlMs,
      "NX",
    );
    return result !== null;
  }

  async renew(sessionId: string, holder: string, ttlMs: number): Promise<boolean> {
    const result = await this.client.eval(
      RENEW_SCRIPT,
      1,
      this.key(sessionId),
      holder,
      ttlMs,
    );
    return Number(result) === 1;
  }

  async release(sessionId: string, holder: string): Promise<void> {
    await this.client.eval(RELEASE_SCRIPT, 1, this.key(sessionId), holder);
  }

  private key(sessionId: string): string {
    return `${this.prefix}:${sessionId}:turn-lease`;
  }
}
