import { describe, expect, it } from "vitest";

import { createMultiplayer } from "../src/session.js";
import type { AgentLike } from "../src/session.js";
import type { MultiplayerEvent } from "../src/bus/events.js";
import type { TurnLease } from "../src/concurrency/lease.js";
import { silentLogger } from "../src/internal/logger.js";
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

  it("accepts structured media without legacy text", async () => {
    const agent = fakeAgent();
    const mp = createMultiplayer({ agent });
    const session = await mp.createSession({ threadId: "t1", id: "s1" });
    await mp.join(session.id, person("alice"));

    await mp.send({
      sessionId: session.id,
      participantId: "alice",
      content: [{ type: "media", mediaType: "image", alt: "A birthday cake" }],
    });

    expect(agent.prompts[0]).toBe("[alice]: [image attachment: A birthday cake]");
  });

  it("replays buffered events for a late joiner", async () => {
    const mp = createMultiplayer({ agent: fakeAgent() });
    const session = await mp.createSession({ threadId: "t1", id: "s1" });
    await mp.join(session.id, person("alice"));
    await mp.send({ sessionId: session.id, participantId: "alice", text: "hi" });

    const replayed = await mp.bus.replay(session.id, 0);
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

  describe("host-driven batches", () => {
    it("runs an attributed batch and returns the completed response", async () => {
      const agent = fakeAgent("a grounded reply");
      const mp = createMultiplayer({ agent });
      await mp.createSession({ threadId: "t1", id: "s1" });
      await mp.join("s1", person("alice"));
      await mp.join("s1", person("bob"));

      const result = await mp.runBatch({
        sessionId: "s1",
        messages: [
          { participantId: "alice", text: "the table was blue", receivedAt: 1 },
          { participantId: "bob", text: "it was green", receivedAt: 2 },
        ],
      });

      expect(result).toMatchObject({ status: "completed", text: "a grounded reply " });
      expect(agent.prompts[0]).toBe("[alice]: the table was blue\n[bob]: it was green");
    });

    it("carries structured content and typed provider correlation into context", async () => {
      let contextMessages: Parameters<NonNullable<Parameters<typeof createMultiplayer>[0]["buildStreamOptions"]>>[0]["messages"] = [];
      const mp = createMultiplayer({
        agent: fakeAgent(),
        buildStreamOptions: (context) => {
          contextMessages = context.messages;
          return {};
        },
        logger: silentLogger,
      });
      await mp.createSession({ threadId: "t1", id: "s1" });
      await mp.join("s1", person("alice"));

      await mp.runBatch({
        sessionId: "s1",
        messages: [{
          participantId: "alice",
          content: [{ type: "media", mediaType: "image", name: "cake.jpg" }],
          correlation: {
            providerEventId: "event-1",
            providerMessageId: "message-1",
            providerThreadId: "group-1",
          },
          receivedAt: 1,
        }],
      });

      expect(contextMessages[0]).toMatchObject({
        text: "[image attachment: cake.jpg]",
        correlation: { providerEventId: "event-1", providerThreadId: "group-1" },
      });
    });

    it("returns a typed failure and closes the run lifecycle", async () => {
      const mp = createMultiplayer({
        agent: {
          id: "support",
          async stream() { throw new Error("model unavailable"); },
        },
        logger: silentLogger,
      });
      await mp.createSession({ threadId: "t1", id: "s1" });
      await mp.join("s1", person("alice"));
      const events: MultiplayerEvent[] = [];
      mp.bus.subscribe("s1", (event) => events.push(event));

      const result = await mp.runBatch({
        sessionId: "s1",
        messages: [{ participantId: "alice", text: "hello", receivedAt: 1 }],
      });

      expect(result).toMatchObject({
        status: "failed",
        error: { code: "agent_error", message: "model unavailable" },
      });
      expect(events.some((event) => event.type === "agent.run.failed")).toBe(true);
      expect(mp.turns.isRunning("s1")).toBe(false);
    });

    it("returns interrupted and does not publish a partial assistant message", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const mp = createMultiplayer({
        agent: {
          id: "support",
          async stream() {
            return {
              textStream: (async function* () {
                yield "partial ";
                await gate;
                yield "should-not-publish";
              })(),
            };
          },
        },
      });
      await mp.createSession({ threadId: "t1", id: "s1" });
      await mp.join("s1", person("alice"));
      const events: MultiplayerEvent[] = [];
      mp.bus.subscribe("s1", (event) => events.push(event));

      const running = mp.runBatch({
        sessionId: "s1",
        messages: [{ participantId: "alice", text: "start", receivedAt: 1 }],
      });
      while (!mp.turns.isRunning("s1")) await Promise.resolve();
      await mp.interrupt("s1", "alice");
      release();

      await expect(running).resolves.toMatchObject({ status: "interrupted" });
      expect(events.some((event) => event.type === "message" && event.fromAgent)).toBe(false);
    });

    it("reports an interrupted result when the distributed lease is lost", async () => {
      let renewals = 0;
      const lease: TurnLease = {
        acquire: async () => true,
        renew: async () => {
          renewals++;
          return false;
        },
        release: async () => {},
      };
      const mp = createMultiplayer({
        agent: {
          id: "support",
          async stream() {
            return {
              textStream: (async function* () {
                for (let i = 0; i < 10; i++) {
                  await new Promise((resolve) => setTimeout(resolve, 5));
                  yield "chunk ";
                }
              })(),
            };
          },
        },
        concurrency: { lease, leaseTtlMs: 30, leaseRenewMs: 1 },
        logger: silentLogger,
      });
      await mp.createSession({ threadId: "t1", id: "s1" });
      await mp.join("s1", person("alice"));

      const result = await mp.runBatch({
        sessionId: "s1",
        messages: [{ participantId: "alice", text: "start", receivedAt: 1 }],
      });

      expect(renewals).toBeGreaterThan(0);
      expect(result.status).toBe("interrupted");
    });
  });
});
