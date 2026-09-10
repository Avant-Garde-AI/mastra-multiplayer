# Storage

## What this package stores, and what it does not

`MultiplayerStore` covers only what Mastra does not model:

| Stored here | Stored by Mastra |
| --- | --- |
| Participant roster | Messages |
| Presence | Threads |
| Approval requests, votes, resolutions | Working and semantic memory |
| Audit ledger | Agent run history |

Two storage systems on purpose. Duplicating messages into a second store gives
you two sources of truth and a reconciliation bug —
[ADR 0001](./decisions/0001-two-storage-systems.md).

Nothing enforces that both point at the same database. Pointing them at
different ones is fine, and means a session record and its transcript can be
deleted independently — worth knowing before a data-retention conversation.

## The interface

```ts
interface MultiplayerStore {
  createSession(session: SessionRecord): Promise<void>;
  getSession(id: SessionId): Promise<SessionRecord | null>;
  updateSession(id: SessionId, patch: Partial<Omit<SessionRecord, "id">>): Promise<void>;
  listSessions(): Promise<SessionRecord[]>;

  addParticipant(sessionId: SessionId, participant: Participant): Promise<void>;
  removeParticipant(sessionId: SessionId, participantId: ParticipantId): Promise<void>;
  getParticipant(sessionId: SessionId, participantId: ParticipantId): Promise<Participant | null>;
  listParticipants(sessionId: SessionId): Promise<Participant[]>;

  setPresence(sessionId: SessionId, presence: PresenceState): Promise<void>;
  listPresence(sessionId: SessionId): Promise<PresenceState[]>;
  clearPresence(sessionId: SessionId, participantId: ParticipantId): Promise<void>;

  saveApproval(request: ApprovalRequest): Promise<void>;
  getApproval(id: string): Promise<ApprovalRequest | null>;
  listApprovals(sessionId: SessionId, status?: ApprovalStatus): Promise<ApprovalRequest[]>;

  appendAudit(entry: AuditEntry): Promise<void>;
  listAudit(sessionId: SessionId, limit?: number): Promise<AuditEntry[]>;
}
```

Approvals are keyed globally by id, not scoped under a session — `getApproval`
takes only the id, because a vote arrives at `/approvals/:id/vote` with no
session in the path.

## Implementations that ship

| | Entry point | Use for |
| --- | --- | --- |
| `InMemoryMultiplayerStore` | `@avant-garde-ai/mastra-multiplayer/storage` | Development, tests, single-process demos |
| `LibSQLMultiplayerStore` | `@avant-garde-ai/mastra-multiplayer/storage/libsql` | Deployment on LibSQL/SQLite/Turso |

Both pass the same [conformance suite](#the-conformance-suite).

### `InMemoryMultiplayerStore`

Loses everything on restart and does not work across processes. **Do not ship
it.**

It clones on read and write (`structuredClone` for approvals, shallow spreads
elsewhere) so callers cannot mutate stored state by accident — behaviour a real
implementation gets for free by serializing, and worth matching in any in-memory
cache you put in front of a database.

### `LibSQLMultiplayerStore`

```ts
import { createClient } from "@libsql/client";
import { LibSQLMultiplayerStore } from "@avant-garde-ai/mastra-multiplayer/storage/libsql";

const store = new LibSQLMultiplayerStore(createClient({ url: "file:./mp.db" }));
await store.migrate();   // idempotent; safe on every boot

const multiplayer = createMultiplayer({ agent, store });
```

`@libsql/client` is an **optional peer dependency**, imported by no other module
— installing this package does not pull in a database driver. The client is
passed in rather than constructed, so connection lifetime, auth, and replication
stay yours.

LibSQL first because Mastra already leans on it: a deployment with somewhere to
put threads and messages usually has somewhere to put this too. Turso works
unchanged — it is the same client.

Two shape decisions worth knowing if you adapt it:

- **Approvals are stored as one JSON document**, not normalized into vote rows.
  The gate reads a request, appends a vote, and writes it back as a unit;
  splitting it means `saveApproval` has to reconcile rather than replace.
- **Audit rows carry a `seq` alongside `at`.** Millisecond timestamps collide,
  and a ledger that reorders entries recorded in the same millisecond is not a
  ledger.

**Presence is written to the database here, and probably should not be in
production** — see [below](#presence-is-not-durable-state). The reference
implementation keeps it in one place because being a complete, correct example
matters more than being the deployment you should copy verbatim.

## The conformance suite

The interface has more implicit contract than its type signatures show. So the
checks ship as data, framework-agnostic, with no dependencies:

```ts
import { conformanceChecks } from "@avant-garde-ai/mastra-multiplayer/storage/conformance";

describe("MyPostgresStore", () => {
  for (const check of conformanceChecks()) {
    it(`${check.group} — ${check.name}`, async () => {
      await check.run(await makeFreshStore());
    });
  }
});
```

Each check gets a store with no sessions in it and creates what it needs. They
are plain functions, so vitest, jest, `node:test`, or a bare script all work.

39 checks across six groups — `sessions`, `participants`, `presence`,
`approvals`, `audit`, `isolation` — and each failure message says what the
contract is, not just that two values differed.

Run it before you trust an implementation. It exists because these are the
mistakes that pass code review: a `listAudit` returning the oldest rows instead
of the newest, an `updateSession` that ignores `undefined` and leaves every
session looking busy, an approval whose policy was rebuilt from its name.

## Implementing your own

### Semantics to preserve

- **`updateSession` is a patch,** not a replace, and must refresh `updatedAt`.
  It is called on every run start and finish to maintain `runningRunId`, so it
  is the hottest write in the system.
- **`addParticipant` is an upsert.** Rejoining must not duplicate a roster
  entry, and must update the display name and role.
- **`removeParticipant` clears that participant's presence too.**
- **`setPresence` is an upsert** keyed by `(sessionId, participantId)`.
- **`saveApproval` is an upsert** used for both creation and every vote. Votes
  are stored as an array on the request; if you normalize them into a votes
  table, `saveApproval` has to reconcile rather than append blindly.
- **`ApprovalRequest.policy` must round-trip exactly.** It is the resolved
  governance rule, not a label, and the gate reads it back on every vote. A
  store that drops it, truncates it, or reconstructs it from a name has
  reintroduced the bug it exists to prevent — a four-eyes gate resolving on one
  signature. JSON column, stored verbatim, is the right shape; `allowedRoles`
  and `allowedParticipants` are arrays and must survive as arrays.
- **`listAudit` returns the *most recent* `limit` entries, oldest first within
  that window.** The in-memory version is `slice(-limit)`. A naive
  `ORDER BY at ASC LIMIT n` returns the oldest entries instead — the opposite —
  and the mistake is easy to miss because both return plausible data.
- **`listApprovals` filters by status when given one.**

### Reads are tolerant, writes are not

- **A read against a session that does not exist returns empty or null,** never
  an error. `getSession` → `null`, `getParticipant` → `null`,
  `listParticipants` / `listPresence` / `listAudit` → `[]`. The default
  authorization rule calls `getParticipant` for whatever session id a request
  named, including ids that do not exist; making that throw turns "not a member"
  into an exception every caller has to catch.
- **A write against a session that does not exist rejects.** `addParticipant`,
  `setPresence`, and `appendAudit` against a missing session are caller bugs,
  and surfacing them beats silently dropping the write or conjuring a session.
- **Deletes are idempotent.** `removeParticipant` and `clearPresence` against a
  session or participant that is already gone succeed quietly — that is the
  state the caller wanted.

This split was not in the original interface. Writing the conformance suite
forced the question, and the in-memory store changed to match: it used to throw
on reads too.

### Concurrency

The interface has no transactions, and the two places that need care are:

- **Votes.** `vote()` reads the request, pushes a vote, evaluates, and saves.
  Two simultaneous votes can both read a request with one approval and both
  write a request with two — losing one, or double-counting toward quorum.
  Guard it: optimistic concurrency on a version column, `SELECT … FOR UPDATE`,
  or a conditional write. **This is a correctness issue in a governance
  control**, so it is the first thing to get right in a real implementation.
- **`updateSession`.** Concurrent patches from run start/finish can clobber each
  other. In practice the only contested field is `runningRunId`, and
  `TurnController` allows one run at a time per session per process — so this is
  benign today and becomes real when [R1](./ROADMAP.md#r1--redis-backed-eventbus)
  makes multi-process deployments possible.

### Presence is not durable state

Presence entries are ephemeral by nature — overwritten every heartbeat, swept
constantly. Writing them to your primary database means a write per participant
every ten seconds.

Redis with a TTL slightly above `dropAfterMs` is a better home, and the TTL does
most of the sweeping for you. A hybrid store — Postgres for roster, approvals,
and audit; Redis for presence — is a perfectly reasonable implementation and
the one to reach for first.

### Audit is append-only

Nothing in the interface deletes or updates an audit entry, and nothing should.
The ledger is what answers "who approved the $4,000 refund" months later. Make
the table append-only at the database level if you can, and hold it to whatever
retention your compliance story requires rather than to the session's lifetime.

## Testing an implementation

Run the [conformance suite](#the-conformance-suite). It covers everything on
this page that can be checked mechanically.

What it deliberately does **not** cover, and you should still test yourself:

- **Concurrent votes.** Two simultaneous `vote()` calls on a `quorumOf(2)` gate
  must resolve it exactly once. The suite is single-threaded by construction and
  cannot catch this; it is the most important thing to get right in a real
  store, so it is called out here rather than left implied.
- **Serialization edge cases in your own stack.** A `Date` or a `Map` in
  `metadata` or `toolArgs` round-trips as whatever your serializer produces.
  Decide what that is before a user finds out. Keeping those values plain is
  the easy answer.
- **Scale.** Nothing here says anything about how your store behaves with a
  hundred thousand audit rows.
