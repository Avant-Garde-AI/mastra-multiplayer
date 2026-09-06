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

## `InMemoryMultiplayerStore`

Ships for development, tests, and single-process demos. It loses everything on
restart and does not work across processes. **Do not ship it.**

It clones on read and write (`structuredClone` for approvals, shallow spreads
elsewhere) so callers cannot mutate stored state by accident — behaviour a real
implementation gets for free by serializing, and worth matching in any in-memory
cache you put in front of a database.

It also throws `Unknown session` for operations on a session that does not
exist, rather than silently creating one. Match that.

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
- **Return `null`, do not throw,** for a missing session, participant, or
  approval.

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

Until the shared conformance suite lands
([R3](./ROADMAP.md#r3--store-backed-multiplayerstore-reference-implementation)),
the cheapest check is to run this package's own test suite against your store —
the tests construct `InMemoryMultiplayerStore` directly, so swapping it proves
roster, presence, approval, and audit behaviour end to end.

Cases worth adding beyond that, because they are where real implementations
diverge:

- Rejoining does not duplicate a roster entry, and does update the display name.
- `listAudit(id, 5)` on 100 entries returns entries 96–100, oldest first.
- Two concurrent `vote()` calls on a `quorumOf(2)` gate resolve it exactly once.
- A `structuredClone`-hostile value in `metadata` or `toolArgs` (a `Date`, a
  `Map`) round-trips as whatever your serializer produces — decide what that is
  before a user finds out.
