import { describe, expect, it, vi } from "vitest";

import { TurnController } from "../src/concurrency/index.js";
import { InMemoryTurnLease, type TurnLease } from "../src/concurrency/lease.js";
import type { InboundMessage } from "../src/types.js";

const msg = (participantId: string, text: string): InboundMessage => ({
  sessionId: "s1",
  participantId,
  text,
  receivedAt: Date.now(),
  addressedToAgent: true,
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("TurnController", () => {
  it("runs queued turns one at a time, in order", async () => {
    const order: string[] = [];
    const gate = deferred();
    let first = true;

    const controller = new TurnController(async (turn) => {
      const text = turn.messages[0]!.text;
      if (first) {
        first = false;
        await gate.promise;
      }
      order.push(text);
    });

    const a = controller.submit(msg("alice", "one"));
    const b = controller.submit(msg("bob", "two"));
    expect(controller.isRunning("s1")).toBe(true);

    gate.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["one", "two"]);
  });

  it("drops messages arriving mid-run in skip mode", async () => {
    const seen: string[] = [];
    const gate = deferred();
    let first = true;

    const controller = new TurnController(
      async (turn) => {
        seen.push(turn.messages[0]!.text);
        if (first) {
          first = false;
          await gate.promise;
        }
      },
      { mode: "skip" },
    );

    const running = controller.submit(msg("alice", "one"));
    await controller.submit(msg("bob", "two"));
    gate.resolve();
    await running;

    expect(seen).toEqual(["one"]);
  });

  it("collapses a burst into the last message in debounce mode", async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const controller = new TurnController(
      async (turn) => {
        seen.push(turn.messages[0]!.text);
      },
      { mode: "debounce", windowMs: 100 },
    );

    await controller.submit(msg("alice", "one"));
    await controller.submit(msg("bob", "two"));
    await controller.submit(msg("alice", "three"));

    await vi.advanceTimersByTimeAsync(150);
    vi.useRealTimers();

    expect(seen).toEqual(["three"]);
  });

  it("folds a burst into a single turn in batch mode", async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const controller = new TurnController(
      async (turn) => {
        batches.push(turn.messages.map((m) => m.text));
      },
      { mode: "batch", windowMs: 100 },
    );

    await controller.submit(msg("alice", "one"));
    await controller.submit(msg("bob", "two"));

    await vi.advanceTimersByTimeAsync(150);
    vi.useRealTimers();

    expect(batches).toEqual([["one", "two"]]);
  });

  it("aborts the in-flight run in preempt mode", async () => {
    const aborted: boolean[] = [];
    const gate = deferred();
    let first = true;

    const controller = new TurnController(
      async (turn) => {
        const signal = controller.signalFor(turn.sessionId);
        if (first) {
          first = false;
          await gate.promise;
          aborted.push(signal?.aborted ?? false);
        }
      },
      { mode: "preempt" },
    );

    const running = controller.submit(msg("alice", "one"));
    const second = controller.submit(msg("bob", "stop, do this instead"));
    gate.resolve();
    await Promise.all([running, second]);

    expect(aborted[0]).toBe(true);
  });

  it("clears the queue on interrupt", async () => {
    const gate = deferred();
    const controller = new TurnController(async () => {
      await gate.promise;
    });

    const running = controller.submit(msg("alice", "one"));
    void controller.submit(msg("bob", "two"));
    void controller.submit(msg("carol", "three"));
    expect(controller.queueDepth("s1")).toBe(2);

    controller.interrupt("s1");
    expect(controller.queueDepth("s1")).toBe(0);

    gate.resolve();
    await running;
  });

  describe("explicit host-driven turns", () => {
    it("runs the supplied batch immediately and returns the runner value", async () => {
      const controller = new TurnController(async (turn) =>
        turn.messages.map((message) => message.text).join(" | "),
      );

      const result = await controller.runExplicit({
        sessionId: "s1",
        messages: [msg("alice", "one"), msg("bob", "two")],
      });

      expect(result).toEqual({ status: "completed", value: "one | two" });
    });

    it("returns busy without consuming a competing batch", async () => {
      const gate = deferred();
      const controller = new TurnController(async (turn) => {
        await gate.promise;
        return turn.messages[0]!.text;
      });

      const first = controller.runExplicit({
        sessionId: "s1",
        messages: [msg("alice", "one")],
      });
      const second = await controller.runExplicit({
        sessionId: "s1",
        messages: [msg("bob", "two")],
      });

      expect(second).toEqual({ status: "busy" });
      gate.resolve();
      await expect(first).resolves.toEqual({ status: "completed", value: "one" });
    });

    it("uses the shared lease across controller instances", async () => {
      const gate = deferred();
      const lease = new InMemoryTurnLease();
      const first = new TurnController(async () => {
        await gate.promise;
        return "first";
      }, { lease });
      const second = new TurnController(async () => "second", { lease });

      const running = first.runExplicit({
        sessionId: "s1",
        messages: [msg("alice", "one")],
      });
      await Promise.resolve();

      await expect(
        second.runExplicit({ sessionId: "s1", messages: [msg("bob", "two")] }),
      ).resolves.toEqual({ status: "busy" });

      gate.resolve();
      await running;
      await expect(
        second.runExplicit({ sessionId: "s1", messages: [msg("bob", "two")] }),
      ).resolves.toEqual({ status: "completed", value: "second" });
    });

    it("distinguishes an unavailable lease backend from a held lease", async () => {
      const unavailable: TurnLease = {
        acquire: async () => { throw new Error("lease offline"); },
        renew: async () => false,
        release: async () => {},
      };
      const controller = new TurnController(async () => "unused", {
        lease: unavailable,
      });

      const result = await controller.runExplicit({
        sessionId: "s1",
        messages: [msg("alice", "one")],
      });

      expect(result.status).toBe("unavailable");
      if (result.status === "unavailable") {
        expect(result.error).toEqual(new Error("lease offline"));
      }
    });
  });
});
