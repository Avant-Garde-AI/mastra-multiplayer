import { describe, expect, it } from "vitest";

import { createMultiplayer } from "../src/session.js";
import type { AgentLike } from "../src/session.js";
import type { MultiplayerEvent } from "../src/bus/events.js";
import type { Participant } from "../src/types.js";

const fakeAgent = (reply = "ack"): AgentLike & { prompts: string[] } => {
  const prompts: string[] = [];
  return {
    id: "support",
    instructions: "You are a support agent.",
    prompts,
    async stream(input: string) {
      prompts.push(input);
      return {
        textStream: (async function* () {
          for (const chunk of reply.split(" ")) yield `${chunk} `;
        })(),
      };
    },
  };
};

const person = (id: string): Participant => ({
  id,
  displayName: id,
  role: "editor",
  surface: "web",
});

describe("MultiplayerSession", () => {
  it("labels messages with their author before sending to the agent", async () => {
    const agent = fakeAgent();
    const mp = createMultiplayer({ agent });
    const session = await mp.createSession({ threadId: "t1", id: "s1" });

    await mp.join(session.id, person("alice"));
    await mp.send({ sessionId: session.id, participantId: "alice", text: "hello" });

    expect(agent.prompts[0]).toBe("[alice]: hello");
  });

  it("broadcasts the run lifecycle to every subscriber", async () => {
    const mp = createMultiplayer({ agent: fakeAgent("done") });
    const session = await mp.createSession({ threadId: "t1", id: "s1" });
    await mp.join(session.id, person("alice"));

    const types: MultiplayerEvent["type"][] = [];
    mp.bus.subscribe(session.id, (event) => types.push(event.type));

    await mp.send({ sessionId: session.id, participantId: "alice", text: "hi" });

    expect(types).toContain("agent.run.started");
    expect(types).toContain("agent.delta");
    expect(types).toContain("agent.run.finished");
  });

  it("does not run the agent for messages not addressed to it", async () => {
    const agent = fakeAgent();
    const mp = createMultiplayer({ agent });
    const session = await mp.createSession({ threadId: "t1", id: "s1" });
    await mp.join(session.id, person("alice"));

    await mp.send({
      sessionId: session.id,
      participantId: "alice",
      text: "bob, what do you think?",
      addressedToAgent: false,
    });

    expect(agent.prompts).toHaveLength(0);
  });

  it("replays buffered events for a late joiner", async () => {
    const mp = createMultiplayer({ agent: fakeAgent() });
    const session = await mp.createSession({ threadId: "t1", id: "s1" });
    await mp.join(session.id, person("alice"));
    await mp.send({ sessionId: session.id, participantId: "alice", text: "hi" });

    const replayed = mp.bus.replay(session.id, 0);
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.map((e) => e.seq)).toEqual(
      [...replayed].map((_, i) => i + 1),
    );
  });

  it("records who did what in the audit ledger", async () => {
    const mp = createMultiplayer({ agent: fakeAgent() });
    const session = await mp.createSession({ threadId: "t1", id: "s1" });
    await mp.join(session.id, person("alice"));
    await mp.send({ sessionId: session.id, participantId: "alice", text: "hi" });

    const audit = await mp.store.listAudit(session.id);
    const joined = audit.find((e) => e.action === "participant.joined");
    expect(joined?.actorId).toBe("alice");
  });
});
