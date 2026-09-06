# Roadmap

Last gardened: 2026-09-06 · against `0.1.0` · Phase 0 and R4 shipped

This is a *gardened* roadmap, not a wish list. Every item names the problem it
solves, what "done" looks like, and roughly what it costs. Items that stop being
true get deleted rather than left to rot — a roadmap nobody prunes is
indistinguishable from a backlog nobody reads.

## How to read this

**Status**

| | |
| --- | --- |
| `shipped` | On `main`, covered by a test, documented. |
| `next` | Committed for the named release. Design settled. |
| `later` | Wanted, not scheduled. Design not settled. |
| `researching` | We do not yet know what the right answer is. |
| `dropped` | Considered and rejected. Kept with the reason, so it stays rejected. |

**Size** — `S` under a day · `M` a few days · `L` a week or more · `XL` needs
splitting before anyone starts.

**Confidence** — how sure we are the item is the *right thing to build*, as
opposed to how sure we are it can be built. Low-confidence items should not be
scheduled.

## Now — the `0.2.0` milestone

The theme is **surviving a second process**. Everything in `0.1.0` assumes one
Node process holding all state in memory. That is fine for a demo and fatal for
a deploy, and it is the single thing most likely to make an early adopter
abandon the package.

### Sequencing

The six items are not independent, and the dependencies run in one direction —
so the order below is not a preference, it is the order that avoids rework.

| Phase | Items | Theme | Ships when |
| --- | --- | --- | --- |
| **0 · Baseline** | R13 | Something enforces green | CI runs `check` and `build` on every push |
| **1 · Harden the edge** | R4 → R5 | The HTTP surface stops being untested and unauthorized | Routes are covered, and a participant cannot read a session they are not in |
| **2 · Durability** | R2 → R3 | State survives a restart | A four-eyes gate resolves correctly across a deploy, against a real database |
| **3 · Distribution** | R1 | State survives a *second process* | Two instances share one room |

Why this order and not another:

- **R13 first because everything downstream assumes a green baseline** that
  nothing currently enforces. It is an afternoon and it makes every later claim
  checkable.
- **R4 before R5** because R4 builds the fake-Hono-context harness, and R5
  changes every route in the file. Writing the authorization tests without that
  harness means building it anyway, under pressure, as part of a security
  change. Tests first, then the change they protect.
- **R5 before R2/R3** because it is the highest-severity gap — a cross-tenant
  read in any multi-customer product — and it is self-contained. Nothing else
  in the milestone depends on it, so it is the one item that could be pulled
  forward if the calendar demands, at the cost of testing it by hand.
- **R2 before R3** because R2 settles the shape of `ApprovalRequest` (the
  resolved policy moves onto the record), and R3 builds a store plus a
  conformance suite against that shape. Reversed, the conformance suite is
  written twice.
- **R1 last** because it is the largest, the riskiest, and the one that
  benefits most from everything above existing. It is also the only item that
  adds infrastructure a consumer has to run.

Phases 0–2 need no new infrastructure. Phase 3 introduces Redis, which is why
it is a boundary rather than just the next item — a deployment that stops at
the end of Phase 2 is a coherent, shippable single-instance product with a
tested, authorized, durable surface.

### R1 · Redis-backed `EventBus`

`next` · size `L` · confidence `high`

**Problem.** `EventBus` fans out in-process. Behind two server instances, a
message published on instance A never reaches the SSE stream held open on
instance B. Half the room sees the conversation.

**Done when** a `RedisEventBus` implements `publish` / `subscribe` / `replay` /
`currentSeq`, sequence numbers are allocated atomically per session
(`INCR`, not read-modify-write), the replay buffer lives in a capped Redis list,
and a test runs two bus instances against one Redis and asserts an event
published on one arrives in order on the other.

**Notes.** The interface was designed for this — nothing outside
`src/bus/` depends on the implementation. The hard part is sequencing, not
fan-out: seq must be allocated by Redis or two instances will mint the same
number and clients will silently drop half the events.

### R2 · Persisted approval policies

`next` · size `M` · confidence `high`

**Problem.** `ApprovalGate` holds policies in a private `Map` keyed by approval
id. Restart the process mid-approval and the policy is gone; the gate falls back
to the default, which is `quorum: 1`. A four-eyes gate quietly becomes a
one-signature gate across a deploy. This is a governance bug, not an
inconvenience.

**Done when** the resolved policy is stored on the `ApprovalRequest` itself, the
store round-trips it, `vote()` and `refresh()` read it from the request rather
than the in-memory map, and a test resolves a four-eyes gate through a
brand-new `ApprovalGate` instance sharing only the store.

**Notes.** Store the *resolved* policy (post-`mergePolicy`), not the caller's
sparse object. A policy that resolves differently after an upgrade is a
different governance decision than the one the requester saw.

### R3 · Store-backed `MultiplayerStore` reference implementation

`next` · size `L` · confidence `high`

**Problem.** `InMemoryMultiplayerStore` is the only implementation that ships.
Everyone who adopts the package has to write the persistence layer before they
can deploy, from an interface with no reference to check their work against.

**Done when** there is one durable implementation (LibSQL/SQLite first, since
Mastra already leans on it), a shared conformance test suite that any
implementation can run, and `docs/STORAGE.md` points at both.

**Notes.** The conformance suite matters more than the implementation. It is
what lets someone write a Postgres store and know it is correct.

### R4 · HTTP surface tests

`shipped` · size `M` · confidence `high`

**Problem.** `src/server/index.ts` and `src/client/index.ts` are 570 lines
between them with no test coverage. They are also where authentication,
reconnection, and event framing live — the places a regression is least likely
to be noticed and most likely to matter.

**Shipped.** 52 tests across `test/server.test.ts` and `test/client.test.ts`,
on a fake Hono context and a fake `EventSource` in `test/helpers/hono.ts` — no
server, no port, no `@mastra/core`, which is what
[ADR 0004](./decisions/0004-structural-mastra-types.md) bought.

Covered: the full route surface and base-path handling; 401 on every route when
`authenticate` returns null; attribution taken from the authenticated identity
rather than the request body; the state snapshot and its sequence consistency;
SSE headers, framing, replay from both `Last-Event-ID` and `?lastSeq=`, and
which wins; subscribe/unsubscribe lifecycle; presence cleared on cancel without
a roster eviction; vote error codes; audit limits. On the client: the
join → hydrate → connect ordering, cursor handling while a stream is open, every
reducer branch, duplicate and malformed frames, reconnect backoff, and heartbeat
lifecycle.

Each behavioural test was mutation-checked — the source was broken in the way
the test claims to catch, and the expected test failed.

### R5 · Session membership authorization

`next` · size `M` · confidence `high`

**Problem.** `authenticate` answers "who is this?" and nothing answers "may
they be in *this* session?". Any authenticated participant can pass any
`sessionId` and read the stream, the roster, and the audit ledger. In a product
with more than one customer this is a cross-tenant read.

**Done when** `multiplayerRoutes` takes an `authorize(participant, sessionId)`
hook that is called on every route, defaults to roster membership, and returns
403 rather than 401 when identity is known but access is not granted.

**Notes.** `/join` is the exception and needs its own thought: the caller is by
definition not yet on the roster, so membership cannot be the check there.

### R13 · Continuous integration

`shipped` · size `S` · confidence `high`

**Problem.** There is no `.github/workflows`, so `build`, `typecheck`, `test`,
and `docs:check` run only when someone remembers. Every other item on this list
assumes a green baseline that nothing currently enforces.

**Shipped.** `.github/workflows/ci.yml` runs `npm run check` and `npm run build`
on push to `main` and on every pull request, across Node 20 and 22 — the
boundary `engines` claims and current LTS, so the claim is enforced rather than
asserted. Concurrency-grouped so a newer push cancels the older run.

Also added `scripts/check-exports.mjs`, run after the build: the test suite
imports from `src/`, so it stays green even if the build stops emitting an entry
point. A broken `exports` map is otherwise invisible until someone installs the
package.

**Notes.** Cheapest item here and the one that makes the rest trustworthy.
Deliberately left out of the launch-review pass because CI configuration is a
choice about the project's infrastructure rather than a cleanup.

## Next — after `0.2.0`

### R6 · Workflow step factory for gates

`later` · size `M` · confidence `high`

Wrap Mastra's `suspend()` / `resume()` so an approval gate is a workflow step
rather than a hand-rolled polling loop. `examples/approval-gate/refund-tool.ts`
currently shows the manual version; this collapses it to a few lines. Blocked on
R2 — suspending across a restart is pointless while the policy does not survive
one.

### R7 · Channel adapters

`later` · size `L` · confidence `medium`

Map Slack, Discord, and GitHub identity onto `Participant`, so a session can
span a web UI and a Slack thread with one roster. The `surface` and `resourceId`
fields exist for this.

Confidence is medium because it is unclear whether this belongs here or in a
companion package. Each adapter drags in a vendor SDK, which fights the
zero-dependency rule in [CONTRIBUTING](../CONTRIBUTING.md). Decide the packaging
question before writing the first adapter.

### R8 · Durable expiry

`later` · size `M` · confidence `medium`

Approval expiry is enforced lazily — `refresh()` re-evaluates against the clock
when someone asks. Nothing fires on its own. A gate that expires at 3am resolves
at 9am when the first person opens the page, and the audit ledger records the
wrong time.

The honest fix is a scheduler, and the honest answer to "which one" is probably
"the one the host application already runs". Likely shape: a
`checkExpiries()` method the host calls from its own scheduler, plus
documentation saying so, rather than a timer this package owns.

### R9 · Backpressure on the SSE stream

`later` · size `S` · confidence `medium`

`controller.enqueue` is called unconditionally on every event. A slow client on
a busy session grows the stream's internal queue without bound. Needs a
`desiredSize` check and a policy for what to drop — almost certainly
`agent.delta`, since the terminal `message` event carries the full text anyway.

### R10 · Structured errors and a logger seam

`later` · size `S` · confidence `high`

Three `console.error` calls are the entire error-reporting story. Hosts need to
route these into their own logging. A minimal `logger` option on
`MultiplayerOptions` with a console default, and no new dependency.

## Researching

### R11 · Shared state / co-editing

`researching` · size `XL` · confidence `low`

Live cursors and collaborative document editing (Yjs or Automerge) are the
feature most often asked for when people hear "multiplayer". They are also a
different problem: CRDT sync wants a persistent bidirectional transport, which
is [exactly what SSE is not](./decisions/0002-sse-over-websockets.md).

Open questions, in the order they need answering:

1. Is this one package or two? A CRDT transport alongside the SSE stream is a
   second connection, second scaling story, second failure mode.
2. What is actually being co-edited? Cursors in a chat transcript are close to
   useless. A shared artifact the agent is also editing is the interesting case,
   and it is not modelled anywhere yet.
3. Does the agent participate in the CRDT document, or does it hold a lock?
   Nobody has a good answer to "the model and a human edit the same paragraph".

Not scheduled until (2) has a real answer. Building the transport first would
be building the easy half.

### R12 · Evaluation harness for multiplayer failure modes

`researching` · size `L` · confidence `medium`

There is no benchmark for "did the agent handle two people disagreeing
correctly". The README says so plainly and that remains true. Candidate
scenarios worth scripting: conflicting instructions, one participant
contradicting a group decision, an approval requested by someone who then goes
silent, a participant joining mid-run with no context.

Worth doing partly because the scenarios themselves are a contribution, even
before there is a score attached.

## Deliberately not doing

Kept here so the questions stay answered.

| Item | Why not |
| --- | --- |
| Message storage | Mastra's memory owns messages and threads. A second copy is two sources of truth and a reconciliation bug. See [ADR 0001](./decisions/0001-two-storage-systems.md). |
| Multi-agent routing | A different problem — orchestration, not social. Well covered elsewhere, including by Mastra itself. |
| Durable execution | Checkpoints are not durable execution. A gate that must stay open across deploys belongs in Temporal, Inngest, Restate, or Durable Objects; this package handles the human-facing half. |
| A UI component library | The hook is headless on purpose. Vendored design systems do not survive contact with a real product. |
| WebSocket transport | Rejected with reasoning in [ADR 0002](./decisions/0002-sse-over-websockets.md). Revisit only if R11 lands and needs a bidirectional channel anyway. |
| Publishing under `@mastra/` | The scope belongs to the Mastra org. Community packages use an unscoped prefix. |

## Recently shipped

### `0.1.0` (unreleased)

The initial scaffold: `MultiplayerSession`, `PresenceManager`, `ApprovalGate`
and the policy engine, `TurnController`, `EventBus`, attribution helpers,
`multiplayerRoutes`, `MultiplayerClient` and `useMultiplayerSession`,
`InMemoryMultiplayerStore`. See the [changelog](../CHANGELOG.md).

Added during the launch review ([findings](./reviews/2026-09-06-launch-review.md)):

- `GET /sessions/:id/state` and `MultiplayerClient.hydrate()` — a client opening
  an already-running session used to render an empty room.
- `PresenceManager.disconnected()` — a closed SSE stream no longer evicts the
  person from everyone else's roster.
- `mergePolicy()` — an explicitly-`undefined` policy override no longer
  silently replaces a default.
- `npm run check` (typecheck + tests + doc links) and
  `scripts/check-doc-links.mjs`, so a moved page or renamed heading fails
  loudly instead of rotting.
- Package metadata (`repository`, `homepage`, `bugs`, `publishConfig`, the
  `"./package.json"` export, `CHANGELOG.md` in `files`); removed the inert
  `.npmignore`.
- These docs.

## How this roadmap is maintained

- **Gardened at every release, and on any month where there was not one.** The
  date at the top is the contract. If it is stale, the list is not trustworthy.
- **Every item earns its place each pass.** Something that has been `later` for
  two passes with no one asking for it moves to *Deliberately not doing* with a
  reason, or gets deleted. Growth is not the goal.
- **Review findings land here.** A [review](./reviews/) that finds something
  real produces a roadmap item with an `Rn` id, or a fix. Not a note in a
  document nobody opens again.
- **Ids are stable.** `R1` stays `R1` even after it ships, so commits and issues
  that reference it keep meaning something. Numbers are not reused.
- **Confidence gates scheduling.** Nothing moves to `next` at low confidence.
  If it matters and confidence is low, the work is research, and it goes in
  *Researching* until there is a design.
