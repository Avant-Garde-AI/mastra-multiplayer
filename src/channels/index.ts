/**
 * Turning a message from a Mastra channel into a participant in a shared
 * session.
 *
 * A session can already span a web UI and a Slack thread — `Participant.surface`
 * and `resourceId` exist for exactly that. Nothing populated them from a
 * channel, so every adopter wrote the same twenty-line translation, differently.
 *
 * **No vendor SDK is involved.** Mastra's channel adapters are separate
 * `@chat-adapter/*` packages the host installs and hands to its own agent; this
 * module never imports one. What is here is a mapping between two shapes:
 * Mastra's `actor` and this package's `Participant`. See
 * [the research](../../docs/roadmap/research/2026-09-07-mastra-apis.md).
 */
import { createHash } from "node:crypto";

import { channelContentToText } from "../attribution/index.js";
import { consoleLogger, safeLogger, type Logger } from "../internal/logger.js";
import type { MultiplayerSession } from "../session.js";
import type {
  ChannelContentPart,
  Participant,
  ParticipantId,
  ParticipantRole,
  ParticipantSurface,
  SessionId,
} from "../types.js";

/**
 * Who sent a channel message, in Mastra's shape.
 *
 * Declared structurally rather than imported, for the same reason the agent and
 * Hono types are (docs/decisions/0004): this package compiles and tests without
 * `@mastra/core` installed.
 */
export interface ChannelActor {
  userId: string;
  userName?: string;
  fullName?: string;
  /**
   * `'unknown'` when the adapter could not tell. Treated as a bot by default —
   * see `allowBots`.
   */
  isBot?: boolean | "unknown";
}

/** One inbound message from a channel. */
export interface ChannelMessage {
  /** The adapter key: `slack`, `discord`, `telegram`, … */
  surface: ParticipantSurface;
  actor: ChannelActor;
  /** Mastra's thread id for the channel conversation. */
  threadId: string;
  channelId?: string;
  /** Compatibility input for text-only adapters. */
  text?: string;
  /** Provider-neutral structured content. Takes precedence over `text`. */
  content?: ChannelContentPart[];
  /** Whether the agent should reply. Default true. */
  addressedToAgent?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ChannelParticipantOptions {
  surface: ParticipantSurface;
  actor: ChannelActor;
  /** Default `editor`. */
  role?: ParticipantRole;
  /** Override the privacy-safe label used when the provider supplies no name. */
  fallbackDisplayName?: (actor: ChannelActor) => string;
}

function anonymousDisplayName(actor: ChannelActor): string {
  const suffix = createHash("sha256").update(actor.userId).digest("hex").slice(0, 6);
  return `Participant ${suffix.toUpperCase()}`;
}

/**
 * Maps a channel actor onto a `Participant`.
 *
 * Pure, and exported on its own so it can be used without the bridge — a host
 * that already manages its own roster wants the mapping and nothing else.
 *
 * ```ts
 * channelParticipant({ surface: "slack", actor: { userId: "U06CK1E9HN2", fullName: "Alice Chen" } })
 * // { id: "slack:U06CK1E9HN2", displayName: "Alice Chen", role: "editor",
 * //   surface: "slack", resourceId: "slack:U06CK1E9HN2" }
 * ```
 */
export function channelParticipant(options: ChannelParticipantOptions): Participant {
  const { surface, actor } = options;

  // Prefixed with the surface, deliberately. Two platforms will eventually hand
  // out the same opaque id, and an unprefixed collision silently merges two
  // people into one participant — which, under `excludeRequester`, silently
  // turns four-eyes into two.
  const id = `${surface}:${actor.userId}`;

  return {
    id,
    displayName:
      actor.fullName ??
      actor.userName ??
      options.fallbackDisplayName?.(actor) ??
      anonymousDisplayName(actor),
    role: options.role ?? "editor",
    surface,
    resourceId: id,
  };
}

/** Whether this actor should be treated as a bot. */
export function isBotActor(actor: ChannelActor): boolean {
  return actor.isBot === true || actor.isBot === "unknown";
}

export type ReceiveStatus =
  | "delivered"
  | "ignored_bot"
  | "ignored_no_session"
  | "ignored_empty";

export interface ReceiveResult {
  status: ReceiveStatus;
  sessionId?: SessionId;
  participant?: Participant;
}

export interface ChannelBridgeOptions {
  /**
   * Which session this message belongs to, or null to ignore it.
   *
   * Required, and deliberately not defaulted. Mastra's `threadId` is per
   * channel thread; whether that is one session per thread, per channel, or per
   * support ticket is the host's decision, and guessing it wrong silently
   * merges or splits conversations.
   */
  resolveSession: (
    message: ChannelMessage,
  ) => Promise<SessionId | null | undefined> | SessionId | null | undefined;

  /**
   * What role this person gets. Defaults to `editor`.
   *
   * A function rather than a field because who may approve what is the host's
   * policy, and it is the one thing here that is security-relevant.
   */
  role?: (
    message: ChannelMessage,
  ) => Promise<ParticipantRole> | ParticipantRole;

  /**
   * Let bots into the roster. Default false.
   *
   * A bot is a participant by every structural measure and not one by any
   * useful one: it would appear in `rosterPrompt()` and count toward a quorum,
   * so an automation posting into a channel could satisfy a four-eyes gate.
   *
   * `isBot: 'unknown'` counts as a bot under this default. That errs toward
   * excluding a real human, which is a *visible* failure — someone says "I am
   * not in the room" — where the opposite is a silent governance one. It is
   * logged at `warn` so it can be diagnosed rather than puzzled over.
   */
  allowBots?: boolean;

  /** Replace the participant mapping entirely. */
  participant?: (message: ChannelMessage) => Participant | Promise<Participant>;

  /** Passed to the default participant mapper when an actor has no name. */
  fallbackDisplayName?: (actor: ChannelActor) => string;

  logger?: Logger;
}

export interface ReconcileRosterInput {
  sessionId: SessionId;
  /** Only this surface is eligible for removal from an authoritative snapshot. */
  surface: ParticipantSurface;
  participants: Participant[];
  /** Remove surface participants absent from this snapshot. Default false. */
  authoritative?: boolean;
}

export interface ReconcileRosterResult {
  joined: ParticipantId[];
  updated: ParticipantId[];
  unchanged: ParticipantId[];
  removed: ParticipantId[];
}

/** Normalizes legacy text and structured adapter payloads into content parts. */
export function normalizeChannelContent(message: ChannelMessage): ChannelContentPart[] {
  const structured = message.content?.filter((part) =>
    part.type === "text" ? part.text.trim().length > 0 : true,
  );
  if (structured?.length) return structured;

  const text = message.text?.trim();
  return text ? [{ type: "text", text }] : [];
}

/**
 * Joins channel senders into a session and forwards what they say.
 *
 * ```ts
 * const bridge = new ChannelBridge(multiplayer, {
 *   resolveSession: ({ threadId }) => sessionIdFor(threadId),
 *   role: ({ actor }) => (admins.has(actor.userId) ? "owner" : "editor"),
 * });
 *
 * await bridge.receive({ surface: "slack", actor, threadId, text });
 * ```
 *
 * That is the whole integration: the host's adapter callback hands each message
 * to `receive`, and the session gains a participant and a message.
 */
export class ChannelBridge {
  private readonly logger: Logger;

  constructor(
    private readonly session: MultiplayerSession,
    private readonly options: ChannelBridgeOptions,
  ) {
    this.logger = safeLogger(options.logger ?? consoleLogger);
  }

  async receive(message: ChannelMessage): Promise<ReceiveResult> {
    if (!this.options.allowBots && isBotActor(message.actor)) {
      this.logger.warn("ignoring a channel message from a bot actor", {
        surface: message.surface,
        userId: message.actor.userId,
        isBot: message.actor.isBot,
      });
      return { status: "ignored_bot" };
    }

    const content = normalizeChannelContent(message);
    if (content.length === 0) return { status: "ignored_empty" };

    const sessionId = await this.options.resolveSession(message);
    if (!sessionId) return { status: "ignored_no_session" };

    const participant = await this.participantFor(message);
    await this.ensureJoined(sessionId, participant);

    await this.session.send({
      sessionId,
      participantId: participant.id,
      text: channelContentToText(content),
      content,
      addressedToAgent: message.addressedToAgent ?? true,
      ...(message.metadata ? { metadata: message.metadata } : {}),
    });

    return { status: "delivered", sessionId, participant };
  }

  /**
   * Reconciles a provider roster snapshot without disturbing participants from
   * other surfaces. Use `authoritative` only for a complete provider snapshot.
   */
  async reconcileRoster(input: ReconcileRosterInput): Promise<ReconcileRosterResult> {
    const result: ReconcileRosterResult = {
      joined: [],
      updated: [],
      unchanged: [],
      removed: [],
    };
    const ids = new Set<string>();

    for (const participant of input.participants) {
      if (participant.surface !== input.surface) {
        throw new RangeError(
          `Participant ${participant.id} belongs to ${participant.surface}, not ${input.surface}`,
        );
      }
      if (ids.has(participant.id)) {
        throw new RangeError(`Duplicate participant ${participant.id} in roster snapshot`);
      }
      ids.add(participant.id);

      const existing = await this.session.store.getParticipant(
        input.sessionId,
        participant.id,
      );
      if (!existing) {
        await this.session.join(input.sessionId, participant);
        result.joined.push(participant.id);
      } else if (!sameParticipant(existing, participant)) {
        await this.session.join(input.sessionId, participant);
        result.updated.push(participant.id);
      } else {
        result.unchanged.push(participant.id);
      }
    }

    if (input.authoritative) {
      const existing = await this.session.store.listParticipants(input.sessionId);
      for (const participant of existing) {
        if (participant.surface === input.surface && !ids.has(participant.id)) {
          await this.session.leave(input.sessionId, participant.id);
          result.removed.push(participant.id);
        }
      }
    }

    return result;
  }

  private async participantFor(message: ChannelMessage): Promise<Participant> {
    if (this.options.participant) return this.options.participant(message);

    const role = this.options.role ? await this.options.role(message) : undefined;
    return channelParticipant({
      surface: message.surface,
      actor: message.actor,
      ...(role ? { role } : {}),
      ...(this.options.fallbackDisplayName
        ? { fallbackDisplayName: this.options.fallbackDisplayName }
        : {}),
    });
  }

  /**
   * Joins only when something would actually change.
   *
   * `addParticipant` is an upsert, so joining on every message is safe — but it
   * publishes `participant.joined` every time, and a chatty channel would fill
   * the event stream with a person repeatedly arriving. Re-joining on a rename
   * or a role change is the case worth paying for.
   */
  private async ensureJoined(
    sessionId: SessionId,
    participant: Participant,
  ): Promise<void> {
    const existing = await this.session.store.getParticipant(
      sessionId,
      participant.id,
    );

    if (existing && sameParticipant(existing, participant)) {
      return;
    }

    await this.session.join(sessionId, participant);
  }
}

function sameParticipant(left: Participant, right: Participant): boolean {
  return (
    left.displayName === right.displayName &&
    left.role === right.role &&
    left.surface === right.surface &&
    left.resourceId === right.resourceId &&
    left.email === right.email
  );
}

/** Convenience constructor, matching `createMultiplayer`'s style. */
export function channelBridge(
  session: MultiplayerSession,
  options: ChannelBridgeOptions,
): ChannelBridge {
  return new ChannelBridge(session, options);
}
