# API reference

Every exported symbol, by entry point. Types are in
[`src/types.ts`](../src/types.ts) and re-exported from the root.

| Entry point | Contains |
| --- | --- |
| `mastra-multiplayer` | Session, approvals, concurrency, presence, attribution, bus, types |
| `mastra-multiplayer/server` | `multiplayerRoutes` and its types |
| `mastra-multiplayer/client` | `MultiplayerClient` |
| `mastra-multiplayer/client/react` | `useMultiplayerSession` |
| `mastra-multiplayer/storage` | `MultiplayerStore`, `InMemoryMultiplayerStore` |
| `mastra-multiplayer/storage/conformance` | `conformanceChecks`, `conformanceGroups` |
| `mastra-multiplayer/storage/libsql` | `LibSQLMultiplayerStore` |

Peer dependencies `@mastra/core` and `react` are both optional. Nothing in
`src/` imports either — Mastra and Hono types are declared structurally
(`AgentLike`, `HonoLikeContext`), so the core primitives compile and test
without them installed.

## `createMultiplayer(options)` → `MultiplayerSession`

```ts
interface MultiplayerOptions {
  agent: AgentLike;
  agentId?: string;
  store?: MultiplayerStore;          // default InMemoryMultiplayerStore
  bus?: EventBusOptions;
  presence?: PresenceOptions;
  concurrency?: TurnControllerOptions;
  defaultApprovalPolicy?: ApprovalPolicy;
  buildStreamOptions?: (context: TurnContext) => Record<string, unknown>;
}
```

`AgentLike` is the slice of a Mastra agent this package uses:

```ts
interface AgentLike {
  id?: string;
  name?: string;
  instructions?: string;
  stream(input: string, options?: Record<string, unknown>):
    Promise<{ textStream: AsyncIterable<string> }>;
}
```

A real `Agent` satisfies it, and so does a fake — which is how the tests run
without a model.

`buildStreamOptions` is merged over the defaults, so it can override memory
scoping, runtime context, or tool selection per turn:

```ts
buildStreamOptions: ({ session, participants, signal }) => ({
  runtimeContext: new RuntimeContext([["sessionId", session.id]]),
  abortSignal: signal,
})
```

### `MultiplayerSession`

Public fields: `bus`, `store`, `presence`, `approvals`, `turns` — composition
over inheritance, so each piece is usable on its own.

| Method | Notes |
| --- | --- |
| `createSession({ threadId, title?, id?, metadata? })` | → `SessionRecord`. Audits `session.created`. |
| `join(sessionId, participant)` | → `Participant[]`. Publishes `participant.joined` and records a first heartbeat. |
| `leave(sessionId, participantId)` | Clears presence, removes from roster, audits. |
| `send({ sessionId, participantId, text, addressedToAgent?, metadata? })` | Broadcasts to the room, then submits to `TurnController` unless `addressedToAgent` is false. |
| `interrupt(sessionId, participantId)` | Aborts the run and clears the queue. Not role-gated. |

What a turn does, in order: label the batch by author, append `rosterPrompt()`
to the agent's instructions, call `agent.stream`, republish each delta as
`agent.delta`, then publish the assembled text as one `message` event.

## Approvals

`ApprovalGate` — `request`, `vote`, `refresh`, `assertBinding`, `pending`.
Reached as `multiplayer.approvals`.

`ApprovalError` carries `code`: `not_found` · `not_eligible` ·
`already_resolved` · `binding_mismatch`.

Policies: `ApprovalPolicy`, `DEFAULT_POLICY`, `ResolvedPolicy`, `mergePolicy`,
`fourEyes`, `quorumOf`, `approverOnly`.

`ApprovalPolicy` and `ResolvedPolicy` are declared in `types.ts` and re-exported
here, because every `ApprovalRequest` carries a `ResolvedPolicy` and the record
has to describe itself without importing the module that builds it.

Pure helpers, safe on the client: `canVote`, `evaluate`, `remainingApprovals`,
`bindingHashFor`.

Full treatment in [APPROVALS](./APPROVALS.md).

## Concurrency

`TurnController` — `submit`, `interrupt`, `signalFor`, `isRunning`,
`queueDepth`. Reached as `multiplayer.turns`.

```ts
interface TurnControllerOptions {
  mode?: ConcurrencyMode;  // "queue" | "debounce" | "batch" | "skip" | "preempt"
  windowMs?: number;       // default 1500
  maxBatchSize?: number;   // default 10
}
```

Mode selection matters more than the API: [CONCURRENCY](./CONCURRENCY.md).

## Presence

`PresenceManager` — reached as `multiplayer.presence`.

```ts
interface PresenceOptions {
  idleAfterMs?: number;      // default 30_000
  dropAfterMs?: number;      // default 90_000
  sweepIntervalMs?: number;  // default 10_000
  now?: () => number;        // injected for tests
}
```

| Method | Notes |
| --- | --- |
| `heartbeat(sessionId, participantId, status?, cursor?)` | Records a check-in, broadcasts `presence.updated`. |
| `setTyping(sessionId, participantId, typing)` | Sugar over `heartbeat`. |
| `leave(sessionId, participantId)` | **Departure.** Publishes `participant.left`. |
| `disconnected(sessionId, participantId)` | **Dropped transport.** Clears presence only — the roster is untouched. |
| `sweep(sessionId)` | → dropped ids. Ages `active → idle → dropped`. |
| `startSweeping()` / `stopSweeping()` | Background sweep across all sessions. The timer is `unref`'d, so it will not hold the process open. |

`leave` and `disconnected` are different on purpose; see
[CONCEPTS](./CONCEPTS.md#roster-vs-presence).

## Attribution

- `labelMessage(message, participants, options?)` → `"[Alice]: text"`
- `labelBatch(messages, participants, options?)` → newline-joined
- `rosterPrompt(participants)` → the system-prompt fragment (empty string for
  an empty roster)
- `withMultiplayerContext(baseInstructions, participants)` → both, joined

`AttributionOptions.format` replaces the label format. An unknown author is
rendered unlabelled rather than guessed at.

## Event bus

`EventBus` — `publish`, `subscribe` (→ unsubscribe fn), `replay(sessionId,
afterSeq?)`, `currentSeq(sessionId)`, `subscriberCount`, `clear`.

`EventBusOptions.replayBufferSize` defaults to 200; `0` disables replay while
sequencing continues.

`publish` assigns the sequence, buffers, and fans out. A subscriber that throws
is logged and does not stop delivery to the others.

Event shapes: [HTTP-API](./HTTP-API.md#event-frames).

## Server

`multiplayerRoutes(session, { basePath?, authenticate, authorize? })` →
`RouteDefinition[]`.

`authenticate` establishes identity (401 on null); `authorize` establishes
access (403 on false), defaulting to roster membership with `join` exempted.
Also exported: `MultiplayerAction`, `AuthorizeInput`, `MultiplayerRoutesOptions`,
`HonoLikeContext`, `RouteDefinition`.

See [HTTP-API](./HTTP-API.md) and [SECURITY](./SECURITY.md#session-level-authorization).

## Client

`MultiplayerClient`:

| Method | Notes |
| --- | --- |
| `start()` | join → hydrate → connect, in the order that avoids the races. **Use this.** |
| `join()` / `hydrate()` / `connect()` / `disconnect()` | The pieces, if you need them separately. |
| `send(text, addressedToAgent?)` | |
| `setTyping(typing)` / `interrupt()` | |
| `vote(approvalId, decision, reason?)` | |
| `subscribe(listener)` | Fires immediately with current state; returns an unsubscribe fn. |
| `getState()` | |

```ts
interface MultiplayerClientState {
  connected: boolean;
  participants: Participant[];
  presence: PresenceState[];
  approvals: ApprovalRequest[];
  messages: Array<{ participantId: string | null; text: string; fromAgent: boolean; at: number }>;
  streaming: string | null;   // text of the run currently streaming
  agentRunning: boolean;
}
```

`messages` accumulates only what arrived over this connection. For the full
transcript, read Mastra's thread.

Options: `baseUrl`, `basePath` (default `/multiplayer`), `sessionId`, `headers`,
`heartbeatMs` (10s), `maxBackoffMs` (15s). Reconnect is exponential with jitter.

Note `headers` does not reach the SSE stream —
[why](./HTTP-API.md#bearer-tokens-do-not-work-on-the-stream).

### `useMultiplayerSession(options)`

Headless React hook over `MultiplayerClient`, on `useSyncExternalStore`. Returns
the client state plus `send`, `setTyping`, `interrupt`, `vote`, and `client`.

It calls `start()` on mount and `disconnect()` on unmount. The client is created
once from the options given on first render — **changing `sessionId` later does
not reconnect it.** Remount with a `key` when the session changes.

## Storage

`MultiplayerStore` (interface), `InMemoryMultiplayerStore` (development),
`LibSQLMultiplayerStore` (durable).

```ts
const store = new LibSQLMultiplayerStore(createClient({ url: "file:./mp.db" }));
await store.migrate();   // idempotent
```

`@libsql/client` is an optional peer dependency, imported by that subpath alone.
`LibSQLLikeClient` is declared structurally, so a real `Client` satisfies it
without this package depending on the driver.

`conformanceChecks()` → `ConformanceCheck[]`, each `{ group, name, run(store) }`.
Framework-agnostic and dependency-free; drive them from whatever test runner you
use. `conformanceGroups()` lists the group names.

[STORAGE](./STORAGE.md) covers implementing the interface and what the suite
does not check.
