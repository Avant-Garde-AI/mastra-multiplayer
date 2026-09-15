import { randomUUID } from "node:crypto";

import { ApprovalGate, type ApprovalPolicy } from "./approvals/index.js";
import {
  channelContentToText,
  labelBatch,
  withMultiplayerContext,
} from "./attribution/index.js";
import { EventBus, type EventBusOptions } from "./bus/event-bus.js";
import type { MultiplayerBus } from "./bus/bus.js";
import { TurnController, type Turn, type TurnControllerOptions } from "./concurrency/index.js";
import { PresenceManager, type PresenceOptions } from "./presence/index.js";
import { InMemoryMultiplayerStore, type MultiplayerStore } from "./storage/index.js";
import { consoleLogger, safeLogger, type Logger } from "./internal/logger.js";
import type {
  ApprovalRequest,
  AuditAction,
  ChannelContentPart,
  ChannelCorrelation,
  InboundMessage,
  Participant,
  ParticipantId,
  SessionId,
  SessionRecord,
} from "./types.js";

/**
 * The slice of a Mastra agent this package uses. Typed structurally so the
 * package compiles and tests without `@mastra/core` installed, and so a fake
 * agent can be dropped in.
 */
export interface AgentLike {
  id?: string;
  name?: string;
  instructions?: string;
  stream(
    input: string,
    options?: Record<string, unknown>,
  ): Promise<{ textStream: AsyncIterable<string> }>;
}

export interface MultiplayerOptions {
  agent: AgentLike;
  agentId?: string;
  store?: MultiplayerStore;
  /**
   * Options for the built-in in-process bus, or a bus instance to use instead
   * — `RedisEventBus` for a deployment running more than one process.
   */
  bus?: EventBusOptions | MultiplayerBus;
  presence?: PresenceOptions;
  concurrency?: TurnControllerOptions;
  /** Policy applied when a tool requests approval without naming one. */
  defaultApprovalPolicy?: ApprovalPolicy;
  /**
   * Where this package reports failures. Set once here and every piece it
   * constructs uses it. Defaults to `console`.
   */
  logger?: Logger;
  /**
   * Called to build the per-turn options passed to `agent.stream`. Use it to
   * set memory scoping, runtime context, or tool overrides.
   */
  buildStreamOptions?: (context: TurnContext) => Record<string, unknown>;
}

export interface TurnContext {
  session: SessionRecord;
  participants: Participant[];
  messages: InboundMessage[];
  runId: string;
  signal?: AbortSignal;
}

export interface BatchMessageInput {
  participantId: ParticipantId;
  text?: string;
  content?: ChannelContentPart[];
  receivedAt: number;
  correlation?: ChannelCorrelation;
  metadata?: Record<string, unknown>;
}

export type AgentRunResult =
  | { status: "completed"; runId: string; text: string }
  | { status: "interrupted"; runId: string; text: string }
  | {
      status: "failed";
      runId: string | null;
      text: string;
      error: { code: string; message: string };
    };

export type HostDrivenBatchResult =
  | AgentRunResult
  | { status: "busy"; runId: null; text: "" };

/**
 * A shared agent session: one Mastra thread, many humans.
 *
 * Composition over inheritance — presence, approvals, and turn-taking are
 * independent pieces you can also use on their own.
 */
export class MultiplayerSession {
  readonly bus: MultiplayerBus;
  readonly store: MultiplayerStore;
  readonly presence: PresenceManager;
  readonly approvals: ApprovalGate;
  readonly turns: TurnController<AgentRunResult>;

  private readonly agent: AgentLike;
  private readonly agentId: string;
  private readonly buildStreamOptions: MultiplayerOptions["buildStreamOptions"];
  private readonly logger: Logger;

  constructor(options: MultiplayerOptions) {
    this.agent = options.agent;
    this.agentId = options.agentId ?? options.agent.id ?? options.agent.name ?? "agent";
    // Built once and handed to every piece, so a host configures logging in
    // one place rather than per component.
    const logger = safeLogger(options.logger ?? consoleLogger);
    this.logger = logger;
    this.store = options.store ?? new InMemoryMultiplayerStore();
    this.bus =
      options.bus && "publish" in options.bus
        ? options.bus
        : new EventBus({ ...options.bus, logger });
    this.presence = new PresenceManager(this.store, this.bus, {
      ...options.presence,
      logger,
    });
    this.approvals = new ApprovalGate(
      this.store,
      this.bus,
      options.defaultApprovalPolicy,
      logger,
    );
    this.turns = new TurnController((turn) => this.runTurn(turn), {
      ...options.concurrency,
      logger: options.concurrency?.logger ?? logger,
    });
    this.buildStreamOptions = options.buildStreamOptions;
  }

  /** Creates a shared session bound to a Mastra thread. */
  async createSession(input: {
    threadId: string;
    title?: string;
    id?: SessionId;
    metadata?: Record<string, unknown>;
  }): Promise<SessionRecord> {
    const now = Date.now();
    const session: SessionRecord = {
      id: input.id ?? randomUUID(),
      threadId: input.threadId,
      agentId: this.agentId,
      ...(input.title ? { title: input.title } : {}),
      createdAt: now,
      updatedAt: now,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    await this.store.createSession(session);
    await this.audit(session.id, "session.created", null, { threadId: input.threadId });
    return session;
  }

  async join(sessionId: SessionId, participant: Participant): Promise<Participant[]> {
    await this.store.addParticipant(sessionId, participant);
    await this.bus.publish({ type: "participant.joined", sessionId, participant });
    await this.audit(sessionId, "participant.joined", participant.id, {
      surface: participant.surface,
      role: participant.role,
    });
    await this.presence.heartbeat(sessionId, participant.id, "active");
    return this.store.listParticipants(sessionId);
  }

  async leave(sessionId: SessionId, participantId: ParticipantId): Promise<void> {
    await this.presence.leave(sessionId, participantId);
    await this.store.removeParticipant(sessionId, participantId);
    await this.audit(sessionId, "participant.left", participantId, {});
  }

  /**
   * Accepts a message from one human. Whether it starts a turn immediately,
   * queues, or is folded into a batch depends on the concurrency mode.
   */
  async send(input: {
    sessionId: SessionId;
    participantId: ParticipantId;
    /** Existing text-only input. Optional when `content` is present. */
    text?: string;
    content?: ChannelContentPart[];
    correlation?: ChannelCorrelation;
    addressedToAgent?: boolean;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const text = input.content?.length
      ? channelContentToText(input.content)
      : input.text?.trim() ?? "";
    if (!text) throw new RangeError("A message must contain text or media content");

    const message: InboundMessage = {
      sessionId: input.sessionId,
      participantId: input.participantId,
      text,
      ...(input.content?.length ? { content: input.content } : {}),
      ...(input.correlation ? { correlation: input.correlation } : {}),
      receivedAt: Date.now(),
      addressedToAgent: input.addressedToAgent ?? true,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };

    // Every message is visible to the room, whether or not the agent replies.
    await this.bus.publish({
      type: "message",
      sessionId: message.sessionId,
      participantId: message.participantId,
      text: message.text,
      ...(message.content ? { content: message.content } : {}),
      fromAgent: false,
    });
    await this.audit(message.sessionId, "message.sent", message.participantId, {});

    if (!message.addressedToAgent) return;
    await this.turns.submit(message);
  }

  /**
   * Runs a complete batch selected and retained by a durable host.
   *
   * This method never creates an in-memory quiet-window timer. `busy` means no
   * run started, so the host must keep its cursor unchanged and retry later.
   */
  async runBatch(input: {
    sessionId: SessionId;
    messages: BatchMessageInput[];
  }): Promise<HostDrivenBatchResult> {
    if (input.messages.length === 0) {
      throw new RangeError("A host-driven batch requires at least one message");
    }

    const messages: InboundMessage[] = input.messages.map((message) => {
      const text = message.content?.length
        ? channelContentToText(message.content)
        : message.text?.trim() ?? "";
      if (!text) throw new RangeError("Every batch message must contain text or media");
      return {
        sessionId: input.sessionId,
        participantId: message.participantId,
        text,
        ...(message.content?.length ? { content: message.content } : {}),
        ...(message.correlation ? { correlation: message.correlation } : {}),
        receivedAt: message.receivedAt,
        addressedToAgent: true,
        ...(message.metadata ? { metadata: message.metadata } : {}),
      };
    });

    const attempt = await this.turns.runExplicit({
      sessionId: input.sessionId,
      messages,
    });
    if (attempt.status === "completed") return attempt.value;
    if (attempt.status === "busy") return { status: "busy", runId: null, text: "" };

    const error = publicError(
      attempt.error,
      attempt.status === "unavailable" ? "turn_unavailable" : "turn_failed",
    );
    return { status: "failed", runId: null, text: "", error };
  }

  /**
   * Stops the in-flight run. Anyone in the session may do this.
   *
   * Aborts locally first, then publishes — so the instance actually running the
   * turn stops even when the request landed somewhere else. The publishing
   * instance receives its own event too; interrupting an already-stopped run is
   * a no-op.
   */
  async interrupt(sessionId: SessionId, participantId: ParticipantId): Promise<void> {
    this.turns.interrupt(sessionId);
    const session = await this.store.getSession(sessionId);
    await this.bus.publish({
      type: "agent.run.interrupted",
      sessionId,
      runId: session?.runningRunId ?? "unknown",
      triggeredBy: participantId,
    });
    await this.audit(sessionId, "agent.run.interrupted", participantId, {});
  }

  /**
   * Resolves expired approvals across every session.
   *
   * Convenience over `approvals.sweepExpired(sessionId)` for hosts that do not
   * track which sessions are live. It reads the session list on each call, so
   * on a large deployment prefer sweeping the sessions you know are active.
   */
  async sweepExpiredApprovals(): Promise<ApprovalRequest[]> {
    const sessions = await this.store.listSessions();
    const resolved: ApprovalRequest[] = [];
    for (const session of sessions) {
      resolved.push(...(await this.approvals.sweepExpired(session.id)));
    }
    return resolved;
  }

  private async runTurn(turn: Turn): Promise<AgentRunResult> {
    const runId = randomUUID();
    const session = await this.store.getSession(turn.sessionId);
    if (!session) {
      return {
        status: "failed",
        runId,
        text: "",
        error: { code: "session_not_found", message: "Session not found" },
      };
    }

    const participants = await this.store.listParticipants(turn.sessionId);
    const signal = this.turns.signalFor(turn.sessionId);

    await this.store.updateSession(turn.sessionId, { runningRunId: runId });
    await this.bus.publish({
      type: "agent.run.started",
      sessionId: turn.sessionId,
      runId,
      triggeredBy: turn.messages[turn.messages.length - 1]?.participantId ?? null,
    });
    await this.audit(turn.sessionId, "agent.run.started", null, { runId });

    const context: TurnContext = {
      session,
      participants,
      messages: turn.messages,
      runId,
      ...(signal ? { signal } : {}),
    };

    // An interrupt raised on another instance arrives as an event, not a local
    // call — so listen for one while the run is in flight. Without this,
    // `interrupt()` on the wrong instance publishes `agent.run.interrupted`
    // and aborts nothing, and every client shows the run as stopped while the
    // agent keeps streaming.
    const stopListening = this.bus.subscribe(turn.sessionId, (event) => {
      if (event.type === "agent.run.interrupted") this.turns.interrupt(turn.sessionId);
    });

    const prompt = labelBatch(turn.messages, participants);
    const streamOptions: Record<string, unknown> = {
      memory: { thread: session.threadId, resource: session.id },
      instructions: withMultiplayerContext(
        this.agent.instructions ?? "",
        participants,
      ),
      ...(signal ? { abortSignal: signal } : {}),
      ...(this.buildStreamOptions?.(context) ?? {}),
    };

    let full = "";
    let failure: { code: string; message: string } | null = null;
    try {
      const result = await this.agent.stream(prompt, streamOptions);
      for await (const delta of result.textStream) {
        if (signal?.aborted) break;
        full += delta;
        await this.bus.publish({
          type: "agent.delta",
          sessionId: turn.sessionId,
          runId,
          delta,
        });
      }
    } catch (error) {
      failure = publicError(error, "agent_error");
      this.logger.error("agent run failed", {
        sessionId: turn.sessionId,
        runId,
        error,
      });
    } finally {
      stopListening();
      await this.store.updateSession(turn.sessionId, { runningRunId: undefined });
    }

    if (failure) {
      await this.bus.publish({
        type: "agent.run.failed",
        sessionId: turn.sessionId,
        runId,
        triggeredBy: null,
        error: failure,
      });
      await this.audit(turn.sessionId, "agent.run.failed", null, {
        runId,
        code: failure.code,
      });
      return { status: "failed", runId, text: full, error: failure };
    }

    if (signal?.aborted) {
      // A direct/cross-instance interrupt already published its own event.
      // Preemption and lease loss have no caller event, so close the run here.
      if (signal.reason !== "interrupted") {
        await this.bus.publish({
          type: "agent.run.interrupted",
          sessionId: turn.sessionId,
          runId,
          triggeredBy: null,
        });
        await this.audit(turn.sessionId, "agent.run.interrupted", null, {
          runId,
          reason: String(signal.reason ?? "aborted"),
        });
      }
      return { status: "interrupted", runId, text: full };
    }

    if (full.length > 0) {
      await this.bus.publish({
        type: "message",
        sessionId: turn.sessionId,
        participantId: null,
        text: full,
        fromAgent: true,
      });
    }

    await this.bus.publish({
      type: "agent.run.finished",
      sessionId: turn.sessionId,
      runId,
      triggeredBy: null,
    });
    await this.audit(turn.sessionId, "agent.run.finished", null, { runId });
    return { status: "completed", runId, text: full };
  }

  private async audit(
    sessionId: SessionId,
    action: AuditAction,
    actorId: ParticipantId | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.store.appendAudit({
      id: randomUUID(),
      sessionId,
      action,
      actorId,
      at: Date.now(),
      detail,
    });
  }
}

function publicError(
  error: unknown,
  code: string,
): { code: string; message: string } {
  return {
    code,
    message: error instanceof Error ? error.message : "Unknown error",
  };
}

export function createMultiplayer(options: MultiplayerOptions): MultiplayerSession {
  return new MultiplayerSession(options);
}
