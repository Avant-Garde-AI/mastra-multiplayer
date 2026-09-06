import { randomUUID } from "node:crypto";

import { ApprovalGate, type ApprovalPolicy } from "./approvals/index.js";
import { labelBatch, withMultiplayerContext } from "./attribution/index.js";
import { EventBus, type EventBusOptions } from "./bus/event-bus.js";
import type { MultiplayerBus } from "./bus/bus.js";
import { TurnController, type Turn, type TurnControllerOptions } from "./concurrency/index.js";
import { PresenceManager, type PresenceOptions } from "./presence/index.js";
import { InMemoryMultiplayerStore, type MultiplayerStore } from "./storage/index.js";
import { consoleLogger, safeLogger, type Logger } from "./internal/logger.js";
import type {
  AuditAction,
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
  readonly turns: TurnController;

  private readonly agent: AgentLike;
  private readonly agentId: string;
  private readonly buildStreamOptions: MultiplayerOptions["buildStreamOptions"];

  constructor(options: MultiplayerOptions) {
    this.agent = options.agent;
    this.agentId = options.agentId ?? options.agent.id ?? options.agent.name ?? "agent";
    // Built once and handed to every piece, so a host configures logging in
    // one place rather than per component.
    const logger = safeLogger(options.logger ?? consoleLogger);
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
    text: string;
    addressedToAgent?: boolean;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const message: InboundMessage = {
      sessionId: input.sessionId,
      participantId: input.participantId,
      text: input.text,
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
      fromAgent: false,
    });
    await this.audit(message.sessionId, "message.sent", message.participantId, {});

    if (!message.addressedToAgent) return;
    await this.turns.submit(message);
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

  private async runTurn(turn: Turn): Promise<void> {
    const session = await this.store.getSession(turn.sessionId);
    if (!session) return;

    const participants = await this.store.listParticipants(turn.sessionId);
    const runId = randomUUID();
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
    } finally {
      stopListening();
      await this.store.updateSession(turn.sessionId, { runningRunId: undefined });
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

export function createMultiplayer(options: MultiplayerOptions): MultiplayerSession {
  return new MultiplayerSession(options);
}
