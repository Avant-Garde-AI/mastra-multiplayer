import { unrefTimer } from "../internal/timers.js";
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

export interface MultiplayerRoutesOptions {
  /** Path prefix for the routes. Must not start with `/api`. Default `/multiplayer`. */
  basePath?: string;
  /**
   * Resolves the calling participant from the request. Wire this to your own
   * auth. Returning null rejects the request with 401.
   */
  authenticate: (c: HonoLikeContext) => Promise<Participant | null> | Participant | null;
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
 * import { multiplayerRoutes } from "mastra-multiplayer/server";
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

  const unauthorized = (c: HonoLikeContext) =>
    c.json({ error: "Unauthorized" }, 401);

  return [
    /* ---------------------------------------------------------------- */
    /* Live event stream                                                 */
    /* ---------------------------------------------------------------- */
    {
      path: `${base}/sessions/:sessionId/stream`,
      method: "GET",
      handler: async (c) => {
        const participant = await auth(c);
        if (!participant) return unauthorized(c);

        const sessionId = c.req.param("sessionId");
        if (!sessionId) return c.json({ error: "Missing sessionId" }, 400);

        // Clients reconnect with Last-Event-ID so they only miss nothing.
        const lastEventId = c.req.header("Last-Event-ID") ?? c.req.query("lastSeq");
        const afterSeq = lastEventId ? Number(lastEventId) : 0;

        const encoder = new TextEncoder();
        let unsubscribe: (() => void) | null = null;
        let heartbeat: ReturnType<typeof setInterval> | null = null;

        const stream = new ReadableStream<Uint8Array>({
          start: (controller) => {
            for (const event of session.bus.replay(sessionId, afterSeq)) {
              controller.enqueue(encoder.encode(sseFrame(event)));
            }

            unsubscribe = session.bus.subscribe(sessionId, (event) => {
              try {
                controller.enqueue(encoder.encode(sseFrame(event)));
              } catch {
                // Stream already closed by the client.
              }
            });

            // Comment frames keep proxies from closing an idle connection.
            heartbeat = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(": ping\n\n"));
              } catch {
                /* closed */
              }
            }, 15_000);
            unrefTimer(heartbeat);
          },
          cancel: () => {
            unsubscribe?.();
            if (heartbeat) clearInterval(heartbeat);
            // A closed stream is a dropped transport, not a departure. Clear
            // presence; let `/leave` be the thing that empties the roster.
            void session.presence.disconnected(sessionId, participant.id);
          },
        });

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
        const participant = await auth(c);
        if (!participant) return unauthorized(c);
        const sessionId = c.req.param("sessionId")!;

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
          seq: session.bus.currentSeq(sessionId),
        });
      },
    },
    {
      path: `${base}/sessions/:sessionId/join`,
      method: "POST",
      handler: async (c) => {
        const participant = await auth(c);
        if (!participant) return unauthorized(c);
        const sessionId = c.req.param("sessionId")!;
        const participants = await session.join(sessionId, participant);
        return c.json({ participants });
      },
    },
    {
      path: `${base}/sessions/:sessionId/leave`,
      method: "POST",
      handler: async (c) => {
        const participant = await auth(c);
        if (!participant) return unauthorized(c);
        await session.leave(c.req.param("sessionId")!, participant.id);
        return c.json({ ok: true });
      },
    },
    {
      path: `${base}/sessions/:sessionId/presence`,
      method: "POST",
      handler: async (c) => {
        const participant = await auth(c);
        if (!participant) return unauthorized(c);
        const sessionId = c.req.param("sessionId")!;
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
        const participant = await auth(c);
        if (!participant) return unauthorized(c);
        const sessionId = c.req.param("sessionId")!;
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
        const participant = await auth(c);
        if (!participant) return unauthorized(c);
        await session.interrupt(c.req.param("sessionId")!, participant.id);
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
        const participant = await auth(c);
        if (!participant) return unauthorized(c);
        const pending = await session.approvals.pending(c.req.param("sessionId")!);
        return c.json({ approvals: pending });
      },
    },
    {
      path: `${base}/approvals/:approvalId/vote`,
      method: "POST",
      handler: async (c) => {
        const participant = await auth(c);
        if (!participant) return unauthorized(c);
        const approvalId = c.req.param("approvalId")!;
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
        const participant = await auth(c);
        if (!participant) return unauthorized(c);
        const limit = Number(c.req.query("limit") ?? 100);
        const entries = await session.store.listAudit(
          c.req.param("sessionId")!,
          limit,
        );
        return c.json({ audit: entries });
      },
    },
  ];
}
