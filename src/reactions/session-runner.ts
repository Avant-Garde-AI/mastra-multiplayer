import type {
  HostDrivenBatchResult,
  MultiplayerSession,
} from "../session.js";
import type { ReactionClaim, ReactionOutput, ReactionRunner } from "./types.js";

export interface SessionReactionRunnerOptions {
  /** Maps a nullable transport actor to an application participant. */
  participantId?: (claim: ReactionClaim, eventIndex: number) => string | null;
  /** Treat interrupted agent runs as retryable. Default true. */
  retryInterrupted?: boolean;
}

/**
 * Adapts a durable reaction claim to `MultiplayerSession.runBatch()`.
 * The returned text is only a draft response intent; this never sends it.
 */
export function createSessionReactionRunner(
  session: MultiplayerSession,
  options: SessionReactionRunnerOptions = {},
): ReactionRunner<HostDrivenBatchResult> {
  return {
    async run(claim): Promise<ReactionOutput<HostDrivenBatchResult>> {
      const messages = claim.events.flatMap((event, index) => {
        const participantId =
          options.participantId?.(claim, index) ?? event.participantId;
        if (!participantId || event.content.length === 0) return [];
        return [{
          participantId,
          content: event.content,
          receivedAt: event.receivedAt,
          metadata: {
            reactionEventId: event.id,
            reactionCursor: event.cursor,
            ...event.metadata,
          },
        }];
      });

      if (messages.length === 0) {
        return {
          result: { status: "completed", runId: claim.attemptId, text: "" },
        };
      }

      const result = await session.runBatch({ sessionId: claim.sessionId, messages });
      if (result.status === "busy" || result.status === "failed") {
        throw new Error(
          result.status === "busy"
            ? "Multiplayer session is busy"
            : `${result.error.code}: ${result.error.message}`,
        );
      }
      if (result.status === "interrupted" && (options.retryInterrupted ?? true)) {
        throw new Error("Multiplayer session run was interrupted");
      }

      const text = result.text.trim();
      return {
        result,
        ...(text && claim.response.maxIntents === 1
          ? { response: { kind: "text" as const, text } }
          : {}),
      };
    },
  };
}
