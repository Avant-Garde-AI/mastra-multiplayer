/**
 * A lease that makes "one agent run at a time per session" true across
 * processes, not just within one.
 *
 * `TurnController` enforces that guarantee with an in-memory flag, which is
 * exactly right in one process and silently wrong in two: people posting to
 * different instances at the same moment start two runs into one session, and
 * their deltas interleave under different `runId`s.
 *
 * The lease is deliberately not a general-purpose lock. It answers one
 * question — may this instance run a turn for this session right now — and it
 * is optional, because a single-process deployment does not need it and should
 * not pay for it.
 */
export interface TurnLease {
  /**
   * Tries to take the lease. Returns false if another holder has it, in which
   * case the caller waits and tries again rather than running.
   */
  acquire(sessionId: string, holder: string, ttlMs: number): Promise<boolean>;

  /**
   * Extends a lease this holder owns. Returns **false if the lease was lost** —
   * expired, or taken by someone else — which the caller must treat as a signal
   * to abort, since another instance may already be running.
   */
  renew(sessionId: string, holder: string, ttlMs: number): Promise<boolean>;

  /** Releases the lease if this holder still owns it. Safe to call always. */
  release(sessionId: string, holder: string): Promise<void>;
}

/**
 * A lease held in one process.
 *
 * Pointless in production — it grants exactly what `TurnController` already
 * enforces locally — but it makes the lease *path* testable without Redis, and
 * gives the conformance-style tests something to run against.
 */
export class InMemoryTurnLease implements TurnLease {
  private held = new Map<string, { holder: string; expiresAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async acquire(sessionId: string, holder: string, ttlMs: number): Promise<boolean> {
    const current = this.held.get(sessionId);
    if (current && current.expiresAt > this.now() && current.holder !== holder) {
      return false;
    }
    this.held.set(sessionId, { holder, expiresAt: this.now() + ttlMs });
    return true;
  }

  async renew(sessionId: string, holder: string, ttlMs: number): Promise<boolean> {
    const current = this.held.get(sessionId);
    if (!current || current.holder !== holder || current.expiresAt <= this.now()) {
      return false;
    }
    current.expiresAt = this.now() + ttlMs;
    return true;
  }

  async release(sessionId: string, holder: string): Promise<void> {
    if (this.held.get(sessionId)?.holder === holder) this.held.delete(sessionId);
  }
}
