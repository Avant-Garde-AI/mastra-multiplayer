/**
 * One session, two surfaces: a web client and a Slack thread.
 *
 * Everyone in the Slack thread appears in the same roster as everyone in the
 * web UI, is labelled by name in the prompt the agent sees, and can vote on an
 * approval. Nothing here imports a Slack SDK — `@chat-adapter/slack` belongs to
 * Mastra and to your agent, not to this package.
 *
 * Run against a real Mastra install. This file is illustrative.
 */
// @ts-nocheck
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/core/memory";
import { registerApiRoute } from "@mastra/core/server";
import { LibSQLStore } from "@mastra/libsql";
import { createSlackAdapter } from "@chat-adapter/slack";
import { openai } from "@ai-sdk/openai";
import { createClient } from "@libsql/client";

import { createMultiplayer } from "@avant-garde-ai/mastra-multiplayer";
import { channelBridge } from "@avant-garde-ai/mastra-multiplayer/channels";
import { multiplayerRoutes } from "@avant-garde-ai/mastra-multiplayer/server";
import { LibSQLMultiplayerStore } from "@avant-garde-ai/mastra-multiplayer/storage/libsql";

const client = createClient({ url: "file:./multiplayer.db" });
const store = new LibSQLMultiplayerStore(client);
await store.migrate();

const support = new Agent({
  id: "support",
  name: "Support",
  instructions: "You help the team resolve customer issues. Be concise.",
  model: openai("gpt-4o-mini"),
  memory: new Memory({
    storage: new LibSQLStore({ url: "file:./mastra.db" }),
    // Shared session: what one person tells the agent should stay in the room.
    options: { workingMemory: { enabled: true, scope: "thread" } },
  }),
  // The adapter is the agent's, and it brings its own SDK. This package never
  // sees it — it only receives the actor and thread a message arrived with.
  channels: { adapters: { slack: createSlackAdapter() } },
});

const multiplayer = createMultiplayer({
  agent: support,
  store,
  concurrency: { mode: "batch", windowMs: 2000 },
});

/* ------------------------------------------------------------------ */
/* Slack → session                                                     */
/* ------------------------------------------------------------------ */

/**
 * One session per Slack thread.
 *
 * This mapping is deliberately yours. Per-thread suits support; per-channel
 * suits a standing room; per-ticket suits a workflow. Guessing it wrong
 * silently merges or splits conversations, which is why there is no default.
 */
async function sessionForThread(threadId: string): Promise<string> {
  const existing = (await store.listSessions()).find((s) => s.threadId === threadId);
  if (existing) return existing.id;

  const created = await multiplayer.createSession({
    threadId,
    title: `Slack ${threadId}`,
  });
  return created.id;
}

const APPROVERS = new Set(["U_ALICE", "U_BOB"]);

const bridge = channelBridge(multiplayer, {
  resolveSession: ({ threadId }) => sessionForThread(threadId),
  // Who may approve is your policy, and it is the one security-relevant
  // decision in this file.
  role: ({ actor }) => (APPROVERS.has(actor.userId) ? "approver" : "editor"),
});

/**
 * Hand each inbound channel message to the bridge.
 *
 * Wire this to however your adapter surfaces messages. The bridge joins the
 * sender if they are new, forwards the text, and returns what it did.
 */
export async function onSlackMessage(event: {
  user: { id: string; real_name?: string; name?: string; is_bot?: boolean };
  thread_ts: string;
  channel: string;
  text: string;
}) {
  return bridge.receive({
    surface: "slack",
    actor: {
      userId: event.user.id,
      fullName: event.user.real_name,
      userName: event.user.name,
      isBot: event.user.is_bot,
    },
    threadId: event.thread_ts,
    channelId: event.channel,
    text: event.text,
    // Only reply when the agent is addressed; a thread is a conversation
    // between people that the agent happens to be in.
    addressedToAgent: event.text.includes("@support"),
    metadata: { slackTs: event.thread_ts },
  });
}

/* ------------------------------------------------------------------ */
/* The web half, unchanged                                             */
/* ------------------------------------------------------------------ */

const routes = multiplayerRoutes(multiplayer, {
  authenticate: async (c) => {
    const user = await verifySessionCookie(c.req.header("cookie"));
    if (!user) return null;
    return {
      id: `web:${user.id}`,
      displayName: user.name,
      role: APPROVERS.has(user.id) ? "approver" : "editor",
      surface: "web",
      resourceId: `web:${user.id}`,
    };
  },
});

export const mastra = new Mastra({
  agents: { support },
  server: {
    apiRoutes: routes.map((r) =>
      registerApiRoute(r.path, { method: r.method, handler: r.handler }),
    ),
  },
});

// Approvals expire on their own schedule; something has to ask.
setInterval(() => void multiplayer.sweepExpiredApprovals(), 60_000);

declare function verifySessionCookie(cookie?: string): Promise<{
  id: string;
  name: string;
} | null>;
