import { unrefTimer } from "../internal/timers.js";
import type {
  ConcurrencyMode,
  InboundMessage,
  SessionId,
} from "../types.js";

export interface TurnControllerOptions {
  mode?: ConcurrencyMode;
  /** Window for "debounce" and "batch". Default 1500ms. */
  windowMs?: number;
  /** Max messages collapsed into one batch. Default 10. */
  maxBatchSize?: number;
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
  private states = new Map<SessionId, SessionState>();

  constructor(
    private readonly runner: TurnRunner,
    options: TurnControllerOptions = {},
  ) {
    this.mode = options.mode ?? "queue";
    this.windowMs = options.windowMs ?? 1500;
    this.maxBatchSize = options.maxBatchSize ?? 10;
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

    const messages =
      this.mode === "batch" ? state.queue.splice(0, state.queue.length) : [state.queue.shift()!];

    state.running = true;
    state.abort = new AbortController();

    try {
      await this.runner({
        sessionId,
        messages,
        preempts: this.mode === "preempt",
      });
    } catch (error) {
      if (!state.abort.signal.aborted) {
        console.error("[mastra-multiplayer] turn failed", error);
      }
    } finally {
      state.running = false;
      state.abort = null;
    }

    if (state.queue.length > 0) await this.drain(sessionId);
  }

  private stateFor(sessionId: SessionId): SessionState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { running: false, queue: [], pending: [], timer: null, abort: null };
      this.states.set(sessionId, state);
    }
    return state;
  }
}
