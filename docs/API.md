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
| `mastra-multiplayer/bus/redis` | `RedisEventBus` |
| `mastra-multiplayer/concurrency/redis-lease` | `RedisTurnLease` |

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
  bus?: EventBusOptions | MultiplayerBus;
  presence?: PresenceOptions;
  concurrency?: TurnControllerOptions;
  defaultApprovalPolicy?: ApprovalPolicy;
  logger?: Logger;         // set once; every piece it builds uses it
  // `bus` takes either options for the in-process bus, or a bus instance.
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
  lease?: TurnLease;       // makes one-run-at-a-time hold across processes
  leaseTtlMs?: number;     // default 30_000
  leaseRenewMs?: number;   // default ttl / 3
  leaseRetryMs?: number;   // default 250
  logger?: Logger;
}
```

`TurnLease` — `acquire`, `renew`, `release`, all keyed by `(sessionId, holder)`.
`InMemoryTurnLease` ships for tests; `RedisTurnLease` for deployment. `renew`
returning **false means the lease was lost**, which aborts the run.

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

`MultiplayerBus` is the interface; `EventBus` (in-process) and `RedisEventBus`
(multi-process) implement it.

| Method | Notes |
| --- | --- |
| `publish(input)` | → `Promise<MultiplayerEvent>`. Assigns the sequence, records for replay, fans out. |
| `subscribe(sessionId, handler)` | → unsubscribe fn. **Synchronous return**, so teardown paths that cannot await still work. |
| `subscribeFrom(sessionId, afterSeq, handler)` | → `Promise<unsubscribe>`. Replay and subscribe with no gap. **Use this** to resume a client. |
| `replay(sessionId, afterSeq?)` | → `Promise<MultiplayerEvent[]>`, oldest first. |
| `currentSeq(sessionId)` | → `Promise<number>`. What a snapshot is consistent with. |
| `subscriberCount(sessionId)` | Local count. Never a cluster-wide total. |
| `clear(sessionId)` | → `Promise<void>`. |

Everything that could need a round trip is async, `publish` included — a bus
that allocated sequences without awaiting could hand two events the same `seq`
across processes, and clients would silently drop half of what they were sent.

`replayBufferSize` defaults to 200 on both; `0` disables replay while sequencing
continues. A subscriber that throws is logged and does not stop delivery to the
others.

### `RedisEventBus`

```ts
import { Redis } from "ioredis";
import { RedisEventBus } from "mastra-multiplayer/bus/redis";

const bus = new RedisEventBus({
  client: new Redis(url),
  subscriber: new Redis(url),   // must be a separate connection
  keyPrefix: "mp",              // default
  replayBufferSize: 200,        // default
  onError: (error, context) => log.warn({ error, context }),
});
```

`subscriber` must be its own connection — Redis refuses ordinary commands on a
connection that has subscribed, so passing the same client twice deadlocks the
first time anything is published.

`ioredis` is an optional peer dependency, imported by nothing: the clients are
passed in and typed structurally (`RedisLikeClient`, `RedisLikeSubscriber`), so
any client of the same shape works.

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

## Logging

`Logger` is a four-method interface (`debug`, `info`, `warn`, `error`), each
taking a message and an optional context object. `consoleLogger` is the default;
`silentLogger` discards everything.

Set it once on `createMultiplayer({ logger })` and the bus, presence manager,
approval gate, and turn controller all use it. A logger that throws cannot break
the caller — publishing an event should not fail because shipping a log line
did.

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
