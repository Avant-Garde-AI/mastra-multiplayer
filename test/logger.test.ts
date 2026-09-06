import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../src/bus/event-bus.js";
import { consoleLogger, safeLogger, silentLogger, type Logger } from "../src/internal/logger.js";
import { createMultiplayer, type AgentLike } from "../src/session.js";

const collect = () => {
  const lines: Array<{ level: string; message: string; context?: unknown }> = [];
  const logger: Logger = {
    debug: (message, context) => lines.push({ level: "debug", message, context }),
    info: (message, context) => lines.push({ level: "info", message, context }),
    warn: (message, context) => lines.push({ level: "warn", message, context }),
    error: (message, context) => lines.push({ level: "error", message, context }),
  };
  return { logger, lines };
};

const fakeAgent = (): AgentLike => ({
  id: "support",
  async stream() {
    return { textStream: (async function* () { yield "ack"; })() };
  },
});

describe("logger", () => {
  it("routes a failure to the configured logger instead of the console", async () => {
    const { logger, lines } = collect();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const bus = new EventBus({ logger });
    bus.subscribe("s1", () => {
      throw new Error("bad subscriber");
    });
    await bus.publish({
      type: "message",
      sessionId: "s1",
      participantId: "alice",
      text: "hi",
      fromAgent: false,
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "error", message: "subscriber threw" });
    expect((lines[0]!.context as { sessionId: string }).sessionId).toBe("s1");
    // The point of the seam: nothing reaches the console any more.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("silences output entirely when asked", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = new EventBus({ logger: silentLogger });
    bus.subscribe("s1", () => {
      throw new Error("bad subscriber");
    });
    await bus.publish({
      type: "message",
      sessionId: "s1",
      participantId: "alice",
      text: "hi",
      fromAgent: false,
    });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("defaults to the console when no logger is given", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = new EventBus();
    bus.subscribe("s1", () => {
      throw new Error("bad subscriber");
    });
    await bus.publish({
      type: "message",
      sessionId: "s1",
      participantId: "alice",
      text: "hi",
      fromAgent: false,
    });

    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("configured once on the session, reaches the pieces it builds", async () => {
    const { logger, lines } = collect();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const multiplayer = createMultiplayer({ agent: fakeAgent(), logger });
    const session = await multiplayer.createSession({ threadId: "t1" });
    multiplayer.bus.subscribe(session.id, () => {
      throw new Error("bad subscriber");
    });
    await multiplayer.join(session.id, {
      id: "alice",
      displayName: "Alice",
      role: "owner",
      surface: "web",
    });

    expect(lines.some((l) => l.message === "subscriber threw")).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not let a throwing logger break the caller", async () => {
    // A logger is host-supplied and may do anything. Publishing an event must
    // not fail because shipping a log line did.
    const exploding: Logger = {
      debug: () => { throw new Error("logger down"); },
      info: () => { throw new Error("logger down"); },
      warn: () => { throw new Error("logger down"); },
      error: () => { throw new Error("logger down"); },
    };

    const bus = new EventBus({ logger: exploding });
    bus.subscribe("s1", () => {
      throw new Error("bad subscriber");
    });

    await expect(
      bus.publish({
        type: "message",
        sessionId: "s1",
        participantId: "alice",
        text: "hi",
        fromAgent: false,
      }),
    ).resolves.toBeTruthy();
  });

  it("safeLogger passes through when the logger behaves", () => {
    const { logger, lines } = collect();
    safeLogger(logger).warn("careful", { n: 1 });

    expect(lines).toEqual([{ level: "warn", message: "careful", context: { n: 1 } }]);
  });

  it("consoleLogger prefixes the package name", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleLogger.warn("something", { a: 1 });

    expect(spy).toHaveBeenCalledWith("[mastra-multiplayer] something", { a: 1 });
    spy.mockRestore();
  });
});
