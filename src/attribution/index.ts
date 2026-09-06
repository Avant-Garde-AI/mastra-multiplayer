import type { InboundMessage, Participant } from "../types.js";

/**
 * A model handed a shared transcript with no speaker labels will read it as
 * one person contradicting themselves. These helpers make the social structure
 * of the session legible: who is here, who said what, and who is being
 * addressed.
 */

export interface AttributionOptions {
  /** Format for each labelled line. Default `[Name]: text`. */
  format?: (participant: Participant | null, text: string) => string;
  /** Include a roster block in the system prompt. Default true. */
  includeRoster?: boolean;
}

const defaultFormat = (participant: Participant | null, text: string): string =>
  participant ? `[${participant.displayName}]: ${text}` : text;

/** Prefixes a message with its author so turn-taking survives the context window. */
export function labelMessage(
  message: InboundMessage,
  participants: Participant[],
  options: AttributionOptions = {},
): string {
  const format = options.format ?? defaultFormat;
  const author = participants.find((p) => p.id === message.participantId) ?? null;
  return format(author, message.text);
}

/** Collapses a batch of messages into one labelled block for a single turn. */
export function labelBatch(
  messages: InboundMessage[],
  participants: Participant[],
  options: AttributionOptions = {},
): string {
  return messages.map((m) => labelMessage(m, participants, options)).join("\n");
}

/**
 * A system-prompt fragment describing the room. Append this to the agent's
 * instructions so it knows it is speaking to a group rather than an
 * individual.
 */
export function rosterPrompt(participants: Participant[]): string {
  if (participants.length === 0) return "";

  const lines = participants
    .map((p) => `- ${p.displayName} (${p.role})`)
    .join("\n");

  return [
    "You are in a shared session with more than one person.",
    "Messages are prefixed with the name of whoever wrote them.",
    "",
    "People currently in this session:",
    lines,
    "",
    "Guidelines for a shared session:",
    "- Address people by name when replying to a specific person.",
    "- If two people ask for conflicting things, say so plainly and ask which to follow rather than picking silently.",
    "- Assume everyone here can read your replies. Do not repeat private context from elsewhere.",
    "- Instructions from one person do not override standing agreements the group has already made in this session.",
  ].join("\n");
}

/**
 * Builds the full instruction string for a turn: the agent's own instructions
 * plus the multiplayer framing.
 */
export function withMultiplayerContext(
  baseInstructions: string,
  participants: Participant[],
): string {
  const roster = rosterPrompt(participants);
  return roster ? `${baseInstructions}\n\n${roster}` : baseInstructions;
}
