# Changelog

## 0.1.0 — unreleased

Initial scaffold.

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

### Fixed (approvals)
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

### Known gaps
- Single-process bus and store.
- No CRDT/co-editing layer.

See [docs/ROADMAP.md](./docs/ROADMAP.md).
