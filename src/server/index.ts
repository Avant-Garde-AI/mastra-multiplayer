import { unrefTimer } from "../internal/timers.js";
import { consoleLogger, safeLogger, type Logger } from "../internal/logger.js";
import type { MultiplayerSession } from "../session.js";
import type { MultiplayerEvent } from "../bus/events.js";
import type { Participant } from "../types.js";

/**
 * Minimal structural types for Hono, so this module compiles without pulling
 * in `@mastra/core` or `hono` as a hard dependency. At runtime Mastra passes
 * a real Hono context.
 */
export interface HonoLikeContext {
  req: {
    param(name: string): string | undefined;
    query(name: string): string | undefined;
    json<T = unknown>(): Promise<T>;
    header(name: string): string | undefined;
  };
  json(body: unknown, status?: number): Response;
  body(body: BodyInit | null, init?: ResponseInit): Response;
  get(key: string): unknown;
}

export interface RouteDefinition {
  path: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "ALL";
  handler: (c: HonoLikeContext) => Promise<Response> | Response;
}

/**
 * The route being accessed, named rather than lumped into read/write so an
 * `authorize` hook can gate individual capabilities — audit for owners only,
 * say, or a read-only surface for a support engineer.
 */
export type MultiplayerAction =
  | "join"
  | "leave"
  | "stream"
  | "state"
  | "presence"
  | "messages"
  | "interrupt"
  | "approvals"
  | "vote"
  | "audit";

export interface AuthorizeInput {
  /** The identity `authenticate` returned. Never client-supplied. */
  participant: Participant;
  /**
   * The session being acted on. For `vote` this is resolved from the approval,
   * since that route carries no session in its path.
   */
  sessionId: string;
  action: MultiplayerAction;
  context: HonoLikeContext;
}

export interface MultiplayerRoutesOptions {
  /** Path prefix for the routes. Must not start with `/api`. Default `/multiplayer`. */
  basePath?: string;
  /**
   * Resolves the calling participant from the request. Wire this to your own
   * auth. Returning null rejects the request with 401.
   */
  authenticate: (c: HonoLikeContext) => Promise<Participant | null> | Participant | null;
  /**
   * Decides whether this identity may act on this session. Returning false
   * rejects with 403.
   *
   * `authenticate` answers *who is this*; this answers *may they be here*.
   * Without the second question, any authenticated participant can pass any
   * `sessionId` and read that session — a cross-tenant read in any product
   * with more than one customer.
   *
   * Defaults to roster membership, with `join` exempted because the caller is
   * by definition not yet on the roster. Override it to add your own rules —
   * an invitation check on `join`, a role gate on `audit`, tenant scoping
   * ahead of either.
   */
  authorize?: (input: AuthorizeInput) => boolean | Promise<boolean>;
  /**
   * How many SSE frames may sit unsent to one client before the stream applies
   * backpressure. Default 256.
   *
   * `controller.enqueue` never blocks, so without a ceiling a client that stops
   * reading — a suspended laptop, a stalled proxy — grows the server's queue
   * until the process runs out of memory. A busy session streaming tokens can
   * produce hundreds of frames a second, so this is not a slow leak.
   */
  streamHighWaterMark?: number;
  /** Where to report a dropped or closed stream. Defaults to `console`. */
  logger?: Logger;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

function sseFrame(event: MultiplayerEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Builds the HTTP surface for a multiplayer session.
 *
 * Pass the result to Mastra's `server.apiRoutes` via `registerApiRoute`:
 *
 * ```ts
 * import { registerApiRoute } from "@mastra/core/server";
 * import { multiplayerRoutes } from "@avant-garde-ai/mastra-multiplayer/server";
 *
 * const routes = multiplayerRoutes(session, { authenticate });
 *
 * export const mastra = new Mastra({
 *   agents: { support },
 *   server: {
 *     apiRoutes: routes.map((r) =>
 *       registerApiRoute(r.path, { method: r.method, handler: r.handler }),
 *     ),
 *   },
 * });
 * ```
 */
export function multiplayerRoutes(
  session: MultiplayerSession,
  options: MultiplayerRoutesOptions,
): RouteDefinition[] {
  const base = options.basePath ?? "/multiplayer";
  const auth = options.authenticate;
  const highWaterMark = options.streamHighWaterMark ?? 256;
  const logger = safeLogger(options.logger ?? consoleLogger);

  const unauthorized = (c: HonoLikeContext) =>
    c.json({ error: "Unauthorized" }, 401);
  const forbidden = (c: HonoLikeContext) =>
    c.json({ error: "Forbidden", code: "not_a_member" }, 403);

  /**
   * Roster membership, the default rule.
   *
   * Fails closed: a store that throws (unknown session, database down) is not
   * a membership proof, so it denies rather than letting the request through.
   * The cost is that a genuine outage reads as 403 instead of 500 — the right
   * trade for an authorization check.
   */
  const rosterMembership = async (input: AuthorizeInput): Promise<boolean> => {
    // The caller cannot already be on a roster they are asking to join.
    if (input.action === "join") return true;
    try {
      const found = await session.store.getParticipant(
        input.sessionId,
        input.participant.id,
      );
      return found !== null;
    } catch {
      return false;
    }
  };

  const authorize = options.authorize ?? rosterMembership;

  /**
   * Authenticates, then authorizes, then hands back the caller.
   *
   * Every route goes through this, so there is one place where "who is this"
   * and "may they be here" are both answered — and no route can be added that
   * silently skips the second question.
   */
  type Guarded =
    | { ok: true; participant: Participant; sessionId: string }
    | { ok: false; response: Response };

  const guard = async (
    c: HonoLikeContext,
    action: MultiplayerAction,
    explicitSessionId?: string,
  ): Promise<Guarded> => {
    const participant = await auth(c);
    if (!participant) return { ok: false, response: unauthorized(c) };

    const sessionId = explicitSessionId ?? c.req.param("sessionId");
    if (!sessionId) {
      return { ok: false, response: c.json({ error: "Missing sessionId" }, 400) };
    }

    const allowed = await authorize({ participant, sessionId, action, context: c });
    if (!allowed) return { ok: false, response: forbidden(c) };

    return { ok: true, participant, sessionId };
  };

  return [
    /* ---------------------------------------------------------------- */
    /* Live event stream                                                 */
    /* ---------------------------------------------------------------- */
    {
      path: `${base}/sessions/:sessionId/stream`,
      method: "GET",
      handler: async (c) => {
        const gate = await guard(c, "stream");
        if (!gate.ok) return gate.response;
        const { participant, sessionId } = gate;

        // Clients reconnect with Last-Event-ID so they only miss nothing.
        const lastEventId = c.req.header("Last-Event-ID") ?? c.req.query("lastSeq");
        const afterSeq = lastEventId ? Number(lastEventId) : 0;

        const encoder = new TextEncoder();
        let unsubscribe: (() => void) | null = null;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        let cancelled = false;
        let dropped = 0;

        const stream = new ReadableStream<Uint8Array>({
          // `start` may return a promise, and the stream waits for it — so the
          // first frame is not written until the subscription is live.
          start: async (controller) => {
            // Replay and subscribe as one operation. Doing them separately
            // drops whatever is published in between, which a distributed bus
            // makes likely rather than theoretical.
            unsubscribe = await session.bus.subscribeFrom(
              sessionId,
              afterSeq,
              (event) => {
                // `desiredSize` falling to zero means this client is not
                // keeping up. What happens next depends on the event.
                const backedUp = (controller.desiredSize ?? 1) <= 0;

                if (backedUp && event.type === "agent.delta") {
                  // Deltas are the only droppable event: the terminal
                  // `message` carries the assembled text, so a client that
                  // misses them still ends up with the whole reply, just
                  // without the typing effect.
                  dropped++;
                  return;
                }

                if (backedUp) {
                  // Everything else is state the client cannot reconstruct, so
                  // close the stream instead of dropping it. `EventSource`
                  // reconnects with `Last-Event-ID` and replays from the last
                  // frame actually delivered — the buffer exists for this.
                  logger.warn("closing a backed-up SSE stream; client will reconnect", {
                    sessionId,
                    participantId: participant.id,
                    droppedDeltas: dropped,
                  });
                  try {
                    controller.close();
                  } catch {
                    /* already closed */
                  }
                  unsubscribe?.();
                  if (heartbeat) clearInterval(heartbeat);
                  return;
                }

                try {
                  controller.enqueue(encoder.encode(sseFrame(event)));
                } catch {
                  // Stream already closed by the client.
                }
              },
            );

            // Comment frames keep proxies from closing an idle connection.
            heartbeat = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(": ping\n\n"));
              } catch {
                /* closed */
              }
            }, 15_000);
            unrefTimer(heartbeat);

            if (cancelled) {
              // The client hung up while the subscription was being set up.
              unsubscribe?.();
              clearInterval(heartbeat);
            }
          },
          cancel: () => {
            // `start` may still be resolving; whichever finishes last cleans up.
            cancelled = true;
            unsubscribe?.();
            if (heartbeat) clearInterval(heartbeat);
            // A closed stream is a dropped transport, not a departure. Clear
            // presence; let `/leave` be the thing that empties the roster.
            void session.presence.disconnected(sessionId, participant.id);
          },
        },
        // Without an explicit strategy the high-water mark is 1, so
        // `desiredSize` goes non-positive after a single unread frame and every
        // stream would look backed up.
        new CountQueuingStrategy({ highWaterMark }));

        return c.body(stream as unknown as BodyInit, { headers: SSE_HEADERS });
      },
    },

    /* ---------------------------------------------------------------- */
    /* Roster and presence                                               */
    /* ---------------------------------------------------------------- */
    {
      path: `${base}/sessions/:sessionId/state`,
      method: "GET",
      handler: async (c) => {
        const gate = await guard(c, "state");
        if (!gate.ok) return gate.response;
        const { sessionId } = gate;

        const record = await session.store.getSession(sessionId);
        if (!record) return c.json({ error: "Unknown session" }, 404);

        const [participants, presence, approvals] = await Promise.all([
          session.store.listParticipants(sessionId),
          session.store.listPresence(sessionId),
          session.approvals.pending(sessionId),
        ]);

        return c.json({
          session: record,
          participants,
          presence,
          approvals,
          // The sequence this snapshot is consistent with. Reconnect the
          // stream from here and no event is seen twice or missed.
          seq: await session.bus.currentSeq(sessionId),
        });
      },
    },
    {
      path: `${base}/sessions/:sessionId/join`,
      method: "POST",
      handler: async (c) => {
        const gate = await guard(c, "join");
        if (!gate.ok) return gate.response;
        const participants = await session.join(gate.sessionId, gate.participant);
        return c.json({ participants });
      },
    },
    {
      path: `${base}/sessions/:sessionId/leave`,
      method: "POST",
      handler: async (c) => {
        const gate = await guard(c, "leave");
        if (!gate.ok) return gate.response;
        await session.leave(gate.sessionId, gate.participant.id);
        return c.json({ ok: true });
      },
    },
    {
      path: `${base}/sessions/:sessionId/presence`,
      method: "POST",
      handler: async (c) => {
        const gate = await guard(c, "presence");
        if (!gate.ok) return gate.response;
        const { participant, sessionId } = gate;
        const body = await c.req
          .json<{ status?: "active" | "idle" | "typing" | "away"; cursor?: unknown }>()
          .catch(() => ({}) as { status?: undefined; cursor?: undefined });
        const presence = await session.presence.heartbeat(
          sessionId,
          participant.id,
          body.status ?? "active",
          body.cursor,
        );
        return c.json({ presence });
      },
    },

    /* ---------------------------------------------------------------- */
    /* Messages                                                          */
    /* ---------------------------------------------------------------- */
    {
      path: `${base}/sessions/:sessionId/messages`,
      method: "POST",
      handler: async (c) => {
        const gate = await guard(c, "messages");
        if (!gate.ok) return gate.response;
        const { participant, sessionId } = gate;
        const body = await c.req.json<{ text: string; addressedToAgent?: boolean }>();
        if (!body?.text) return c.json({ error: "Missing text" }, 400);

        await session.send({
          sessionId,
          participantId: participant.id,
          text: body.text,
          addressedToAgent: body.addressedToAgent ?? true,
        });
        return c.json({ ok: true, queueDepth: session.turns.queueDepth(sessionId) });
      },
    },
    {
      path: `${base}/sessions/:sessionId/interrupt`,
      method: "POST",
      handler: async (c) => {
        const gate = await guard(c, "interrupt");
        if (!gate.ok) return gate.response;
        await session.interrupt(gate.sessionId, gate.participant.id);
        return c.json({ ok: true });
      },
    },

    /* ---------------------------------------------------------------- */
    /* Approvals                                                         */
    /* ---------------------------------------------------------------- */
    {
      path: `${base}/sessions/:sessionId/approvals`,
      method: "GET",
      handler: async (c) => {
        const gate = await guard(c, "approvals");
        if (!gate.ok) return gate.response;
        const pending = await session.approvals.pending(gate.sessionId);
        return c.json({ approvals: pending });
      },
    },
    {
      path: `${base}/approvals/:approvalId/vote`,
      method: "POST",
      handler: async (c) => {
        const participant = await auth(c);
        if (!participant) return unauthorized(c);

        // This path carries no session, so the approval has to name its own
        // before it can be authorized against one.
        const approvalId = c.req.param("approvalId")!;
        const approval = await session.store.getApproval(approvalId);
        if (!approval) {
          return c.json(
            { error: "Approval request not found", code: "not_found" },
            404,
          );
        }

        const allowed = await authorize({
          participant,
          sessionId: approval.sessionId,
          action: "vote",
          context: c,
        });
        if (!allowed) return forbidden(c);

        const body = await c.req.json<{ decision: "approve" | "deny"; reason?: string }>();

        try {
          const request = await session.approvals.vote(
            approvalId,
            participant.id,
            body.decision,
            body.reason,
          );
          return c.json({ approval: request });
        } catch (error) {
          const code = (error as { code?: string }).code;
          const status = code === "not_found" ? 404 : 403;
          return c.json({ error: (error as Error).message, code }, status);
        }
      },
    },

    /* ---------------------------------------------------------------- */
    /* Audit                                                             */
    /* ---------------------------------------------------------------- */
    {
      path: `${base}/sessions/:sessionId/audit`,
      method: "GET",
      handler: async (c) => {
        const gate = await guard(c, "audit");
        if (!gate.ok) return gate.response;
        const limit = Number(c.req.query("limit") ?? 100);
        const entries = await session.store.listAudit(gate.sessionId, limit);
        return c.json({ audit: entries });
      },
    },
  ];
}
