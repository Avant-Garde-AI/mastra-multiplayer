import { describe, expect, it } from "vitest";

import { createMultiplayer, type AgentLike } from "../src/session.js";
import {
  multiplayerRoutes,
  type MultiplayerAction,
  type MultiplayerRoutesOptions,
} from "../src/server/index.js";
import { fourEyes } from "../src/approvals/index.js";
import type { Participant } from "../src/types.js";
import { fakeContext, parseFrame, readFrames, route } from "./helpers/hono.js";

const fakeAgent = (): AgentLike => ({
  id: "support",
  instructions: "You are a support agent.",
  async stream() {
    return {
      textStream: (async function* () {
        yield "ack";
      })(),
    };
  },
});

const person = (id: string, role: Participant["role"] = "editor"): Participant => ({
  id,
  displayName: id,
  role,
  surface: "web",
});

/**
 * A session the caller is already a member of — the normal state for every
 * route but `/join`. Pass `{ join: false }` to test the non-member path.
 */
async function setup(
  caller: Participant | null = person("alice"),
  options: { join?: boolean; authorize?: MultiplayerRoutesOptions["authorize"] } = {},
) {
  const multiplayer = createMultiplayer({ agent: fakeAgent() });
  const session = await multiplayer.createSession({ threadId: "t1", id: "s1" });
  if (caller && options.join !== false) await multiplayer.join("s1", caller);

  const routes = multiplayerRoutes(multiplayer, {
    authenticate: () => caller,
    ...(options.authorize ? { authorize: options.authorize } : {}),
  });
  return { multiplayer, session, routes };
}

/** Runs one route and returns whatever it wrote to the context. */
async function call(
  routes: ReturnType<typeof multiplayerRoutes>,
  method: "GET" | "POST",
  suffix: string,
  request: Parameters<typeof fakeContext>[0] = {},
) {
  const { c, captured } = fakeContext({ params: { sessionId: "s1" }, ...request });
  await route(routes, method, suffix).handler(c);
  return captured();
}

describe("multiplayerRoutes", () => {
  it("exposes every documented route under the base path", async () => {
    const { routes } = await setup();
    const surface = routes.map((r) => `${r.method} ${r.path}`).sort();

    expect(surface).toEqual([
      "GET /multiplayer/sessions/:sessionId/approvals",
      "GET /multiplayer/sessions/:sessionId/audit",
      "GET /multiplayer/sessions/:sessionId/state",
      "GET /multiplayer/sessions/:sessionId/stream",
      "POST /multiplayer/approvals/:approvalId/vote",
      "POST /multiplayer/sessions/:sessionId/interrupt",
      "POST /multiplayer/sessions/:sessionId/join",
      "POST /multiplayer/sessions/:sessionId/leave",
      "POST /multiplayer/sessions/:sessionId/messages",
      "POST /multiplayer/sessions/:sessionId/presence",
    ]);
  });

  it("honours a custom base path", async () => {
    const multiplayer = createMultiplayer({ agent: fakeAgent() });
    const routes = multiplayerRoutes(multiplayer, {
      authenticate: () => person("alice"),
      basePath: "/collab",
    });

    expect(routes.every((r) => r.path.startsWith("/collab/"))).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /* Authentication                                                      */
  /* ------------------------------------------------------------------ */

  describe("authentication", () => {
    it("rejects every route with 401 when authenticate returns null", async () => {
      const { routes } = await setup(null);

      for (const definition of routes) {
        const { c, captured } = fakeContext({
          params: { sessionId: "s1", approvalId: "a1" },
          body: { text: "hi", decision: "approve" },
        });
        await definition.handler(c);

        expect(
          captured(),
          `${definition.method} ${definition.path} should be unauthorized`,
        ).toMatchObject({ status: 401, json: { error: "Unauthorized" } });
      }
    });

    it("awaits an async authenticate", async () => {
      const multiplayer = createMultiplayer({ agent: fakeAgent() });
      await multiplayer.createSession({ threadId: "t1", id: "s1" });
      const routes = multiplayerRoutes(multiplayer, {
        authenticate: async () => person("alice"),
      });

      const response = await call(routes, "POST", "/join");
      expect(response.status).toBe(200);
    });

    it("401s before authorization runs, so identity failure is distinguishable", async () => {
      const { routes } = await setup(null);
      const response = await call(routes, "GET", "/state");

      expect(response.status).toBe(401);
    });

    it("attributes the message to the authenticated identity, not the body", async () => {
      const { multiplayer, routes } = await setup(person("alice"));
      await call(routes, "POST", "/join");

      const seen: Array<string | null> = [];
      multiplayer.bus.subscribe("s1", (event) => {
        if (event.type === "message") seen.push(event.participantId);
      });

      // A client claiming to be someone else must not be believed.
      await call(routes, "POST", "/messages", {
        body: { text: "refund it", participantId: "mallory", addressedToAgent: false },
      });

      expect(seen).toEqual(["alice"]);
    });
  });

  /* ------------------------------------------------------------------ */
  /* Authorization                                                       */
  /* ------------------------------------------------------------------ */

  describe("authorization", () => {
    /** Every route except /join, which cannot require prior membership. */
    const memberOnly = [
      ["GET", "/state"],
      ["GET", "/stream"],
      ["GET", "/approvals"],
      ["GET", "/audit"],
      ["POST", "/leave"],
      ["POST", "/presence"],
      ["POST", "/messages"],
      ["POST", "/interrupt"],
    ] as const;

    it.each(memberOnly)(
      "403s %s %s for an authenticated non-member",
      async (method, suffix) => {
        // The gap R5 closes: identity alone used to be enough to read any
        // session you could name.
        const { routes } = await setup(person("mallory"), { join: false });
        const response = await call(routes, method, suffix, {
          body: { text: "hi" },
        });

        expect(response.status).toBe(403);
        expect(response.json).toMatchObject({ code: "not_a_member" });
      },
    );

    it.each(memberOnly)("allows %s %s for a member", async (method, suffix) => {
      const { routes } = await setup(person("alice"));
      const response = await call(routes, method, suffix, { body: { text: "hi" } });

      expect(response.status).toBe(200);
    });

    it("lets a non-member join, since they cannot already be on the roster", async () => {
      const { routes } = await setup(person("newcomer"), { join: false });
      const response = await call(routes, "POST", "/join");

      expect(response.status).toBe(200);
      expect((response.json as any).participants.map((p: Participant) => p.id)).toEqual([
        "newcomer",
      ]);
    });

    it("403s a member of a different session", async () => {
      // Two sessions, one roster each — the cross-tenant read.
      const multiplayer = createMultiplayer({ agent: fakeAgent() });
      await multiplayer.createSession({ threadId: "t1", id: "s1" });
      await multiplayer.createSession({ threadId: "t2", id: "s2" });
      await multiplayer.join("s2", person("mallory"));

      const routes = multiplayerRoutes(multiplayer, {
        authenticate: () => person("mallory"),
      });

      // Belongs to s2, asks for s1.
      const response = await call(routes, "GET", "/audit", { params: { sessionId: "s1" } });
      expect(response.status).toBe(403);
    });

    it("stops streaming a session the caller is not in", async () => {
      const { routes } = await setup(person("mallory"), { join: false });
      const response = await call(routes, "GET", "/stream");

      expect(response.status).toBe(403);
      expect(response.stream).toBeUndefined();
    });

    it("403s a vote on an approval in a session the caller is not in", async () => {
      const multiplayer = createMultiplayer({ agent: fakeAgent() });
      await multiplayer.createSession({ threadId: "t1", id: "s1" });
      await multiplayer.join("s1", person("alice"));
      const request = await multiplayer.approvals.request({
        sessionId: "s1",
        requestedBy: "alice",
        toolName: "refund",
        toolArgs: {},
        summary: "Refund",
        policy: fourEyes(),
      });

      // Mallory is a legitimate member of a different session.
      await multiplayer.createSession({ threadId: "t2", id: "s2" });
      await multiplayer.join("s2", person("mallory"));

      const routes = multiplayerRoutes(multiplayer, {
        authenticate: () => person("mallory"),
      });
      const response = await call(routes, "POST", "/vote", {
        // A sessionId she *is* in, smuggled onto a vote for an approval she is
        // not. Authorization must read the session off the approval, never off
        // the request.
        params: { approvalId: request.id, sessionId: "s2" },
        body: { decision: "approve" },
      });

      expect(response.status).toBe(403);
      expect(response.json).toMatchObject({ code: "not_a_member" });
    });

    it("401 takes precedence over 403 — identity is checked first", async () => {
      const { routes } = await setup(null, { join: false });
      const response = await call(routes, "GET", "/audit");

      expect(response.status).toBe(401);
    });

    describe("a custom authorize hook", () => {
      it("receives the identity, session, and route being accessed", async () => {
        const seen: Array<{ id: string; sessionId: string; action: string }> = [];
        const { routes } = await setup(person("alice"), {
          authorize: ({ participant, sessionId, action }) => {
            seen.push({ id: participant.id, sessionId, action });
            return true;
          },
        });

        await call(routes, "GET", "/audit");
        expect(seen).toEqual([{ id: "alice", sessionId: "s1", action: "audit" }]);
      });

      it("can gate a single route while leaving the rest open", async () => {
        const { routes } = await setup(person("alice"), {
          authorize: ({ action }) => action !== "audit",
        });

        expect((await call(routes, "GET", "/audit")).status).toBe(403);
        expect((await call(routes, "GET", "/state")).status).toBe(200);
      });

      it("can reject a join, which the default rule always allows", async () => {
        const { routes } = await setup(person("uninvited"), {
          join: false,
          authorize: ({ action }) => action !== "join",
        });

        expect((await call(routes, "POST", "/join")).status).toBe(403);
      });

      it("replaces the membership rule rather than layering on it", async () => {
        // A non-member is allowed through, because the host said so.
        const { routes } = await setup(person("auditor"), {
          join: false,
          authorize: () => true,
        });

        expect((await call(routes, "GET", "/audit")).status).toBe(200);
      });

      it("is awaited", async () => {
        const { routes } = await setup(person("alice"), {
          authorize: async () => false,
        });

        expect((await call(routes, "GET", "/state")).status).toBe(403);
      });

      it("names every route exactly once across the surface", async () => {
        const seen = new Set<MultiplayerAction>();
        const { routes, multiplayer } = await setup(person("alice"), {
          authorize: ({ action }) => {
            seen.add(action);
            return true;
          },
        });
        const request = await multiplayer.approvals.request({
          sessionId: "s1",
          requestedBy: "alice",
          toolName: "t",
          toolArgs: {},
          summary: "s",
        });

        for (const definition of routes) {
          const { c } = fakeContext({
            params: { sessionId: "s1", approvalId: request.id },
            body: { text: "hi", decision: "approve" },
          });
          await definition.handler(c);
        }

        // A route that forgot to call guard() would be missing here.
        expect([...seen].sort()).toEqual([
          "approvals",
          "audit",
          "interrupt",
          "join",
          "leave",
          "messages",
          "presence",
          "state",
          "stream",
          "vote",
        ]);
      });
    });
  });

  /* ------------------------------------------------------------------ */
  /* State snapshot                                                      */
  /* ------------------------------------------------------------------ */

  describe("GET /state", () => {
    it("returns the roster, presence, approvals, and a consistent seq", async () => {
      const { multiplayer, routes } = await setup();
      await call(routes, "POST", "/join");
      await multiplayer.approvals.request({
        sessionId: "s1",
        requestedBy: "alice",
        toolName: "refund",
        toolArgs: { amountCents: 4000 },
        summary: "Refund $40",
        policy: fourEyes(),
      });

      const response = await call(routes, "GET", "/state");
      const body = response.json as Record<string, any>;

      expect(response.status).toBe(200);
      expect(body.session.threadId).toBe("t1");
      expect(body.participants.map((p: Participant) => p.id)).toEqual(["alice"]);
      expect(body.presence).toHaveLength(1);
      expect(body.approvals).toHaveLength(1);
      expect(body.seq).toBe(multiplayer.bus.currentSeq("s1"));
    });

    it("returns a seq that replays nothing — the snapshot is already current", async () => {
      const { multiplayer, routes } = await setup();
      await call(routes, "POST", "/join");

      const body = (await call(routes, "GET", "/state")).json as { seq: number };
      expect(multiplayer.bus.replay("s1", body.seq)).toEqual([]);
    });

    it("403s rather than 404s for a session that does not exist", async () => {
      // Authorization runs first, so a stranger cannot use the status code to
      // learn which session ids are real.
      const { routes } = await setup();
      const response = await call(routes, "GET", "/state", {
        params: { sessionId: "nope" },
      });

      expect(response.status).toBe(403);
    });

    it("404s for a missing session once authorization has passed", async () => {
      const { routes } = await setup(person("alice"), { authorize: () => true });
      const response = await call(routes, "GET", "/state", {
        params: { sessionId: "nope" },
      });

      expect(response.status).toBe(404);
    });
  });

  /* ------------------------------------------------------------------ */
  /* SSE stream                                                          */
  /* ------------------------------------------------------------------ */

  describe("GET /stream", () => {
    /** Publishes a message and returns the sequence it landed on. */
    const say = (multiplayer: any, text: string) =>
      multiplayer.bus.publish({
        type: "message",
        sessionId: "s1",
        participantId: "alice",
        text,
        fromAgent: false,
      }).seq;

    it("sets the headers proxies need to not buffer the stream", async () => {
      const { routes } = await setup();
      const response = await call(routes, "GET", "/stream");

      expect(response.headers).toMatchObject({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      });
    });

    it("frames each event with its sequence as the SSE id and its type as the name", async () => {
      const { multiplayer, routes } = await setup();
      const seq = say(multiplayer, "hello");

      const response = await call(routes, "GET", "/stream", {
        // Skip the join's own events so the message is the first frame.
        query: { lastSeq: String(seq - 1) },
      });
      const [frame] = await readFrames(response.stream!, 1);
      const parsed = parseFrame(frame!);

      expect(parsed.event).toBe("message");
      expect(parsed.id).toBe(String(seq));
      expect(parsed.data).toMatchObject({ type: "message", seq, text: "hello" });
    });

    it("replays only what the client missed, per Last-Event-ID", async () => {
      const { multiplayer, routes } = await setup();
      const first = say(multiplayer, "one");
      say(multiplayer, "two");
      say(multiplayer, "three");

      const response = await call(routes, "GET", "/stream", {
        headers: { "last-event-id": String(first) },
      });
      const frames = await readFrames(response.stream!, 2);

      expect(frames.map((f) => parseFrame(f).data?.text)).toEqual(["two", "three"]);
    });

    it("accepts ?lastSeq= for the initial open, where no header exists yet", async () => {
      const { multiplayer, routes } = await setup();
      const first = say(multiplayer, "one");
      say(multiplayer, "two");

      const response = await call(routes, "GET", "/stream", {
        query: { lastSeq: String(first) },
      });
      const [frame] = await readFrames(response.stream!, 1);

      expect(parseFrame(frame!).data?.text).toBe("two");
    });

    it("prefers Last-Event-ID over ?lastSeq=, since the header is the live cursor", async () => {
      const { multiplayer, routes } = await setup();
      say(multiplayer, "one");
      const second = say(multiplayer, "two");
      say(multiplayer, "three");

      const response = await call(routes, "GET", "/stream", {
        headers: { "Last-Event-ID": String(second) },
        query: { lastSeq: "0" },
      });
      const [frame] = await readFrames(response.stream!, 1);

      expect(parseFrame(frame!).data?.text).toBe("three");
    });

    it("delivers events published after the stream opens", async () => {
      const { multiplayer, routes } = await setup();
      const response = await call(routes, "GET", "/stream", {
        // Start past the join's events so the first frame is the live one.
        query: { lastSeq: String(multiplayer.bus.currentSeq("s1")) },
      });

      const frames = readFrames(response.stream!, 1);
      say(multiplayer, "live");

      expect(parseFrame((await frames)[0]!).data?.text).toBe("live");
    });

    it("subscribes on open and unsubscribes on cancel", async () => {
      const { multiplayer, routes } = await setup();
      const response = await call(routes, "GET", "/stream");

      // ReadableStream runs start() during construction, so the subscription
      // exists as soon as the handler returns.
      expect(multiplayer.bus.subscriberCount("s1")).toBe(1);

      await response.stream!.cancel();
      expect(multiplayer.bus.subscriberCount("s1")).toBe(0);
    });

    it("clears presence on cancel without evicting anyone from the roster", async () => {
      const { multiplayer, routes } = await setup();
      await call(routes, "POST", "/join");

      const seen: string[] = [];
      multiplayer.bus.subscribe("s1", (event) => seen.push(event.type));

      const response = await call(routes, "GET", "/stream");
      await response.stream!.cancel();
      // presence.disconnected is fired without await inside cancel().
      await new Promise((r) => setTimeout(r, 0));

      expect(seen).not.toContain("participant.left");
      expect(await multiplayer.store.listParticipants("s1")).toHaveLength(1);
      expect(await multiplayer.store.listPresence("s1")).toHaveLength(0);
    });
  });

  /* ------------------------------------------------------------------ */
  /* Messages, presence, interrupt                                       */
  /* ------------------------------------------------------------------ */

  describe("POST /messages", () => {
    it("400s without text rather than broadcasting an empty message", async () => {
      const { routes } = await setup();
      const response = await call(routes, "POST", "/messages", { body: {} });

      expect(response.status).toBe(400);
      expect(response.json).toMatchObject({ error: "Missing text" });
    });

    it("returns the queue depth so a skip-mode UI can say the agent was busy", async () => {
      const { routes } = await setup();
      await call(routes, "POST", "/join");
      const response = await call(routes, "POST", "/messages", {
        body: { text: "hi", addressedToAgent: false },
      });

      expect(response.json).toMatchObject({ ok: true, queueDepth: 0 });
    });
  });

  describe("POST /presence", () => {
    it("records a heartbeat with the requested status", async () => {
      const { routes } = await setup();
      await call(routes, "POST", "/join");
      const response = await call(routes, "POST", "/presence", {
        body: { status: "typing" },
      });

      expect((response.json as any).presence[0]).toMatchObject({
        participantId: "alice",
        status: "typing",
      });
    });

    it("treats a malformed body as an empty one — a failed heartbeat is not a 400", async () => {
      const { routes } = await setup();
      await call(routes, "POST", "/join");
      const response = await call(routes, "POST", "/presence", { malformedBody: true });

      expect(response.status).toBe(200);
      expect((response.json as any).presence[0]).toMatchObject({ status: "active" });
    });
  });

  describe("POST /interrupt", () => {
    it("acknowledges and publishes an interrupt for the room", async () => {
      const { multiplayer, routes } = await setup();
      await call(routes, "POST", "/join");

      const seen: string[] = [];
      multiplayer.bus.subscribe("s1", (event) => seen.push(event.type));
      const response = await call(routes, "POST", "/interrupt");

      expect(response.json).toMatchObject({ ok: true });
      expect(seen).toContain("agent.run.interrupted");
    });
  });

  /* ------------------------------------------------------------------ */
  /* Approvals                                                           */
  /* ------------------------------------------------------------------ */

  describe("approvals", () => {
    async function withPendingApproval(caller: Participant) {
      const multiplayer = createMultiplayer({ agent: fakeAgent() });
      await multiplayer.createSession({ threadId: "t1", id: "s1" });
      await multiplayer.join("s1", person("alice"));
      await multiplayer.join("s1", person("bob"));
      await multiplayer.join("s1", person("vic", "viewer"));

      const request = await multiplayer.approvals.request({
        sessionId: "s1",
        requestedBy: "alice",
        toolName: "refund",
        toolArgs: { amountCents: 4000 },
        summary: "Refund $40",
        policy: fourEyes(),
      });

      const routes = multiplayerRoutes(multiplayer, { authenticate: () => caller });
      return { multiplayer, routes, request };
    }

    it("lists pending approvals for the session", async () => {
      const { routes } = await withPendingApproval(person("bob"));
      const response = await call(routes, "GET", "/approvals");

      expect((response.json as any).approvals).toHaveLength(1);
    });

    it("records a vote from an eligible participant", async () => {
      const { routes, request } = await withPendingApproval(person("bob"));
      const response = await call(routes, "POST", "/vote", {
        params: { approvalId: request.id },
        body: { decision: "approve", reason: "checked the total" },
      });

      expect(response.status).toBe(200);
      expect((response.json as any).approval.votes).toHaveLength(1);
      // fourEyes needs two, so one vote leaves it pending.
      expect((response.json as any).approval.status).toBe("pending");
    });

    it("403s the requester under four-eyes", async () => {
      const { routes, request } = await withPendingApproval(person("alice"));
      const response = await call(routes, "POST", "/vote", {
        params: { approvalId: request.id },
        body: { decision: "approve" },
      });

      expect(response.status).toBe(403);
      expect(response.json).toMatchObject({ code: "not_eligible" });
    });

    it("403s a role that may not vote", async () => {
      const { routes, request } = await withPendingApproval(person("vic", "viewer"));
      const response = await call(routes, "POST", "/vote", {
        params: { approvalId: request.id },
        body: { decision: "approve" },
      });

      expect(response.status).toBe(403);
      expect(response.json).toMatchObject({ code: "not_eligible" });
    });

    it("404s an unknown approval", async () => {
      const { routes } = await withPendingApproval(person("bob"));
      const response = await call(routes, "POST", "/vote", {
        params: { approvalId: "nope" },
        body: { decision: "approve" },
      });

      expect(response.status).toBe(404);
      expect(response.json).toMatchObject({ code: "not_found" });
    });
  });

  /* ------------------------------------------------------------------ */
  /* Audit                                                               */
  /* ------------------------------------------------------------------ */

  describe("GET /audit", () => {
    it("returns the ledger with the acting participant attached", async () => {
      const { routes } = await setup();
      await call(routes, "POST", "/join");
      await call(routes, "POST", "/messages", {
        body: { text: "hi", addressedToAgent: false },
      });

      const entries = (await call(routes, "GET", "/audit")).json as any;
      const actions = entries.audit.map((e: any) => e.action);

      expect(actions).toContain("session.created");
      expect(actions).toContain("participant.joined");
      expect(actions).toContain("message.sent");
      expect(entries.audit.find((e: any) => e.action === "message.sent").actorId).toBe(
        "alice",
      );
    });

    it("honours ?limit= and returns the most recent entries", async () => {
      const { routes } = await setup();
      await call(routes, "POST", "/join");
      for (let i = 0; i < 5; i++) {
        await call(routes, "POST", "/messages", {
          body: { text: `m${i}`, addressedToAgent: false },
        });
      }

      const entries = (await call(routes, "GET", "/audit", { query: { limit: "2" } })
        .then((r) => r.json)) as any;

      expect(entries.audit).toHaveLength(2);
      // Most recent, so both are messages rather than the session creation.
      expect(entries.audit.every((e: any) => e.action === "message.sent")).toBe(true);
    });
  });
});
