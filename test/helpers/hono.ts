import type { HonoLikeContext, RouteDefinition } from "../../src/server/index.js";

/**
 * A stand-in for the Hono context Mastra passes at runtime.
 *
 * The package declares Hono structurally rather than importing it
 * (docs/decisions/0004), so the routes can be exercised against a plain object
 * — no server, no port, no `@mastra/core`.
 */
export interface FakeRequest {
  params?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  /** Set to make `c.req.json()` reject, as a malformed body does. */
  malformedBody?: boolean;
}

export interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON body, when the handler returned JSON. */
  json?: unknown;
  /** Raw stream body, when the handler returned one. */
  stream?: ReadableStream<Uint8Array>;
}

export function fakeContext(request: FakeRequest = {}): {
  c: HonoLikeContext;
  captured: () => CapturedResponse;
} {
  let captured: CapturedResponse = { status: 200, headers: {} };

  const c: HonoLikeContext = {
    req: {
      param: (name) => request.params?.[name],
      query: (name) => request.query?.[name],
      header: (name) => {
        // Hono matches headers case-insensitively; a test that only passes
        // because it guessed the casing is not testing anything.
        const wanted = name.toLowerCase();
        const found = Object.entries(request.headers ?? {}).find(
          ([key]) => key.toLowerCase() === wanted,
        );
        return found?.[1];
      },
      json: async <T,>() => {
        if (request.malformedBody) throw new SyntaxError("Unexpected end of JSON input");
        return request.body as T;
      },
    },
    json: (body, status = 200) => {
      captured = { status, headers: {}, json: body };
      return new Response(JSON.stringify(body), { status });
    },
    body: (body, init) => {
      captured = {
        status: init?.status ?? 200,
        headers: (init?.headers as Record<string, string>) ?? {},
        stream: body as ReadableStream<Uint8Array>,
      };
      return new Response(null, init);
    },
    get: () => undefined,
  };

  return { c, captured: () => captured };
}

/** Finds one route by method and path suffix, failing loudly if it moved. */
export function route(
  routes: RouteDefinition[],
  method: RouteDefinition["method"],
  suffix: string,
): RouteDefinition {
  const matches = routes.filter((r) => r.method === method && r.path.endsWith(suffix));
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${method} route ending in "${suffix}", found ${matches.length}: ` +
        routes.map((r) => `${r.method} ${r.path}`).join(", "),
    );
  }
  return matches[0]!;
}

/** Reads an SSE stream until it has `count` frames, then cancels it. */
export async function readFrames(
  stream: ReadableStream<Uint8Array>,
  count: number,
): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buffer = "";

  try {
    while (frames.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      frames.push(...parts.filter((p) => p.length > 0));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return frames.slice(0, count);
}

/** Pulls the `event:` and `data:` lines out of one SSE frame. */
export function parseFrame(frame: string): {
  id?: string;
  event?: string;
  data?: Record<string, unknown>;
  comment?: string;
} {
  const out: ReturnType<typeof parseFrame> = {};
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) out.comment = line.slice(1).trim();
    else if (line.startsWith("id: ")) out.id = line.slice(4);
    else if (line.startsWith("event: ")) out.event = line.slice(7);
    else if (line.startsWith("data: ")) out.data = JSON.parse(line.slice(6));
  }
  return out;
}
