/**
 * A shared support session: several people in one thread with one agent.
 *
 * Run against a real Mastra install. This file is illustrative — it imports
 * from `@mastra/core`, which is a peer dependency of this package.
 */
// @ts-nocheck
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { registerApiRoute } from "@mastra/core/server";
import { LibSQLStore } from "@mastra/libsql";
import { openai } from "@ai-sdk/openai";

import { createMultiplayer } from "@avant-garde-ai/mastra-multiplayer";
import { multiplayerRoutes } from "@avant-garde-ai/mastra-multiplayer/server";

const storage = new LibSQLStore({ url: "file:./multiplayer.db" });

const support = new Agent({
  id: "support",
  name: "Support",
  instructions: "You help the team resolve customer issues. Be concise.",
  model: openai("gpt-4o-mini"),
  memory: new Memory({
    storage,
    options: {
      // Working memory scoped to the thread, not the individual, so what one
      // person tells the agent is visible to everyone in the session.
      workingMemory: { enabled: true, scope: "thread" },
      semanticRecall: false,
    },
  }),
});

export const multiplayer = createMultiplayer({
  agent: support,
  concurrency: {
    // Two people typing at once produce one coherent turn rather than two
    // competing ones.
    mode: "batch",
    windowMs: 2000,
  },
  presence: {
    idleAfterMs: 30_000,
    dropAfterMs: 90_000,
  },
});

multiplayer.presence.startSweeping();

/**
 * Replace this with your real auth. Whatever you return here is the identity
 * every message, vote, and audit entry is attributed to, so it must come from
 * a verified session — never from the request body.
 */
async function authenticate(c) {
  const user = c.get("user"); // set by your auth middleware
  if (!user) return null;
  return {
    id: user.id,
    displayName: user.name,
    role: user.isAdmin ? "owner" : "editor",
    surface: "web",
    resourceId: `web:${user.id}`,
    email: user.email,
  };
}

const routes = multiplayerRoutes(multiplayer, { authenticate });

export const mastra = new Mastra({
  agents: { support },
  storage,
  server: {
    apiRoutes: routes.map((route) =>
      registerApiRoute(route.path, {
        method: route.method,
        handler: route.handler,
      }),
    ),
  },
});

// Create a session bound to a Mastra thread.
export async function openSession(threadId: string) {
  return multiplayer.createSession({
    threadId,
    title: "Escalation: order 4417",
  });
}
