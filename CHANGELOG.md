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
- Approval policies are not persisted across restarts.
- `authenticate` establishes identity but not session membership.
- No CRDT/co-editing layer.

See [docs/ROADMAP.md](./docs/ROADMAP.md).
