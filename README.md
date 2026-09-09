# mastra-multiplayer

Multiplayer primitives for [Mastra](https://mastra.ai) agents: **many humans in one agent session**.

Mastra already handles the channel side of this well — the Signal API gives you concurrency modes for interleaved messages, and Channels puts an agent into Slack, Discord, Teams, GitHub, Telegram and more. What it does not ship is the layer you need when the shared session lives in *your own product UI*: presence, per-participant attribution, multi-approver gates, and an audit trail of who asked for what.

That is what this package is.

> Status: `0.4.0`. Pre-1.0 — the API will change, and breaking changes are recorded in the [changelog](./CHANGELOG.md). Not affiliated with the Mastra team.

## What "multiplayer" means here

Multiplayer is **multi-human**, not multi-agent. One agent and four people in a shared session is multiplayer. Twenty agents and one person reading a log is not.

The distinction matters because the hard problems are entirely different. Multi-agent is a routing and orchestration problem. Multiplayer is a *social* problem that happens to be implemented in TypeScript: whose instruction wins when two people disagree, who is allowed to approve a destructive action, what the model should be told about the room it is speaking to.

## Install

```bash
npm install mastra-multiplayer
```

Every peer dependency is optional — a bare install pulls in no runtime dependencies at all, and the core primitives work without any of them:

| | Needed for |
| --- | --- |
| `@mastra/core` | The agent itself, and the server routes |
| `react` | `useMultiplayerSession` |
| `@libsql/client` | `LibSQLMultiplayerStore` |
| `ioredis` | `RedisEventBus`, `RedisTurnLease` |

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
- **A gate can be a workflow step rather than a wait.** `approvalStep` suspends a Mastra run and `ApprovalResumer` wakes it when the votes land, so nothing holds an agent run open and a deploy mid-decision costs nothing. [Details](./docs/APPROVALS.md#gates-as-workflow-steps).

### 3. Shared-session event bus

A sequenced, per-session pub/sub with a replay buffer. Clients reconnect with `Last-Event-ID` and receive only what they missed, rather than replaying the whole session or silently dropping events.

`EventBus` runs in one process. For a deployment behind a load balancer, swap in `RedisEventBus` and every instance shares the room:

```ts
import { RedisEventBus } from "mastra-multiplayer/bus/redis";

createMultiplayer({
  agent,
  store,
  bus: new RedisEventBus({ client: new Redis(url), subscriber: new Redis(url) }),
});
```

Sequencing, not fan-out, is the hard part: clients discard events at or below the highest sequence they have seen, so two instances minting the same number would make them throw away real events while believing they were duplicates. The sequence comes from a Redis `INCR` inside the same script that records and publishes.

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

## Channels: one session, many surfaces

A session can span your web UI and a Slack thread. Everyone lands in the same roster, is labelled by name in the prompt the agent sees, and can vote on an approval:

```ts
import { channelBridge } from "mastra-multiplayer/channels";

const bridge = channelBridge(multiplayer, {
  resolveSession: ({ threadId }) => sessionForThread(threadId),
  role: ({ actor }) => (approvers.has(actor.userId) ? "approver" : "editor"),
});

await bridge.receive({ surface: "slack", actor, threadId, text });
```

No chat SDK involved — Mastra's `@chat-adapter/*` packages belong to your agent, and this is the mapping between its `actor` and a `Participant`. Bots are excluded by default, because one appearing in the roster could satisfy a four-eyes gate. [Details](./docs/CHANNELS.md).

## Approval gates as workflow steps

A gate that waits inside a tool holds an agent run open for as long as the humans take, and loses the wait if the process restarts. A suspended workflow step does neither:

```ts
import { createStep } from "@mastra/core/workflows";
import { approvalStep, approvalResumer } from "mastra-multiplayer/workflows";

const gate = createStep(approvalStep(multiplayer, {
  id: "approve-refund",
  inputSchema: refundArgs,
  outputSchema: refundArgs,
  workflowId: "refund",
  toolName: "refund-order",
  policy: fourEyes(),
  sessionId: ({ inputData }) => inputData.sessionId,
  requestedBy: ({ inputData }) => inputData.requestedBy,
  summary: ({ inputData }) => `Refund $${inputData.amountCents / 100}`,
}));

await approvalResumer(multiplayer, mastra).start();
```

The step opens a request and suspends. Whenever the votes land — a minute later, or after a deploy — the resumer wakes the run, `assertBinding()` re-checks the arguments, and the next step executes. A denial bails the run instead.

**The resumer is the half that is easy to forget.** Votes arrive over this package's HTTP surface and workflows continue through `run.resume()`; without something joining them, every gate suspends for ever. `start()` listens for decisions made in this process *and* reconciles the store for anything decided while nothing was listening. [Details](./docs/APPROVALS.md#gates-as-workflow-steps).

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

Two implementations ship: `InMemoryMultiplayerStore` for development and tests (it loses everything on restart), and `LibSQLMultiplayerStore` for deployment on LibSQL, SQLite, or Turso.

```ts
import { LibSQLMultiplayerStore } from "mastra-multiplayer/storage/libsql";

const store = new LibSQLMultiplayerStore(createClient({ url: "file:./mp.db" }));
await store.migrate();
```

Writing your own? Run the conformance suite against it — 39 framework-agnostic checks covering the parts of the contract the type signatures do not show:

```ts
import { conformanceChecks } from "mastra-multiplayer/storage/conformance";

for (const check of conformanceChecks()) {
  it(`${check.group} — ${check.name}`, () => check.run(makeFreshStore()));
}
```

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

- **Turn-taking is per-process unless you give it a lease.** `TurnController` enforces one run at a time with an in-memory flag, so without a `TurnLease` two people posting to different instances at the same moment start two concurrent runs into one session. Pass `RedisTurnLease`, or use session affinity at the load balancer. (`interrupt()` is *not* in this category — it has crossed instances since `0.3.0`, with no lease needed.)
- **Nothing drives approval expiry for you.** `sweepExpiredApprovals()` resolves what is past its deadline; wire it into a scheduler you already run. This matters more with workflow gates: an expired gate has to wake its suspended run, and nothing else will. Gates that stay open for hours or days across deploys belong in a durable-execution backend (Temporal, Inngest, Restate, Durable Objects), with this package handling the human-facing half.
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
[channels](./docs/CHANNELS.md) ·
[storage](./docs/STORAGE.md) ·
[security](./docs/SECURITY.md) ·
[decision records](./docs/decisions) ·
[releasing](./docs/RELEASING.md)

## Running more than one instance

`EventBus` and `InMemoryMultiplayerStore` are single-process. For a deployment behind a load balancer, swap in the durable implementations — everything else is unchanged:

```ts
createMultiplayer({
  agent,
  store: new LibSQLMultiplayerStore(createClient({ url })),
  bus: new RedisEventBus({ client: new Redis(url), subscriber: new Redis(url) }),
  concurrency: { lease: new RedisTurnLease(new Redis(url)) },
  logger,
});
```

The lease is what keeps "one agent run at a time per session" true across processes; without it, two people posting to different instances start two concurrent runs. [Details](./docs/CONCURRENCY.md#running-on-more-than-one-instance).

Two things you drive yourself: `sweepExpiredApprovals()` from your own scheduler (nothing here owns a timer), and `authorize` if roster membership is not the access rule you want.

## Roadmap

`0.3.0` shipped the correctness work: tested and authorized HTTP surface, durable storage with a conformance suite, a distributed event bus and turn lease, backpressure, and a logger seam.

**`0.4.0` was about integration, and shipped both items:** channel participants (above), and approval gates as real Mastra workflow steps. The [plan](./docs/roadmap/0.4.0-integration.md) was grounded in [research against Mastra's actual APIs](./docs/roadmap/research/2026-09-07-mastra-apis.md), which changed both items — and the gates were then built and tested against a *published* `@mastra/core`, not the monorepo version the research read.

**Nothing is scheduled after `0.4.0` yet.** The board — including the candidate pool, and what is deliberately out of scope and why — is [`docs/ROADMAP.md`](./docs/ROADMAP.md).

## License

MIT
