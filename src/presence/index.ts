import { unrefTimer } from "../internal/timers.js";
import type { MultiplayerBus } from "../bus/bus.js";
import { consoleLogger, safeLogger, type Logger } from "../internal/logger.js";
import type { MultiplayerStore } from "../storage/index.js";
import type {
  ParticipantId,
  PresenceState,
  PresenceStatus,
  SessionId,
} from "../types.js";

export interface PresenceOptions {
  /** No heartbeat for this long and a participant is marked idle. Default 30s. */
  idleAfterMs?: number;
  /** No heartbeat for this long and a participant is dropped. Default 90s. */
  dropAfterMs?: number;
  /** How often to sweep for stale participants. Default 10s. */
  sweepIntervalMs?: number;
  /** Injected for tests. */
  now?: () => number;
  logger?: Logger;
}

/**
 * Tracks who is currently looking at a shared session.
 *
 * Presence is heartbeat-based rather than connection-based on purpose: a
 * participant on Slack has no long-lived socket, and a browser tab that
 * crashes never sends a clean disconnect. Whoever last checked in within the
 * window is present.
 */
export class PresenceManager {
  private readonly idleAfterMs: number;
  private readonly dropAfterMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private readonly logger: Logger;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: MultiplayerStore,
    private readonly bus: MultiplayerBus,
    options: PresenceOptions = {},
  ) {
    this.idleAfterMs = options.idleAfterMs ?? 30_000;
    this.dropAfterMs = options.dropAfterMs ?? 90_000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 10_000;
    this.now = options.now ?? (() => Date.now());
    this.logger = safeLogger(options.logger ?? consoleLogger);
  }

  /** Records a heartbeat and broadcasts the new roster. */
  async heartbeat(
    sessionId: SessionId,
    participantId: ParticipantId,
    status: PresenceStatus = "active",
    cursor?: unknown,
  ): Promise<PresenceState[]> {
    const state: PresenceState = {
      participantId,
      status,
      lastSeenAt: this.now(),
      ...(cursor === undefined ? {} : { cursor }),
    };
    await this.store.setPresence(sessionId, state);
    return this.broadcast(sessionId);
  }

  async setTyping(
    sessionId: SessionId,
    participantId: ParticipantId,
    typing: boolean,
  ): Promise<PresenceState[]> {
    return this.heartbeat(sessionId, participantId, typing ? "typing" : "active");
  }

  /**
   * A participant has left the session for good. Clears presence and tells the
   * room to drop them from the roster.
   */
  async leave(sessionId: SessionId, participantId: ParticipantId): Promise<void> {
    await this.store.clearPresence(sessionId, participantId);
    await this.bus.publish({
      type: "participant.left",
      sessionId,
      participantId,
    });
    await this.broadcast(sessionId);
  }

  /**
   * A transport dropped, but the participant has not left.
   *
   * These are different events and conflating them is a bug: an SSE stream
   * closes on every reconnect, tab switch, and laptop lid, and someone with two
   * tabs open closes one while still sitting in the session. Publishing
   * `participant.left` there evicts a person from everyone else's roster while
   * they are still in the room. Presence is cleared — that is what presence is
   * for — and the roster is left alone.
   */
  async disconnected(
    sessionId: SessionId,
    participantId: ParticipantId,
  ): Promise<PresenceState[]> {
    await this.store.clearPresence(sessionId, participantId);
    return this.broadcast(sessionId);
  }

  /**
   * Ages out stale participants for one session. Returns the ids that were
   * dropped so callers can log or react.
   */
  async sweep(sessionId: SessionId): Promise<ParticipantId[]> {
    const now = this.now();
    const presence = await this.store.listPresence(sessionId);
    const dropped: ParticipantId[] = [];
    let changed = false;

    for (const entry of presence) {
      const age = now - entry.lastSeenAt;
      if (age >= this.dropAfterMs) {
        await this.store.clearPresence(sessionId, entry.participantId);
        dropped.push(entry.participantId);
        changed = true;
      } else if (age >= this.idleAfterMs && entry.status !== "idle") {
        await this.store.setPresence(sessionId, { ...entry, status: "idle" });
        changed = true;
      }
    }

    if (changed) await this.broadcast(sessionId);
    return dropped;
  }

  /** Starts a background sweep across every known session. */
  startSweeping(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void (async () => {
        const sessions = await this.store.listSessions();
        for (const session of sessions) {
          await this.sweep(session.id).catch((error) => {
            this.logger.error("presence sweep failed", {
              sessionId: session.id,
              error,
            });
          });
        }
      })();
    }, this.sweepIntervalMs);
    // Do not hold the process open just for presence sweeps.
    unrefTimer(this.sweepTimer);
  }

  stopSweeping(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  private async broadcast(sessionId: SessionId): Promise<PresenceState[]> {
    const presence = await this.store.listPresence(sessionId);
    await this.bus.publish({ type: "presence.updated", sessionId, presence });
    return presence;
  }
}
