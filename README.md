# mastra-multiplayer

Multiplayer primitives for [Mastra](https://mastra.ai) agents: **many humans in one agent session**.

Mastra already handles the channel side of this well — the Signal API gives you concurrency modes for interleaved messages, and Channels puts an agent into Slack, Discord, Teams, GitHub and Linear. What it does not ship is the layer you need when the shared session lives in *your own product UI*: presence, per-participant attribution, multi-approver gates, and an audit trail of who asked for what.

That is what this package is.

> Status: `0.1.0`, pre-release. The API will change. Not affiliated with the Mastra team.

## What "multiplayer" means here

Multiplayer is **multi-human**, not multi-agent. One agent and four people in a shared session is multiplayer. Twenty agents and one person reading a log is not.

The distinction matters because the hard problems are entirely different. Multi-agent is a routing and orchestration problem. Multiplayer is a *social* problem that happens to be implemented in TypeScript: whose instruction wins when two people disagree, who is allowed to approve a destructive action, what the model should be told about the room it is speaking to.

## Install

```bash
npm install mastra-multiplayer
```

Peer dependencies: `@mastra/core` (optional, for the server routes) and `react` (optional, for the hook).

## Quickstart

```ts
import { createMultiplayer } from "mastra-multiplayer";

const multiplayer = createMultiplayer({
  agent: supportAgent,
  concurrency: { mode: "batch", windowMs: 2000 },
});

const session = await multiplayer.createSession({ threadId: "thread_abc" });

await multiplayer.join(session.id, {
  id: "u_1",
  displayName: "Alice",
  role: "owner",
  surface: "web",
});

await multiplayer.send({
  sessionId: session.id,
  participantId: "u_1",
  text: "can we refund order 4417?",
});
```

On the client:

```tsx
const { messages, presence, approvals, send, vote } = useMultiplayerSession({
  sessionId,
});
```

See [`examples/`](./examples) for a full Mastra server, an approval-gated tool, and a React consumer.

## The three primitives

### 1. Presence and rooms

Heartbeat-based, not connection-based. A Slack participant has no socket and a crashed browser tab never disconnects cleanly, so presence is "who checked in recently" rather than "who holds an open connection". Participants go `active → idle → dropped` on configurable windows, and every transition is broadcast.

```ts
await multiplayer.presence.setTyping(sessionId, "u_1", true);
multiplayer.presence.startSweeping(); // ages out stale participants
```

### 2. Multi-approver gates

Human-in-the-loop stops being simple the moment there is more than one human. The policy engine covers the patterns that actually show up in governance reviews:

```ts
import { fourEyes, quorumOf, approverOnly } from "mastra-multiplayer";

fourEyes()        // two approvals, requester excluded (maker-checker)
quorumOf(3)       // any three eligible participants
approverOnly()    // one signature, but only from a designated approver
```

Three properties worth knowing about:

- **Approvals are bound to arguments.** A SHA-256 of `toolName + stable(args)` is stored on the request. `assertBinding()` re-checks it before execution, so an approval for a $40 refund cannot be replayed against a $4,000 one.
- **Deny is final by default,** and expiry defaults to `deny`. Silence is not consent.
- **The resolved policy is stored on the request,** so a restart mid-approval cannot weaken a gate, and a later release that changes a default cannot retroactively change a pending one.
- **Every request, vote, and resolution is written to the audit ledger** with the participant id attached.

### 3. Shared-session event bus

A sequenced, per-session pub/sub with a replay buffer. Clients reconnect with `Last-Event-ID` and receive only what they missed, rather than replaying the whole session or silently dropping events.

Events: `participant.joined`, `participant.left`, `presence.updated`, `message`, `agent.delta`, `agent.run.started|finished|interrupted`, `approval.requested|updated|resolved`.

## Concurrency: what happens when two people type at once

A single-user chat loop assumes one message, one turn. `TurnController` gives you five answers, mirroring Mastra's Signal API modes so they can be wired together without translation:

| Mode | Behaviour | Use when |
| --- | --- | --- |
| `queue` | Run turns in arrival order, one at a time | Default. Safest, preserves everyone's intent |
| `debounce` | Wait for a quiet window, run only the last message | Someone is thinking out loud across several messages |
| `batch` | Collect a window into one turn | A group is riffing and you want one coherent reply |
| `skip` | Drop messages arriving mid-run | High-volume channels where stale asks are worse than none |
| `preempt` | Abort the in-flight run, start over | "Stop, do this instead" is common in your product |

`preempt` and `interrupt()` both fire an `AbortSignal` that is passed through to `agent.stream`, so tools can honour cancellation.

## Attribution

A model handed a shared transcript with no speaker labels reads it as one person contradicting themselves. `labelBatch` prefixes each message with its author, and `rosterPrompt` appends a system-prompt fragment describing the room:

```
You are in a shared session with more than one person.
Messages are prefixed with the name of whoever wrote them.

People currently in this session:
- Alice (owner)
- Bob (editor)

Guidelines for a shared session:
- Address people by name when replying to a specific person.
- If two people ask for conflicting things, say so plainly and ask which to
  follow rather than picking silently.
...
```

That last guideline is the one that earns its place. Without it the model picks a side silently, and the person it ignored has no idea it happened.

## Memory scoping

Mastra's memory is keyed on `threadId` (per conversation) and `resourceId` (per user, across threads). For a shared session:

- **`threadId`** → the session. Everyone reads and writes the same conversation.
- **`resourceId`** → the *session*, not the person. Each turn passes `memory: { thread: session.threadId, resource: session.id }`, so resource-scoped memory is per-room. That is the right default here — resource-scoped memory keyed to an individual means what one person tells the agent silently follows them out of the room — but note it means `Participant.resourceId` is stored for your own use and by channel adapters, and is not yet read by the library. Override it per turn with `buildStreamOptions` if you need something else.
- **Working memory** should almost always be `scope: "thread"` in a shared session, for the same reason.

Long shared threads outgrow the context window faster than single-user ones. Mastra's memory processors are the right tool for trimming; this package does not duplicate them.

## Storage

`MultiplayerStore` covers only what Mastra does not model: the participant roster, presence, approvals, and audit. Messages and threads stay in Mastra's own storage.

`InMemoryMultiplayerStore` ships for development and tests. It loses everything on restart and does not work across processes — implement the interface against your database before shipping.

## HTTP surface

`multiplayerRoutes(session, { authenticate })` returns route definitions you pass to Mastra's `registerApiRoute`:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/multiplayer/sessions/:id/stream` | SSE event stream |
| `GET` | `/multiplayer/sessions/:id/state` | Roster, presence, and open approvals for a cold start |
| `POST` | `/multiplayer/sessions/:id/join` | Join the roster |
| `POST` | `/multiplayer/sessions/:id/leave` | Leave |
| `POST` | `/multiplayer/sessions/:id/presence` | Heartbeat / typing |
| `POST` | `/multiplayer/sessions/:id/messages` | Send a message |
| `POST` | `/multiplayer/sessions/:id/interrupt` | Stop the running agent |
| `GET` | `/multiplayer/sessions/:id/approvals` | Pending approvals |
| `POST` | `/multiplayer/approvals/:id/vote` | Approve or deny |
| `GET` | `/multiplayer/sessions/:id/audit` | Audit ledger |

The base path must not start with `/api` — Mastra reserves that prefix.

**`authenticate` is load-bearing.** Whatever it returns is the identity every message, vote, and audit entry is attributed to. It must derive from a verified session, never from the request body, or the four-eyes rule is decorative.

**`authorize` decides whether that identity may act on this session.** It defaults to roster membership — so a participant cannot read a session they have not joined — and receives the route being accessed, so individual capabilities can be gated separately. See [security](./docs/SECURITY.md#session-level-authorization).

## Known limitations

- **Single process.** `EventBus`, `TurnController`, and `InMemoryMultiplayerStore` all hold state in memory, so a second instance splits the room in half. Multi-instance deployments need Redis or Postgres-backed implementations of the same interfaces.
- **Approval expiry is lazy.** Nothing fires on its own; a request expires when someone next votes or refreshes it. Gates that stay open for hours belong in a durable-execution backend (Temporal, Inngest, Restate, Durable Objects), with this package handling the human-facing half.
- **No CRDT layer.** Live cursors and shared document editing are researched, not scheduled.
- **No independent evaluation exists for any of this.** Multiplayer agents are new enough that the failure modes are still being discovered in production, not in benchmarks.

## Documentation

Full docs live in [`docs/`](./docs):
[concepts](./docs/CONCEPTS.md) ·
[architecture](./docs/ARCHITECTURE.md) ·
[API](./docs/API.md) ·
[HTTP & SSE](./docs/HTTP-API.md) ·
[approvals](./docs/APPROVALS.md) ·
[concurrency](./docs/CONCURRENCY.md) ·
[storage](./docs/STORAGE.md) ·
[security](./docs/SECURITY.md) ·
[decision records](./docs/decisions)

## Roadmap

`0.2.0` is about surviving a second process: a Redis-backed `EventBus`,
persisted approval policies, a durable store implementation with a conformance
suite, tests over the HTTP surface, and session-level authorization.

The full list — including what is deliberately out of scope, and why — is in
[`docs/ROADMAP.md`](./docs/ROADMAP.md).

## License

MIT
