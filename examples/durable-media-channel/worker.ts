/**
 * A durable host owns the inbox, quiet window, and cursor. The multiplayer
 * package owns attribution and one leased agent turn.
 *
 * This deliberately uses small structural interfaces instead of prescribing a
 * queue or database. A Supabase cron, Postgres worker, or durable workflow can
 * all implement the same boundary.
 */
import type {
  BatchMessageInput,
  MultiplayerSession,
} from "../../src/session.js";

interface DueBatch {
  bindingId: string;
  sessionId: string;
  throughCursor: string;
  messages: BatchMessageInput[];
}

interface DurableInbox {
  claimDue(): Promise<DueBatch | null>;
  complete(bindingId: string, throughCursor: string, output: {
    runId: string;
    text: string;
  }): Promise<void>;
  retry(bindingId: string, reason: string): Promise<void>;
  fail(bindingId: string, reason: string): Promise<void>;
}

export async function processOneDueBatch(
  multiplayer: MultiplayerSession,
  inbox: DurableInbox,
): Promise<void> {
  const batch = await inbox.claimDue();
  if (!batch) return;

  const result = await multiplayer.runBatch({
    sessionId: batch.sessionId,
    messages: batch.messages,
  });

  switch (result.status) {
    case "completed":
      // Advance the durable cursor only after the complete response exists.
      await inbox.complete(batch.bindingId, batch.throughCursor, {
        runId: result.runId,
        text: result.text,
      });
      return;
    case "busy":
      // Another process owns the session lease. No local queue was created and
      // the durable cursor is unchanged, so retrying cannot lose the batch.
      await inbox.retry(batch.bindingId, "session_busy");
      return;
    case "interrupted":
      await inbox.retry(batch.bindingId, "run_interrupted");
      return;
    case "failed":
      await inbox.fail(batch.bindingId, result.error.code);
  }
}

