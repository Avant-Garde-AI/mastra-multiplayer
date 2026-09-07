# HTTP & SSE

`multiplayerRoutes(session, options)` returns plain route definitions you pass
to Mastra's `registerApiRoute`:

```ts
import { registerApiRoute } from "@mastra/core/server";
import { multiplayerRoutes } from "mastra-multiplayer/server";

const routes = multiplayerRoutes(multiplayer, { authenticate });

export const mastra = new Mastra({
  agents: { support },
  server: {
    apiRoutes: routes.map((r) =>
      registerApiRoute(r.path, { method: r.method, handler: r.handler }),
    ),
  },
});
```

The base path defaults to `/multiplayer` and **must not start with `/api`** —
Mastra reserves that prefix.

## Authentication

```ts
interface MultiplayerRoutesOptions {
  basePath?: string;
  authenticate: (c: HonoLikeContext) => Promise<Participant | null> | Participant | null;
  authorize?: (input: AuthorizeInput) => boolean | Promise<boolean>;
}

interface AuthorizeInput {
  participant: Participant;
  sessionId: string;
  action: MultiplayerAction;   // the route being accessed
  context: HonoLikeContext;
}
```

Both run on every route, in that order.

**`authenticate` is load-bearing.** Whatever it returns is the identity every
message, vote, and audit entry is attributed to. It must derive from a verified
session — a signed cookie, a validated JWT — and never from the request body, or
the four-eyes rule is decorative. Returning `null` yields `401`.

**`authorize` decides whether that identity may act on this session.** It
defaults to roster membership, exempting `join` because the caller cannot
already be on a roster they are asking to join. Returning false yields `403`
with `code: "not_a_member"`.

`action` is the route name — `join`, `leave`, `stream`, `state`, `presence`,
`messages`, `interrupt`, `approvals`, `vote`, `audit` — so individual
capabilities can be gated separately. A custom hook **replaces** the membership
rule rather than layering on it: if you supply one, you own that check too.

See [SECURITY](./SECURITY.md#session-level-authorization) for the reasoning and
the failure modes.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/sessions/:sessionId/stream` | SSE event stream |
| `GET` | `/sessions/:sessionId/state` | State snapshot for a cold start |
| `POST` | `/sessions/:sessionId/join` | Join the roster |
| `POST` | `/sessions/:sessionId/leave` | Leave |
| `POST` | `/sessions/:sessionId/presence` | Heartbeat / typing |
| `POST` | `/sessions/:sessionId/messages` | Send a message |
| `POST` | `/sessions/:sessionId/interrupt` | Stop the running agent |
| `GET` | `/sessions/:sessionId/approvals` | Pending approvals |
| `POST` | `/approvals/:approvalId/vote` | Approve or deny |
| `GET` | `/sessions/:sessionId/audit` | Audit ledger |

All paths are relative to `basePath`.

### `GET /sessions/:sessionId/state`

Everything a client needs to render a session that is already in progress.

```json
{
  "session": { "id": "...", "threadId": "...", "agentId": "...", "createdAt": 0, "updatedAt": 0 },
  "participants": [ { "id": "u_1", "displayName": "Alice", "role": "owner", "surface": "web" } ],
  "presence": [ { "participantId": "u_1", "status": "active", "lastSeenAt": 0 } ],
  "approvals": [ /* pending ApprovalRequest[] */ ],
  "seq": 47
}
```

`seq` is the sequence the snapshot is consistent with. Open the stream from it
and you will neither miss an event nor apply one twice.

An unknown session returns `403`, not `404` — authorization runs before the
session is loaded, so the status code cannot be used to discover which session
ids are real. `404` appears only once authorization has passed.

**Messages are not in the snapshot.** Mastra's memory owns the transcript —
fetch it through Mastra's own APIs. See
[ADR 0001](./decisions/0001-two-storage-systems.md).

### `GET /sessions/:sessionId/stream`

Server-sent events. Resumes from `Last-Event-ID` (set automatically by
`EventSource` on reconnect) or a `?lastSeq=` query parameter, replaying anything
buffered above that sequence before switching to live delivery.

Response headers:

```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

`X-Accel-Buffering: no` matters — nginx will otherwise buffer the stream and
deliver nothing until it decides to flush.

A `: ping` comment frame every 15 seconds keeps proxies from closing an idle
connection.

**Backpressure.** `controller.enqueue` never blocks, so a client that stops
reading — a suspended laptop, a stalled proxy — would otherwise grow the
server's queue until the process runs out of memory. A busy session streaming
tokens produces hundreds of frames a second, so that is not a slow leak.

Once `streamHighWaterMark` frames (default 256) are queued unsent:

- **`agent.delta` is dropped.** The terminal `message` event carries the
  assembled text, so the client still ends up with the whole reply — just
  without the typing effect.
- **Anything else closes the stream.** A message, a roster change, an approval:
  none can be reconstructed from later events. `EventSource` reconnects with
  `Last-Event-ID` and replays from the last frame actually delivered, which is
  what the replay buffer is for. A closure is logged at `warn` with the count of
  deltas dropped first.

Closing the stream clears the sender's presence but **does not** remove them
from the roster. A stream closes on every reconnect and tab switch; only
`POST /leave` is a departure.

### `POST /sessions/:sessionId/messages`

```json
{ "text": "can we refund order 4417?", "addressedToAgent": true }
```

→ `{ "ok": true, "queueDepth": 0 }`. `400` if `text` is missing.

`addressedToAgent: false` broadcasts to the room and audits the message without
starting a turn. `queueDepth` is how many messages are waiting — surface it if
your concurrency mode is `skip`, or people will not know their message was
dropped.

### `POST /sessions/:sessionId/presence`

```json
{ "status": "typing", "cursor": { "anchor": 42 } }
```

→ `{ "presence": [...] }`. Both fields optional; `status` defaults to `active`.
A malformed body is treated as an empty one rather than a `400`, because a
failed heartbeat should not look like a client bug.

Call it well inside the server's `idleAfterMs` (default 30s). The bundled client
uses 10s.

`cursor` is stored and broadcast untouched — it is a hook for co-editing
surfaces, and nothing in the package interprets it.

### `POST /approvals/:approvalId/vote`

```json
{ "decision": "approve", "reason": "checked the order total" }
```

→ `{ "approval": { ... } }`, or an error:

| Status | `code` | Meaning |
| --- | --- | --- |
| `404` | `not_found` | No such approval |
| `403` | `not_a_member` | Not authorized for the approval's session |
| `403` | `not_eligible` | Wrong role, is the requester under four-eyes, or already voted |
| `403` | `already_resolved` | Resolved before this vote landed |

`already_resolved` returning `403` rather than `409` is a wart. Fixing it is a
breaking change to the error contract, so it waits for a release that has
others.

Note this route is *not* under `/sessions/:sessionId` — an approval id is
globally unique and carries its own session. Authorization reads that session
off the stored approval, never off the request, so a session id supplied by the
caller cannot widen what they may vote on.

### `GET /sessions/:sessionId/audit`

`?limit=` (default 100) returns the most recent entries, oldest first within the
window: `{ "audit": [ { "id", "sessionId", "action", "actorId", "at", "detail" } ] }`.

`actorId` is `null` for agent-originated entries.

## Event frames

Every event is delivered as a named SSE event whose `id` is the sequence:

```
id: 12
event: message
data: {"type":"message","sessionId":"s_1","seq":12,"at":1757000000000,"participantId":"u_1","text":"hi","fromAgent":false}

```

Every payload carries `type`, `sessionId`, `seq`, and `at`.

| Event | Extra fields |
| --- | --- |
| `participant.joined` | `participant` |
| `participant.left` | `participantId` |
| `presence.updated` | `presence[]` |
| `message` | `participantId` (null for the agent), `text`, `fromAgent` |
| `agent.delta` | `runId`, `delta` |
| `agent.run.started` | `runId`, `triggeredBy` |
| `agent.run.finished` | `runId`, `triggeredBy` |
| `agent.run.interrupted` | `runId`, `triggeredBy` |
| `approval.requested` | `request` |
| `approval.updated` | `request` |
| `approval.resolved` | `request` |

Because they are *named* events, `EventSource.onmessage` never fires — attach a
listener per type, as `MultiplayerClient` does.

## Client sequencing

The order that avoids every race:

1. `POST /join`
2. `GET /state` → apply the snapshot, set the cursor to `seq`
3. `GET /stream?lastSeq=<seq>` → live

`MultiplayerClient.start()` does exactly this. Hydrating *after* connecting
leaves a window where replayed frames below `snapshot.seq` are still in flight,
and advancing the cursor to the snapshot would drop them — which is why
`hydrate()` only adopts `snapshot.seq` when no stream is open.

Reconnects are handled by `EventSource` sending `Last-Event-ID`, with the client
also carrying `?lastSeq=` for the initial open. Duplicate events below the
cursor are ignored, so redelivery is harmless.

If a client has been gone longer than the replay buffer (200 events), it should
re-`hydrate()` rather than trust the replay.

## Bearer tokens do not work on the stream

`EventSource` cannot send custom headers. This is a browser limitation with no
workaround short of a fetch-based SSE parser.

So `MultiplayerClientOptions.headers` applies to the POSTs but **not** the
stream, which authenticates with cookies via `withCredentials: true`. If your
`authenticate` reads a bearer header, the stream will 401 while every other
route succeeds — a confusing failure worth knowing about in advance.

Options: use a cookie for the stream, accept a short-lived token as a query
parameter (it will be logged by every proxy in the path — use one-time tokens
if you go this way), or replace `MultiplayerClient` with a fetch-based reader.
