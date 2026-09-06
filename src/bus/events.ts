import type {
  ApprovalRequest,
  ParticipantId,
  Participant,
  PresenceState,
  SessionId,
} from "../types.js";

/**
 * The wire protocol between the Mastra server and every connected participant.
 *
 * Every event carries `sessionId` and a monotonically increasing `seq` so a
 * client that reconnects can ask for everything after the last sequence it saw
 * rather than replaying the whole session.
 */
export interface BaseEvent {
  sessionId: SessionId;
  seq: number;
  at: number;
}

export interface ParticipantJoinedEvent extends BaseEvent {
  type: "participant.joined";
  participant: Participant;
}

export interface ParticipantLeftEvent extends BaseEvent {
  type: "participant.left";
  participantId: ParticipantId;
}

export interface PresenceUpdatedEvent extends BaseEvent {
  type: "presence.updated";
  presence: PresenceState[];
}

export interface MessageEvent extends BaseEvent {
  type: "message";
  participantId: ParticipantId | null;
  text: string;
  /** Set when this message came from the agent rather than a human. */
  fromAgent: boolean;
}

export interface AgentDeltaEvent extends BaseEvent {
  type: "agent.delta";
  runId: string;
  delta: string;
}

export interface AgentRunStateEvent extends BaseEvent {
  type: "agent.run.started" | "agent.run.finished" | "agent.run.interrupted";
  runId: string;
  /** The participant whose message triggered or interrupted the run. */
  triggeredBy: ParticipantId | null;
}

export interface ApprovalEvent extends BaseEvent {
  type: "approval.requested" | "approval.updated" | "approval.resolved";
  request: ApprovalRequest;
}

export type MultiplayerEvent =
  | ParticipantJoinedEvent
  | ParticipantLeftEvent
  | PresenceUpdatedEvent
  | MessageEvent
  | AgentDeltaEvent
  | AgentRunStateEvent
  | ApprovalEvent;

export type MultiplayerEventType = MultiplayerEvent["type"];

export type EventHandler = (event: MultiplayerEvent) => void;
