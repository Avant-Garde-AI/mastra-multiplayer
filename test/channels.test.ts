import { describe, expect, it, vi } from "vitest";

import {
  ChannelBridge,
  channelBridge,
  channelParticipant,
  isBotActor,
  type ChannelMessage,
} from "../src/channels/index.js";
import { silentLogger, type Logger } from "../src/internal/logger.js";
import { createMultiplayer, type AgentLike } from "../src/session.js";
import type { MultiplayerEvent } from "../src/bus/events.js";

const fakeAgent = (): AgentLike => ({
  id: "support",
  async stream() {
    return { textStream: (async function* () { yield "ack"; })() };
  },
});

const slackMessage = (over: Partial<ChannelMessage> = {}): ChannelMessage => ({
  surface: "slack",
  actor: { userId: "U06CK1E9HN2", fullName: "Alice Chen", isBot: false },
  threadId: "1699999999.000100",
  channelId: "C012AB3CD",
  text: "can we refund 4417?",
  ...over,
});

async function setup(
  options: Partial<ConstructorParameters<typeof ChannelBridge>[1]> = {},
) {
  const multiplayer = createMultiplayer({ agent: fakeAgent(), logger: silentLogger });
  await multiplayer.createSession({ threadId: "t1", id: "s1" });

  const bridge = channelBridge(multiplayer, {
    resolveSession: () => "s1",
    logger: silentLogger,
    ...options,
  });
  return { multiplayer, bridge };
}

describe("channelParticipant", () => {
  it("maps a Mastra actor onto a participant", () => {
    expect(
      channelParticipant({
        surface: "slack",
        actor: { userId: "U06CK1E9HN2", fullName: "Alice Chen" },
      }),
    ).toEqual({
      id: "slack:U06CK1E9HN2",
      displayName: "Alice Chen",
      role: "editor",
      surface: "slack",
      resourceId: "slack:U06CK1E9HN2",
    });
  });

  it("prefers fullName, then userName, then the raw id", () => {
    const name = (actor: Parameters<typeof channelParticipant>[0]["actor"]) =>
      channelParticipant({ surface: "slack", actor }).displayName;

    expect(name({ userId: "U1", fullName: "Alice Chen", userName: "alice" })).toBe("Alice Chen");
    expect(name({ userId: "U1", userName: "alice" })).toBe("alice");
    // Ugly and honest. A placeholder would put one label on two people.
    expect(name({ userId: "U1" })).toBe("U1");
  });

  it("keeps the same user id on two surfaces apart", () => {
    // The reason ids are prefixed. An unprefixed collision merges two people
    // into one participant, which under `excludeRequester` turns four-eyes into
    // two without anything looking wrong.
    const slack = channelParticipant({ surface: "slack", actor: { userId: "U1" } });
    const discord = channelParticipant({ surface: "discord", actor: { userId: "U1" } });

    expect(slack.id).not.toBe(discord.id);
    expect(slack.resourceId).toBe("slack:U1");
    expect(discord.resourceId).toBe("discord:U1");
  });

  it("carries the role through", () => {
    expect(
      channelParticipant({ surface: "teams", actor: { userId: "U1" }, role: "approver" }).role,
    ).toBe("approver");
  });

  it("works for an adapter this package has never heard of", () => {
    // Mastra keys adapters by arbitrary name and third-party adapters are
    // ordinary packages, so a closed union would make this the bottleneck on
    // somebody else's integration.
    const p = channelParticipant({ surface: "matrix", actor: { userId: "@a:example.org" } });
    expect(p.id).toBe("matrix:@a:example.org");
    expect(p.surface).toBe("matrix");
  });
});

describe("isBotActor", () => {
  it("treats an undetermined actor as a bot", () => {
    expect(isBotActor({ userId: "U1", isBot: true })).toBe(true);
    expect(isBotActor({ userId: "U1", isBot: "unknown" })).toBe(true);
    expect(isBotActor({ userId: "U1", isBot: false })).toBe(false);
    expect(isBotActor({ userId: "U1" })).toBe(false);
  });
});

describe("ChannelBridge", () => {
  it("joins the sender and forwards the message", async () => {
    const { multiplayer, bridge } = await setup();

    const seen: MultiplayerEvent[] = [];
    multiplayer.bus.subscribe("s1", (event) => seen.push(event));

    const result = await bridge.receive(slackMessage());

    expect(result.status).toBe("delivered");
    expect(result.sessionId).toBe("s1");
    expect((await multiplayer.store.listParticipants("s1")).map((p) => p.id)).toEqual([
      "slack:U06CK1E9HN2",
    ]);
    expect(
      seen.filter((e): e is Extract<MultiplayerEvent, { type: "message" }> =>
        e.type === "message",
      )[0],
    ).toMatchObject({ participantId: "slack:U06CK1E9HN2", text: "can we refund 4417?" });
  });

  it("joins once across many messages", async () => {
    // `addParticipant` is an upsert, so joining every time is safe — but it
    // publishes `participant.joined` every time, and a chatty channel would
    // fill the stream with one person repeatedly arriving.
    const { multiplayer, bridge } = await setup();

    const joins: string[] = [];
    multiplayer.bus.subscribe("s1", (event) => {
      if (event.type === "participant.joined") joins.push(event.participant.id);
    });

    for (let i = 0; i < 5; i++) {
      await bridge.receive(slackMessage({ text: `message ${i}`, addressedToAgent: false }));
    }

    expect(joins).toEqual(["slack:U06CK1E9HN2"]);
    expect(await multiplayer.store.listParticipants("s1")).toHaveLength(1);
  });

  it("re-joins when the display name changes, without duplicating", async () => {
    const { multiplayer, bridge } = await setup();

    await bridge.receive(slackMessage({ addressedToAgent: false }));
    await bridge.receive(
      slackMessage({
        actor: { userId: "U06CK1E9HN2", fullName: "Alice Chen-Okafor" },
        addressedToAgent: false,
      }),
    );

    const roster = await multiplayer.store.listParticipants("s1");
    expect(roster).toHaveLength(1);
    expect(roster[0]?.displayName).toBe("Alice Chen-Okafor");
  });

  it("re-joins when the role changes", async () => {
    let role: "editor" | "owner" = "editor";
    const { multiplayer, bridge } = await setup({ role: () => role });

    await bridge.receive(slackMessage({ addressedToAgent: false }));
    role = "owner";
    await bridge.receive(slackMessage({ addressedToAgent: false }));

    const roster = await multiplayer.store.listParticipants("s1");
    expect(roster).toHaveLength(1);
    expect(roster[0]?.role).toBe("owner");
  });

  describe("bots", () => {
    it("ignores a bot by default", async () => {
      const { multiplayer, bridge } = await setup();
      const result = await bridge.receive(
        slackMessage({ actor: { userId: "B1", fullName: "Deploy Bot", isBot: true } }),
      );

      expect(result.status).toBe("ignored_bot");
      expect(await multiplayer.store.listParticipants("s1")).toEqual([]);
    });

    it("ignores an actor whose bot status is unknown, and says so", async () => {
      // Errs toward excluding a real human — a visible failure — over letting an
      // automation count toward a quorum, which is a silent governance one.
      const warnings: string[] = [];
      const logger: Logger = { ...silentLogger, warn: (m) => warnings.push(m) };
      const { bridge } = await setup({ logger });

      const result = await bridge.receive(
        slackMessage({ actor: { userId: "U9", isBot: "unknown" } }),
      );

      expect(result.status).toBe("ignored_bot");
      expect(warnings.some((w) => w.includes("bot actor"))).toBe(true);
    });

    it("lets bots in when asked", async () => {
      const { multiplayer, bridge } = await setup({ allowBots: true });
      const result = await bridge.receive(
        slackMessage({
          actor: { userId: "B1", fullName: "Deploy Bot", isBot: true },
          addressedToAgent: false,
        }),
      );

      expect(result.status).toBe("delivered");
      expect(await multiplayer.store.listParticipants("s1")).toHaveLength(1);
    });
  });

  describe("session resolution", () => {
    it("ignores a message with no session", async () => {
      const { multiplayer, bridge } = await setup({ resolveSession: () => null });
      const result = await bridge.receive(slackMessage());

      expect(result.status).toBe("ignored_no_session");
      expect(await multiplayer.store.listParticipants("s1")).toEqual([]);
    });

    it("passes the whole message to the resolver", async () => {
      const seen: ChannelMessage[] = [];
      const { bridge } = await setup({
        resolveSession: (m) => {
          seen.push(m);
          return "s1";
        },
      });

      await bridge.receive(slackMessage({ addressedToAgent: false }));

      expect(seen[0]).toMatchObject({
        surface: "slack",
        threadId: "1699999999.000100",
        channelId: "C012AB3CD",
      });
    });

    it("awaits an async resolver", async () => {
      const { bridge } = await setup({
        resolveSession: async () => {
          await new Promise((r) => setTimeout(r, 5));
          return "s1";
        },
      });

      expect((await bridge.receive(slackMessage({ addressedToAgent: false }))).status).toBe(
        "delivered",
      );
    });

    it("routes two channel threads to two sessions", async () => {
      const multiplayer = createMultiplayer({ agent: fakeAgent(), logger: silentLogger });
      await multiplayer.createSession({ threadId: "t1", id: "s1" });
      await multiplayer.createSession({ threadId: "t2", id: "s2" });

      const bridge = channelBridge(multiplayer, {
        logger: silentLogger,
        resolveSession: ({ threadId }) => (threadId === "thread-a" ? "s1" : "s2"),
      });

      await bridge.receive(slackMessage({ threadId: "thread-a", addressedToAgent: false }));
      await bridge.receive(
        slackMessage({
          threadId: "thread-b",
          actor: { userId: "U2", fullName: "Bob" },
          addressedToAgent: false,
        }),
      );

      expect((await multiplayer.store.listParticipants("s1")).map((p) => p.id)).toEqual([
        "slack:U06CK1E9HN2",
      ]);
      expect((await multiplayer.store.listParticipants("s2")).map((p) => p.id)).toEqual([
        "slack:U2",
      ]);
    });
  });

  it("ignores an empty message rather than joining for nothing", async () => {
    const { multiplayer, bridge } = await setup();
    const result = await bridge.receive(slackMessage({ text: "   " }));

    expect(result.status).toBe("ignored_empty");
    expect(await multiplayer.store.listParticipants("s1")).toEqual([]);
  });

  it("honours addressedToAgent", async () => {
    const { multiplayer, bridge } = await setup();
    const runs: string[] = [];
    multiplayer.bus.subscribe("s1", (event) => {
      if (event.type === "agent.run.started") runs.push(event.runId);
    });

    await bridge.receive(slackMessage({ addressedToAgent: false }));
    await new Promise((r) => setTimeout(r, 20));
    expect(runs).toHaveLength(0);

    await bridge.receive(slackMessage({ text: "hey agent", addressedToAgent: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(runs).toHaveLength(1);
  });

  it("forwards metadata", async () => {
    const { multiplayer, bridge } = await setup();
    const audit = vi.spyOn(multiplayer, "send");

    await bridge.receive(
      slackMessage({ metadata: { ts: "1699999999.000100" }, addressedToAgent: false }),
    );

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { ts: "1699999999.000100" } }),
    );
  });

  it("lets a host replace the mapping entirely", async () => {
    const { multiplayer, bridge } = await setup({
      participant: ({ actor }) => ({
        id: `corp:${actor.userId}`,
        displayName: "Directory Name",
        role: "approver",
        surface: "slack",
        email: "alice@example.com",
      }),
    });

    await bridge.receive(slackMessage({ addressedToAgent: false }));

    expect(await multiplayer.store.listParticipants("s1")).toEqual([
      expect.objectContaining({ id: "corp:U06CK1E9HN2", role: "approver" }),
    ]);
  });

  it("gives a channel participant a working vote on an approval", async () => {
    // The point of the whole exercise: someone who arrived over Slack is a
    // first-class participant, including for governance.
    const { multiplayer, bridge } = await setup({
      role: ({ actor }) => (actor.userId === "U_APPROVER" ? "approver" : "editor"),
    });

    await bridge.receive(slackMessage({ addressedToAgent: false }));
    await bridge.receive(
      slackMessage({
        actor: { userId: "U_APPROVER", fullName: "Bob Approver" },
        addressedToAgent: false,
      }),
    );

    const request = await multiplayer.approvals.request({
      sessionId: "s1",
      requestedBy: "slack:U06CK1E9HN2",
      toolName: "refund-order",
      toolArgs: { orderId: "4417" },
      summary: "Refund order 4417",
    });

    const resolved = await multiplayer.approvals.vote(
      request.id,
      "slack:U_APPROVER",
      "approve",
    );
    expect(resolved.status).toBe("approved");
  });
});
