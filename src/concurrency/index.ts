import { randomUUID } from "node:crypto";

import { unrefTimer } from "../internal/timers.js";
import { consoleLogger, safeLogger, type Logger } from "../internal/logger.js";
import type { TurnLease } from "./lease.js";
import type {
  ConcurrencyMode,
  InboundMessage,
  SessionId,
} from "../types.js";

export * from "./lease.js";

export interface TurnControllerOptions {
  mode?: ConcurrencyMode;
  /** Window for "debounce" and "batch". Default 1500ms. */
  windowMs?: number;
  /** Max messages collapsed into one batch. Default 10. */
  maxBatchSize?: number;
  /**
   * Makes "one run at a time per session" hold across processes.
   *
   * Without it the guarantee is per process, so two people posting to different
   * instances at the same moment start two runs into one session. Unnecessary
   * for a single-instance deployment, which is why it is optional.
   */
  lease?: TurnLease;
  /** How long a held lease stays valid without renewal. Default 30s. */
  leaseTtlMs?: number;
  /** How often to renew while a turn is running. Default a third of the TTL. */
  leaseRenewMs?: number;
  /** How long to wait before retrying a lease another instance holds. Default 250ms. */
  leaseRetryMs?: number;
  logger?: Logger;
}

/**
 * What the controller hands to the runner: one or more human messages that
 * should become a single agent turn.
 */
export interface Turn {
  sessionId: SessionId;
  messages: InboundMessage[];
  /** True when this turn should cancel a run already in flight. */
  preempts: boolean;
}

export type TurnRunner = (turn: Turn) => Promise<void>;

interface SessionState {
  running: boolean;
  queue: InboundMessage[];
  pending: InboundMessage[];
  timer: ReturnType<typeof setTimeout> | null;
  abort: AbortController | null;
  /** Set while waiting for a lease another instance holds. */
  retry: ReturnType<typeof setTimeout> | null;
}

/**
 * Serializes concurrent human input into agent turns.
 *
 * A single-user chat loop can assume one message, one turn. As soon as two
 * people share a session, messages interleave and arrive mid-run. The five
 * modes are the five reasonable answers:
 *
 * - `queue`    run turns in arrival order, one at a time (default, safest)
 * - `debounce` wait for a quiet window, then run only the last message
 * - `batch`    collect everything in a window and run it as one turn
 * - `skip`     drop messages that arrive while the agent is busy
 * - `preempt`  abort the in-flight run and start over with the new message
 */
export class TurnController {
  private readonly mode: ConcurrencyMode;
  private readonly windowMs: number;
  private readonly maxBatchSize: number;
  private readonly lease: TurnLease | undefined;
  private readonly leaseTtlMs: number;
  private readonly leaseRenewMs: number;
  private readonly leaseRetryMs: number;
  private readonly logger: Logger;
  private states = new Map<SessionId, SessionState>();

  /**
   * Identifies this controller as a lease holder. Per instance, not per
   * session: a lease is only ever compared for equality, and one id per process
   * makes a held lease traceable to a process in a log line.
   */
  private readonly holderId = randomUUID();

  constructor(
    private readonly runner: TurnRunner,
    options: TurnControllerOptions = {},
  ) {
    this.mode = options.mode ?? "queue";
    this.windowMs = options.windowMs ?? 1500;
    this.maxBatchSize = options.maxBatchSize ?? 10;
    this.lease = options.lease;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.leaseRenewMs = options.leaseRenewMs ?? Math.floor((options.leaseTtlMs ?? 30_000) / 3);
    this.leaseRetryMs = options.leaseRetryMs ?? 250;
    this.logger = safeLogger(options.logger ?? consoleLogger);
  }

  /** Signal for the current in-flight run, so tools can honour cancellation. */
  signalFor(sessionId: SessionId): AbortSignal | undefined {
    return this.states.get(sessionId)?.abort?.signal;
  }

  isRunning(sessionId: SessionId): boolean {
    return this.states.get(sessionId)?.running ?? false;
  }

  queueDepth(sessionId: SessionId): number {
    const state = this.states.get(sessionId);
    return (state?.queue.length ?? 0) + (state?.pending.length ?? 0);
  }

  /** Accepts an inbound human message and schedules it according to the mode. */
  async submit(message: InboundMessage): Promise<void> {
    const state = this.stateFor(message.sessionId);

    switch (this.mode) {
      case "skip":
        if (state.running) return;
        state.queue.push(message);
        break;

      case "preempt":
        if (state.running && state.abort) state.abort.abort();
        state.queue.push(message);
        break;

      case "debounce":
      case "batch":
        state.pending.push(message);
        if (state.pending.length > this.maxBatchSize) state.pending.shift();
        this.resetWindow(state, message.sessionId);
        return;

      case "queue":
      default:
        state.queue.push(message);
        break;
    }

    await this.drain(message.sessionId);
  }

  /** Cancels the in-flight run and clears anything waiting. */
  interrupt(sessionId: SessionId): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    state.abort?.abort();
    state.queue = [];
    state.pending = [];
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.retry) {
      clearTimeout(state.retry);
      state.retry = null;
    }
  }

  private resetWindow(state: SessionState, sessionId: SessionId): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      const collected = state.pending;
      state.pending = [];
      if (collected.length === 0) return;

      if (this.mode === "debounce") {
        const last = collected[collected.length - 1];
        if (last) state.queue.push(last);
      } else {
        state.queue.push(...collected);
      }
      void this.drain(sessionId);
    }, this.windowMs);
    unrefTimer(state.timer);
  }

  private async drain(sessionId: SessionId): Promise<void> {
    const state = this.stateFor(sessionId);
    if (state.running || state.queue.length === 0) return;

    // Claim the local slot before awaiting the lease, or two concurrent drains
    // in this process would both get past the guard above.
    state.running = true;

    if (this.lease && !(await this.acquireLease(sessionId, state))) {
      state.running = false;
      return;
    }

    const messages =
      this.mode === "batch" ? state.queue.splice(0, state.queue.length) : [state.queue.shift()!];

    state.abort = new AbortController();
    const renewal = this.lease ? this.startRenewing(sessionId, state) : null;

    try {
      await this.runner({
        sessionId,
        messages,
        preempts: this.mode === "preempt",
      });
    } catch (error) {
      if (!state.abort.signal.aborted) {
        this.logger.error("turn failed", { sessionId, error });
      }
    } finally {
      if (renewal) clearInterval(renewal);
      state.running = false;
      state.abort = null;
      if (this.lease) {
        await this.lease
          .release(sessionId, this.holderId)
          .catch((error) =>
            this.logger.warn("could not release the turn lease", { sessionId, error }),
          );
      }
    }

    if (state.queue.length > 0) await this.drain(sessionId);
  }

  /**
   * Takes the lease, or schedules a retry and reports false.
   *
   * The queue is left untouched on failure: another instance is mid-turn, and
   * these messages are still owed a reply once it finishes.
   */
  private async acquireLease(sessionId: SessionId, state: SessionState): Promise<boolean> {
    let acquired = false;
    try {
      acquired = await this.lease!.acquire(sessionId, this.holderId, this.leaseTtlMs);
    } catch (error) {
      // A lease backend that is down must not silently degrade into running
      // anyway — that is the concurrent-run bug it exists to prevent.
      this.logger.error("could not reach the turn lease; not running", {
        sessionId,
        error,
      });
    }
    if (acquired) return true;

    if (!state.retry) {
      state.retry = setTimeout(() => {
        state.retry = null;
        void this.drain(sessionId);
      }, this.leaseRetryMs);
      unrefTimer(state.retry);
    }
    return false;
  }

  /**
   * Keeps the lease alive while the turn runs, and aborts if it is lost.
   *
   * Losing a lease mid-run means another instance may already be running this
   * session, so continuing would produce exactly the interleaved output the
   * lease prevents. Aborting is the safe side of that trade, and the cost is
   * real: a Redis blip cuts a legitimate reply short.
   */
  private startRenewing(
    sessionId: SessionId,
    state: SessionState,
  ): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      void (async () => {
        try {
          const held = await this.lease!.renew(sessionId, this.holderId, this.leaseTtlMs);
          if (held) return;
          this.logger.warn("lost the turn lease mid-run; aborting", { sessionId });
        } catch (error) {
          this.logger.warn("could not renew the turn lease; aborting", {
            sessionId,
            error,
          });
        }
        state.abort?.abort();
      })();
    }, this.leaseRenewMs);

    unrefTimer(timer);
    return timer;
  }

  private stateFor(sessionId: SessionId): SessionState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = {
        running: false,
        queue: [],
        pending: [],
        timer: null,
        abort: null,
        retry: null,
      };
      this.states.set(sessionId, state);
    }
    return state;
  }
}
