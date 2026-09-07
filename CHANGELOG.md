# Changelog

All notable changes to this package. Dates are the day the work landed on
`main`.

## Unreleased

### Channels
- `mastra-multiplayer/channels` maps a Mastra channel actor onto a
  `Participant`, so a session can span a web UI and a Slack thread with one
  roster (`R7`). `channelParticipant` is the pure mapping; `ChannelBridge`
  joins the sender and forwards the message.

  No chat SDK dependency — Mastra's `@chat-adapter/*` packages belong to the
  host's agent. Ids are prefixed with the surface (an unprefixed collision
  between platforms would merge two people into one participant, silently
  weakening four-eyes), bots are excluded by default including
  `isBot: "unknown"`, and joining happens on arrival and on change rather than
  per message.

- `ParticipantSurface` now accepts any string, and its named members match the
  platforms Mastra actually ships adapters for. It previously named `linear`,
  which has no adapter, and omitted `telegram`, `whatsapp` and `imessage`.
  Widening only — existing values still typecheck.

## 0.3.0 — 2026-09-06

**The first published release.** `0.1.0` and `0.2.0` below are development
milestones that were never put on npm; they are kept because the roadmap,
commits and decision records refer to them by name, and because the breaking
changes between them are what an early adopter reading this needs.

Theme: **operability** — behaving correctly with more than one instance
running, and running unattended.

### Concurrency
- **`interrupt()` now stops a run owned by another instance** (`R14`). It
  aborted only locally while still publishing `agent.run.interrupted`, so every
  client showed the run stopped while the agent kept streaming. A run in flight
  now listens for that event for its duration. On by default, no lease needed.
- `TurnLease` makes "one run at a time per session" hold across processes.
  `RedisTurnLease` (`mastra-multiplayer/concurrency/redis-lease`) uses
  `SET NX PX` with ownership-checked renew and release; `InMemoryTurnLease`
  ships for tests. Optional via `concurrency: { lease }` — without it, two
  people posting to different instances at the same moment start two concurrent
  runs into one session.

  A lost lease aborts the run rather than continuing, and a lease backend that
  is unreachable stops turns rather than degrading to "run anyway". Both are
  documented in `docs/CONCURRENCY.md`.

### HTTP
- **Backpressure on the SSE stream** (`R9`). `controller.enqueue` never blocks,
  so a client that stops reading grew the server's queue without bound. Once
  `streamHighWaterMark` frames (default 256) sit unsent, `agent.delta` is
  dropped — the terminal `message` carries the assembled text — and anything
  else closes the stream, so the client reconnects and replays from
  `Last-Event-ID`.

### Approvals
- `approvals.sweepExpired(sessionId)` and `sweepExpiredApprovals()` resolve
  requests past their deadline (`R8`). Nothing fires on its own; call one from
  your own scheduler. No timer ships in this package.
- **`resolvedAt` is now the deadline, not the sweep time.** A request that
  expired at 3am records 3am even if nothing noticed until 9am. The same holds
  for a vote that lands after expiry.

### Logging
- A `Logger` seam (`R10`): `createMultiplayer({ logger })` is threaded to the
  bus, presence manager, approval gate, and turn controller. `consoleLogger` is
  the default, `silentLogger` discards. Every `console.error` in `src/` is gone,
  and a host logger that throws cannot break the caller.

## 0.2.0 — 2026-09-06

Theme: **surviving a second process.** Everything before this assumed one Node
process holding all state in memory.

### Event bus
- `RedisEventBus` (`mastra-multiplayer/bus/redis`) — a shared bus for
  deployments running more than one process (`R1`). `ioredis` is an optional
  peer dependency; clients are passed in and typed structurally.
- New `MultiplayerBus` interface, implemented by both `EventBus` and
  `RedisEventBus`. `createMultiplayer({ bus })` accepts either options for the
  in-process bus or a bus instance.
- New `subscribeFrom(sessionId, afterSeq, handler)`: replay and subscribe with
  no gap. Replay-then-subscribe drops what lands in between;
  subscribe-then-replay delivers live events ahead of older ones, which a client
  tracking its highest sequence discards as stale.

  **Breaking:** `publish`, `replay`, `currentSeq`, and `clear` are now async.
  A synchronous `publish` would have forced fire-and-forget sequence
  allocation across processes, and two instances minting the same `seq` makes
  clients silently drop real events. `await` them; the SSE route now uses
  `subscribeFrom`.

### Storage
- `LibSQLMultiplayerStore` (`mastra-multiplayer/storage/libsql`) — a durable
  store on LibSQL/SQLite/Turso (`R3`). `@libsql/client` is an optional peer
  dependency imported by that subpath alone; the core stays dependency-free.
- A conformance suite (`mastra-multiplayer/storage/conformance`) — 38
  framework-agnostic checks any `MultiplayerStore` implementation can run, with
  no test-framework dependency.
- **Contract clarified:** reads against an unknown session return empty or null,
  writes reject, deletes are idempotent. `InMemoryMultiplayerStore` previously
  threw on reads of an unknown session and now returns empty. Found by running
  the conformance suite against it.

### Approvals
- **Approval policies are persisted on the request** (`R2`).
  `ApprovalRequest.policy` carries the resolved policy — every defaultable
  field filled in — and `vote()`/`refresh()` read from it. The process-local
  `Map` is gone.

  Previously a restart mid-approval dropped the policy and the gate fell back
  to the default: a four-eyes gate silently became a one-signature gate across
  a deploy. Storing the *resolved* policy also means a later release changing a
  default cannot retroactively change a pending gate, and the audit ledger
  carries the rule that was applied rather than just its name.

  **Breaking:** `ApprovalRequest.policyName` is removed — use `policy.name`.
  Custom `MultiplayerStore` implementations must round-trip `policy` verbatim.

  `ApprovalPolicy` and `ResolvedPolicy` moved to `types.ts` and are re-exported
  from `approvals/policy.js`; imports are unaffected.

### Fixed
- `canVote` consulted `allowedParticipants` on the caller's raw policy rather
  than the resolved one. Harmless while the raw object was the input; a live
  bug once the resolved policy became it.

### Security
- `multiplayerRoutes` takes an optional `authorize({ participant, sessionId,
  action, context })`, run on every route after `authenticate` (`R5`).
  Previously `authenticate` established identity and nothing established
  membership, so any authenticated participant could pass any `sessionId` and
  read that session's stream, roster, approvals, and audit ledger — a
  cross-tenant read in any multi-customer product.

  Defaults to roster membership, exempting `join`. Identity failure is 401;
  access failure is 403 with `code: "not_a_member"`. `action` names the route,
  so capabilities can be gated individually. `vote` resolves its session from
  the stored approval, never from the request.

  **Behaviour change:** an unknown session now returns 403 rather than 404,
  because authorization runs before the session is loaded — the old 404 was an
  existence oracle. `GET /state` still 404s once authorization has passed.

  **Breaking for custom integrations only** if you relied on any authenticated
  identity reaching any session. That was the bug.

### Testing and CI
- GitHub Actions runs `npm run check` and `npm run build` on Node 20 and 22 for
  every push to `main` and every pull request (`R13`).
- `scripts/check-exports.mjs` verifies every path in the `exports` map exists
  after a build, and that each subpath carries a `types` condition. The tests
  import from `src/`, so a broken published surface was previously invisible.
- 52 tests over the HTTP surface and the browser client (`R4`), on a fake Hono
  context and a fake `EventSource` — routes, SSE framing and replay, auth
  rejection, vote error codes, the client reducer, reconnect backoff, and
  heartbeat lifecycle.

### Packaging
- Added `repository`, `homepage`, `bugs`, `publishConfig`, and a
  `"./package.json"` export.
- `CHANGELOG.md` is now published (`files`).
- Removed `.npmignore`, which npm ignores when `files` is present.

## 0.1.0 — 2026-09-06 (unpublished)

The initial scaffold, plus the defects found reviewing it.

### Added
- `MultiplayerSession` — shared session bound to a Mastra thread, with a
  participant roster and audit ledger.
- `PresenceManager` — heartbeat-based presence with idle and drop windows,
  typing state, and background sweeping.
- `ApprovalGate` + policy engine — four-eyes, n-of-m quorum, role gating,
  argument-bound approvals, deny-is-final, deny-on-expiry.
- `TurnController` — `queue`, `debounce`, `batch`, `skip`, `preempt` modes for
  concurrent human input, with `AbortSignal` propagation.
- `EventBus` — sequenced per-session pub/sub with a bounded replay buffer.
- Attribution helpers — speaker labelling and roster system-prompt injection.
- `multiplayerRoutes()` — SSE stream plus join/leave/presence/messages/
  interrupt/approvals/audit endpoints for `registerApiRoute`.
- `MultiplayerClient` and `useMultiplayerSession` — browser client with
  reconnect-from-sequence, and a headless React hook.
- `InMemoryMultiplayerStore` for development and tests.

### Fixed
- A closed SSE stream no longer publishes `participant.left`. A stream closes on
  every reconnect and tab switch, which was evicting people from everyone else's
  roster while they were still in the session. `PresenceManager.disconnected()`
  clears presence and leaves the roster alone; `leave()` is unchanged.
- `GET /sessions/:id/state` and `MultiplayerClient.hydrate()` — a client opening
  a session that had been running longer than the replay buffer rendered an
  empty room, with open approval gates invisible. `MultiplayerClient.start()`
  sequences join → hydrate → connect.
- Policy resolution ignores explicitly-`undefined` overrides. Building a policy
  from optional config previously let `undefined` replace a default: `quorum`
  made the gate unapprovable, `denyIsFinal` stopped a deny resolving it, and
  `allowedRoles` threw in `canVote`.

## Upgrading

Nothing published before `0.3.0`, so there is nothing to migrate from. The
breaking changes recorded above are between development milestones, and are
listed for anyone tracking `main`:

| Change | Since | What to do |
| --- | --- | --- |
| `publish`, `replay`, `currentSeq`, `clear` are async | `0.2.0` | `await` them. Use `subscribeFrom` in place of replay-then-subscribe. |
| `ApprovalRequest.policyName` removed | `0.2.0` | Use `policy.name`. |
| Custom `MultiplayerStore` must round-trip `policy` | `0.2.0` | Store it verbatim; run the [conformance suite](./docs/STORAGE.md#the-conformance-suite). |
| Store reads of an unknown session return empty, writes reject | `0.2.0` | Match it, or run the conformance suite and let it tell you. |
| An unknown session returns `403`, not `404` | `0.2.0` | Expect `403` — authorization runs before the session is loaded. |

## Known gaps

- Turn-taking is per-process unless you configure a `TurnLease`. Without one,
  concurrent posts to different instances start two runs into one session.
- Nothing drives approval expiry for you — wire `sweepExpiredApprovals()` into
  a scheduler you already run.
- No CRDT/co-editing layer.
- No independent evaluation of any of this. Multiplayer agents are new enough
  that the failure modes are still being found in production, not in benchmarks.

See [docs/ROADMAP.md](./docs/ROADMAP.md).
