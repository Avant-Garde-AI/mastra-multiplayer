import { describe, expect, it } from "vitest";

import { createMultiplayer, type AgentLike } from "../src/session.js";
import { multiplayerRoutes } from "../src/server/index.js";
import { silentLogger, type Logger } from "../src/internal/logger.js";
import type { Participant } from "../src/types.js";
import { fakeContext, route } from "./helpers/hono.js";

const fakeAgent = (): AgentLike => ({
  id: "support",
  async stream() {
    return { textStream: (async function* () { yield "ack"; })() };
  },
});

const alice: Participant = {
  id: "alice",
  displayName: "Alice",
  role: "owner",
  surface: "web",
};

/**
 * Opens a stream but never reads it — a suspended laptop, a stalled proxy, a
 * client that hung up without closing the socket. `controller.enqueue` never
 * blocks, so nothing about this is visible to the server except `desiredSize`.
 */
async function openUnreadStream(
  options: { highWaterMark?: number; logger?: Logger } = {},
) {
  const multiplayer = createMultiplayer({ agent: fakeAgent(), logger: silentLogger });
  await multiplayer.createSession({ threadId: "t1", id: "s1" });
  await multiplayer.join("s1", alice);

  const routes = multiplayerRoutes(multiplayer, {
    authenticate: () => alice,
    logger: options.logger ?? silentLogger,
    ...(options.highWaterMark === undefined
      ? {}
      : { streamHighWaterMark: options.highWaterMark }),
  });

  const { c, captured } = fakeContext({ params: { sessionId: "s1" } });
  await route(routes, "GET", "/stream").handler(c);
  return { multiplayer, stream: captured().stream! };
}

const message = (text: string) =>
  ({
    type: "message",
    sessionId: "s1",
    participantId: "alice",
    text,
    fromAgent: false,
  }) as const;

const delta = (text: string) =>
  ({ type: "agent.delta", sessionId: "s1", runId: "r1", delta: text }) as const;

describe("SSE backpressure", () => {
  it("drops deltas rather than growing the queue without bound", async () => {
    // The terminal `message` carries the assembled text, so a client that
    // misses deltas still gets the whole reply — just not the typing effect.
    const { multiplayer, stream } = await openUnreadStream({ highWaterMark: 8 });

    for (let i = 0; i < 500; i++) await multiplayer.bus.publish(delta(`t${i} `));

    // Nothing is reading, so the queue can only hold the high-water mark.
    const reader = stream.getReader();
    let frames = 0;
    while (frames < 500) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) =>
          setTimeout(() => r({ value: undefined, done: true }), 50),
        ),
      ]);
      if (done || !value) break;
      frames++;
    }
    await reader.cancel().catch(() => {});

    expect(frames).toBeLessThan(500);
    expect(frames).toBeGreaterThan(0);
  });

  it("closes the stream rather than dropping an event a client cannot rebuild", async () => {
    // A message, a roster change, an approval — none can be reconstructed from
    // later events, so the stream ends and the client reconnects and replays.
    const warnings: string[] = [];
    const logger: Logger = {
      ...silentLogger,
      warn: (m) => warnings.push(m),
    };
    const { multiplayer, stream } = await openUnreadStream({
      highWaterMark: 4,
      logger,
    });

    for (let i = 0; i < 50; i++) await multiplayer.bus.publish(message(`m${i}`));

    const reader = stream.getReader();
    let closed = false;
    for (let i = 0; i < 100; i++) {
      const { done } = await Promise.race([
        reader.read(),
        new Promise<{ done: true }>((r) => setTimeout(() => r({ done: true }), 50)),
      ]);
      if (done) {
        closed = true;
        break;
      }
    }

    expect(closed).toBe(true);
    expect(warnings.some((w) => w.includes("backed-up"))).toBe(true);
  });

  it("unsubscribes when it closes a backed-up stream", async () => {
    // A closed stream that stays subscribed is the leak this fixes, moved.
    const { multiplayer, stream } = await openUnreadStream({ highWaterMark: 4 });
    expect(multiplayer.bus.subscriberCount("s1")).toBe(1);

    for (let i = 0; i < 50; i++) await multiplayer.bus.publish(message(`m${i}`));

    expect(multiplayer.bus.subscriberCount("s1")).toBe(0);
    await stream.cancel().catch(() => {});
  });

  it("leaves a client that keeps up entirely alone", async () => {
    const { multiplayer, stream } = await openUnreadStream({ highWaterMark: 8 });
    const reader = stream.getReader();

    const decoder = new TextDecoder();
    const read = async () =>
      JSON.parse(decoder.decode((await reader.read()).value).split("data: ")[1]!.trim());

    // Joining published its own events; drain them so the queue starts empty.
    await read(); // participant.joined
    await read(); // presence.updated

    // One in, one out — the definition of keeping up.
    const texts: string[] = [];
    for (let i = 0; i < 20; i++) {
      await multiplayer.bus.publish(message(`m${i}`));
      texts.push((await read()).text);
    }
    await reader.cancel().catch(() => {});

    // Read as fast as they arrive: nothing dropped, nothing closed.
    expect(texts).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`));
  });

  it("defaults to a high-water mark that does not trip on normal use", async () => {
    // Without an explicit queuing strategy the mark is 1, and every stream
    // would look backed up after a single unread frame.
    const { multiplayer, stream } = await openUnreadStream();

    for (let i = 0; i < 100; i++) await multiplayer.bus.publish(message(`m${i}`));

    expect(multiplayer.bus.subscriberCount("s1")).toBe(1);
    await stream.cancel().catch(() => {});
  });
});
