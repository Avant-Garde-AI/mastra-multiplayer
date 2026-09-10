# Roadmap

Last gardened: 2026-09-09 · against `0.4.0` · next milestone not yet scoped — see [`roadmap/`](./roadmap/)

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

## Shipped — the `0.2.0` milestone

**Complete.** All six items shipped.

The theme was **surviving a second process**. Everything in `0.1.0` assumed one
Node process holding all state in memory — fine for a demo, fatal for a deploy,
and the single thing most likely to make an early adopter abandon the package.

What remains single-process is `TurnController`: two instances each run a turn
for the same session, so a deployment needs session affinity at the load
balancer. That is a smaller and better-understood problem than the three this
milestone closed, and it is written up as R14 below rather than left implicit.

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

`shipped` · size `L` · confidence `high`

**Problem.** `EventBus` fans out in-process. Behind two server instances, a
message published on instance A never reaches the SSE stream held open on
instance B. Half the room sees the conversation.

**Shipped.** `RedisEventBus` (`mastra-multiplayer/bus/redis`), behind a new
`MultiplayerBus` interface that `EventBus` also implements. `ioredis` is an
optional peer dependency imported by nothing — clients are passed in and typed
structurally.

The note above was right about where the difficulty is. Three things followed
from it:

- **`publish` is now async**, and so are `replay`, `currentSeq`, and `clear`.
  A synchronous signature would have forced fire-and-forget sequence
  allocation, and errors would have vanished. Breaking, and worth it.
- **Sequence, replay-append, and publish happen in one Lua script.** Separate
  commands would let two publishers append in a different order than they took
  their sequence numbers, so a reconnecting client replays out of order. The
  script splices `"seq":N` into the already-serialized payload rather than
  re-encoding it — `cjson` cannot round-trip an empty array, and
  `presence.updated` legitimately carries one.
- **`subscribeFrom(sessionId, afterSeq, handler)` is a new primitive.**
  Replay-then-subscribe drops what lands in between; subscribe-then-replay
  delivers live events ahead of older ones, which a client tracking its highest
  sequence discards as stale. The bus owns the transition rather than
  documenting an ordering rule for callers to get wrong.

Tested against a real Redis, not a fake — the guarantee is a property of Redis,
so a fake would only be checking our own assumptions. CI runs a Redis service
and **fails rather than skips** if it is unreachable; a silent skip would delete
the only coverage of the thing this class exists for.

Mutation-checked. Allocating the sequence in process memory instead of `INCR`
fails four tests, including the 100-publish two-instance race. Re-encoding the
payload with `cjson` fails the empty-array test. Both wrong orderings of
subscribe/replay fail the mid-replay test.

Two things found while building it, both worth recording:

- A flaky test (1 run in 3) turned out to be a real bug in `attach()`: it
  populated the channel map *before* awaiting `SUBSCRIBE`, so a concurrent
  caller saw the entry and returned while the subscription was still in flight.
  In-flight subscribes are now memoized per channel. Re-running until green
  would have shipped it.
- The first version of the mid-replay test passed against the broken
  implementation — it published before the replay list had been read, so the
  event landed in the replay itself. It now blocks until the read has happened,
  and catches both wrong orderings.

**Still not distributed: `TurnController`.** Every instance sees every message
and each decides independently whether to run the agent, so two instances will
run the same turn twice. Session affinity at the load balancer is the answer
today.

### R2 · Persisted approval policies

`shipped` · size `M` · confidence `high`

**Problem.** `ApprovalGate` holds policies in a private `Map` keyed by approval
id. Restart the process mid-approval and the policy is gone; the gate falls back
to the default, which is `quorum: 1`. A four-eyes gate quietly becomes a
one-signature gate across a deploy. This is a governance bug, not an
inconvenience.

**Shipped.** `ApprovalRequest.policy` carries the resolved policy; the
process-local `Map` is gone. `vote()` and `refresh()` read from the record.

The stored policy is the *resolved* one, which buys more than restart safety:
a later release that changes a default cannot retroactively change a pending
gate, and the audit ledger becomes self-describing — a reader months later sees
the rule that was applied, not just its name.

Two shape changes fell out of it:

- `ApprovalPolicy` and `ResolvedPolicy` moved to `types.ts` (re-exported from
  `approvals/policy.js`, so the public API is unchanged) — a record that carries
  its own policy cannot import the module that builds it.
- `ApprovalRequest.policyName` is **removed**, superseded by `policy.name`. Two
  fields holding the same string is how they drift.

Also fixed while in here: `canVote` read `allowedParticipants` off the caller's
raw policy rather than the resolved one. Harmless before, because the raw object
was what got passed; a live bug the moment the resolved policy became the input.
Widening `ResolvedPolicy` to `ApprovalPolicy & Required<...>` made the compiler
find it.

Seven tests, each driving a second `ApprovalGate` that shares only the store —
which is exactly what a redeployed process is. Mutation-checked: ignoring the
stored policy fails eight tests.

### R3 · Store-backed `MultiplayerStore` reference implementation

`shipped` · size `L` · confidence `high`

**Problem.** `InMemoryMultiplayerStore` is the only implementation that ships.
Everyone who adopts the package has to write the persistence layer before they
can deploy, from an interface with no reference to check their work against.

**Shipped.** `LibSQLMultiplayerStore` (`mastra-multiplayer/storage/libsql`) and
a 39-check conformance suite (`mastra-multiplayer/storage/conformance`).

`@libsql/client` is an optional peer dependency imported by nothing at all — the
subpath takes a client rather than constructing one — so installing this package
pulls in no database driver. The client is
passed in, not constructed — connection lifetime and auth stay the host's.

The suite is **framework-agnostic data**, not a test file: `conformanceChecks()`
returns `{ group, name, run(store) }` objects that vitest, jest, `node:test`, or
a bare script can drive. That was the right call — it is the artifact a
third-party Postgres store needs, and shipping it as a vitest suite would have
forced vitest on them.

It earned its place immediately. Run against the existing in-memory store, it
failed three checks and forced a contract decision the interface had never
made: **reads of an unknown session return empty, writes reject, deletes are
idempotent.** `InMemoryMultiplayerStore` used to throw on reads; it now matches.
That question would otherwise have been answered differently by every
implementation.

Mutation-checked against the LibSQL store with the five mistakes a real
implementer makes — a naive `ORDER BY at ASC LIMIT n`, an `updateSession` that
skips `undefined`, a plain `INSERT` instead of an upsert, a `removeParticipant`
that leaves presence behind, an approval storing only its policy's name. Each
was caught by the check written for it.

Five further integration tests run the whole package against a real database,
including a four-eyes gate resolving across a restart and a store reopened
against the same file — an in-memory database would have passed every other
test here.

**Not covered, and documented as such:** concurrent votes. The suite is
single-threaded by construction and cannot check that two simultaneous votes on
a `quorumOf(2)` gate resolve it exactly once, which is the most important thing
to get right in a real store.

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

`shipped` · size `M` · confidence `high`

**Problem.** `authenticate` answers "who is this?" and nothing answers "may
they be in *this* session?". Any authenticated participant can pass any
`sessionId` and read the stream, the roster, and the audit ledger. In a product
with more than one customer this is a cross-tenant read.

**Shipped.** `multiplayerRoutes` takes an optional `authorize({ participant,
sessionId, action, context })`, called on every route after `authenticate`.
Identity failure is 401; access failure is 403 with `code: "not_a_member"`.

Four decisions worth recording:

- **`action` names the route** rather than lumping into read/write, so a host
  can gate `audit` to owners without also gating `messages`.
- **The default fails closed.** A store that throws is not a membership proof.
  A genuine outage therefore reads as 403 rather than 500 — the right trade for
  an authorization check, and documented as such.
- **A custom hook replaces the default rather than layering on it.** A hook that
  could only narrow an invisible built-in rule is harder to reason about than
  one stating the whole policy.
- **Unknown sessions now return 403, not 404,** because authorization runs
  before the session is loaded. This is a deliberate behaviour change: the old
  404 was an existence oracle. `GET /state` still 404s once authorization has
  passed.

`join` is exempt from the default rule — the caller cannot already be on a
roster they are asking to join — but a custom hook still sees it and can reject
it, which is where an invitation check belongs.

27 tests, mutation-checked. One mutation (authorizing `vote` against a
request-supplied session rather than the approval's own) initially escaped the
suite; the test was strengthened to smuggle a session id the caller *is* a
member of, and now catches it.

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

## Shipped — Phase 4 · Operability (`0.3.0`)

The `0.2.0` theme was *surviving a second process*. This one is **behaving
correctly once you are running more than one, and running unattended** — the
things that only show up after deployment.

| Item | Status |
| --- | --- |
| R14 · Cross-instance turn coordination | `shipped` |
| R10 · Structured errors and a logger seam | `shipped` |
| R9 · Backpressure on the SSE stream | `shipped` |
| R8 · Durable expiry | `shipped` |

R14 came first because it is a correctness gap left open by R1, and because
finding out what was actually broken changed the design. R10 came with it
because the lease's retry path needed somewhere to report to.

### R14 · Cross-instance turn coordination

`shipped` · size `L` · confidence `high`

**The problem was not what this entry originally said.** It claimed every
instance runs every message, so two would answer the same message twice. That is
wrong: `turns.submit()` is called only by the instance that received the HTTP
request. Two live instances were run to find out what actually breaks:

- **Two concurrent runs for one session.** People posting to different
  instances at the same moment each start a turn, interleaving deltas under two
  `runId`s. The documented "one run at a time per session" held per process.
- **`interrupt()` aborted only locally** while still publishing
  `agent.run.interrupted` — so every client showed the run stopped and the agent
  kept streaming. Worse than a no-op: the UI lied.

**Shipped.** Two fixes, deliberately separable:

- A `TurnLease` (`acquire` / `renew` / `release`) that `TurnController` takes
  before running, renews while streaming, and releases at the end.
  `RedisTurnLease` uses `SET NX PX` and ownership-checked Lua for renew and
  release. Optional — a single-instance deployment should not pay for it.
- Distributed interrupt, **on by default and needing no lease**: a run in flight
  subscribes for `agent.run.interrupted` for its duration, so an interrupt
  raised anywhere stops the run wherever it is happening.

Confidence moved from medium to high once the failure mode was measured rather
than guessed at. The stall concern was real but narrower than feared: renewal
during streaming covers long runs, and the residual case — a lost lease aborting
a legitimate reply — is documented rather than hidden.

Mutation-checked. An `acquire` whose result is ignored, a lease taken without an
expiry, a lease never released, and a run that stops listening for remote
interrupts each fail the tests written for them. One mutation escaped at first —
a `release` that skips its ownership check, which lets a stale holder free a
lease another instance is actively using. That is the concurrent-run bug
reintroduced through the cleanup path, so it now has its own contract tests, run
against both lease implementations.

### R10 · Structured errors and a logger seam

`shipped` · size `S` · confidence `high`

**Shipped.** A four-method `Logger` (`debug` / `info` / `warn` / `error`), each
taking a message and a context object. `consoleLogger` is the default,
`silentLogger` discards. Set it once on `createMultiplayer({ logger })` and the
bus, presence manager, approval gate, and turn controller all use it. No new
dependency.

Every `console.error` in `src/` is gone. A host-supplied logger that throws
cannot break the caller — publishing an event should not fail because shipping a
log line did, and there is nothing useful to do about a logging failure except
carry on.

### R9 · Backpressure on the SSE stream

`shipped` · size `S` · confidence `high`

**Shipped.** Once `streamHighWaterMark` frames (default 256) sit unsent,
`agent.delta` is dropped and everything else closes the stream, letting the
client reconnect and replay from `Last-Event-ID`.

The guess above was right about the policy and missed a prerequisite: without an
explicit `CountQueuingStrategy` the high-water mark is **1**, so `desiredSize`
goes non-positive after a single unread frame and every stream looks backed up.
The check is worthless without the strategy, and a test pins the default.

Mutation-checked: removing the check, dropping everything rather than only
deltas, and reverting the high-water mark to 1 each fail their own tests.

### R8 · Durable expiry

`shipped` · size `M` · confidence `high`

**Shipped**, and in the shape the note predicted: `approvals.sweepExpired(sessionId)`
and `multiplayer.sweepExpiredApprovals()`, driven by the host's own scheduler.
No timer in here — the right cadence depends on how tight your windows are, and
a library that owns a scheduler owns a shutdown story and a leader-election
story too.

The "records the wrong time" half turned out to be a separate, smaller fix worth
doing on its own: `resolvedAt` is now the **deadline**, not the moment someone
noticed. A 3am expiry records 3am even if the sweep runs at 9am, because the
ledger's job is to answer *when was this decided*. The same rule applies to a
vote that lands after expiry.

A sweep is idempotent, publishes `approval.resolved` and audits exactly as a
vote does, and one unreadable record does not strand the rest of the session —
a sweep that stopped on the first error would resolve nothing.

## Shipped — `0.4.0` · Integration

Detailed plan: [`roadmap/0.4.0-integration.md`](./roadmap/0.4.0-integration.md),
kept as written with what it got wrong marked in place. Both items were
re-planned on 2026-09-07 after
[reading Mastra's actual APIs](./roadmap/research/2026-09-07-mastra-apis.md)
rather than assuming them — which changed both, and building them changed the
plan again. That is the argument for the research habit, not against it.

**Nothing is scheduled after this.** `Researching` below is the candidate pool;
the next milestone gets scoped when there is a reason to pick from it rather
than a slot to fill.

### R6 · Workflow-step approval gates

`shipped` · size `L` · confidence `high`

Wrap Mastra's `suspend()` / `resume()` so an approval gate is a workflow step
rather than a hand-rolled polling loop.

**Grew from `M` to `L` after reading the API,** and the estimate held. The
factory is the easy half: votes arrive over this package's HTTP surface and
workflows resume through `run.resume()`, and nothing connects them. Build only
the step and every gate suspends for ever.

**Shipped** as `mastra-multiplayer/workflows`: `approvalStep` (returns
`createStep` parameters, so `@mastra/core` stays an optional peer) and
`ApprovalResumer`. Verified against the real engine, not a fake — see
`test/workflows.integration.test.ts`.

The precondition was met before any code: `run.resume({ step, resumeData })`,
`createStep`'s `resumeSchema` / `suspendSchema`, `bail()` and
`createRun({ runId })` all behave as read on published `1.64.0`, not just on
`main`.

Four things the build changed or found:

- **The resumer is not a bus subscriber.** `MultiplayerBus` is keyed by session
  and the plan's "subscribe across sessions" is not something it can do without
  new surface on both implementations — which would still have needed the
  reconciling sweep behind it, because the bus is at-most-once. It listens
  locally via `ApprovalGate.onResolved` and reconciles from the store instead.
  [ADR 0006](./decisions/0006-local-resume-not-bus.md).
- **`runId` and `stepId` were not enough.** They have existed unused since
  `0.1.0`, and the first thing that tried to use them found a run id with no
  registry key to look it up in. `ApprovalRequest.workflowId` joins them.
- **`resumedAt` keeps the sweep cheap.** Without it every approval ever resolved
  is re-checked against the workflow store on every sweep, for ever.
- **A denial `bail()`s and a binding mismatch throws.** A refused refund is a
  completed run; a run about to execute something nobody approved is not.

R2 unblocked this: suspending across a restart was pointless while the policy
did not survive one.

### R7 · Channel participants

`shipped` · size `M` · confidence `high`

Map Slack, Discord, Teams and GitHub identity onto `Participant`, so a session
can span a web UI and a Slack thread with one roster. `surface` and `resourceId`
exist for this.

**Was `L` at medium confidence on a premise that turned out to be wrong.** The
worry was that each adapter drags in a vendor SDK, fighting the zero-dependency
rule and possibly belonging in a companion package. Mastra's adapters are
separate `@chat-adapter/*` packages the *host* installs and hands to its own
agent — this package never imports one.

**Shipped** as `mastra-multiplayer/channels`: `channelParticipant` (pure) and
`ChannelBridge` (joins and forwards). No dependency on any chat SDK; the core
entry point has no path to one.

Three decisions worth recording, each mutation-checked:

- **Ids are prefixed with the surface.** An unprefixed collision between two
  platforms merges two people into one participant, which under
  `excludeRequester` silently turns four-eyes into two.
- **`isBot: 'unknown'` counts as a bot.** That errs toward excluding a real
  human — a visible failure — over letting an automation satisfy a quorum, which
  is a silent governance one. Logged at `warn`, and `allowBots` turns it off.
- **Joining happens on arrival and on change, not per message.** An upsert per
  message is safe but publishes `participant.joined` every time, filling the
  event stream with one person repeatedly arriving.

`ParticipantSurface` was widened while doing this: it named `linear`, for which
Mastra has no adapter, and omitted `telegram`, `whatsapp` and `imessage` — one
of which is among only two adapters that actually ship in the Mastra repo. It
now accepts any string, because Mastra keys adapters by arbitrary name and a
closed union would make this package the bottleneck on somebody else's
integration.

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

## Released

### `0.4.0` — integration · the first published release

Approval gates as Mastra workflow steps (`R6`) and channel participants (`R7`).
The first release where the package meets another system on its own terms
rather than asking to be wired up by hand — and the first that anyone outside
the repository can install.

### `0.3.0` — operability (unpublished)

Phase 4, operability: cross-instance turn coordination (`R14`), a logger seam
(`R10`), SSE backpressure (`R9`), and driven approval expiry (`R8`).

### `0.2.0` — surviving a second process (unpublished)

CI (`R13`), HTTP surface tests (`R4`), session authorization (`R5`), persisted
approval policies (`R2`), a durable store and conformance suite (`R3`), and a
Redis-backed bus (`R1`).

### `0.1.0` — the initial scaffold (unpublished)

`MultiplayerSession`, `PresenceManager`, `ApprovalGate` and the policy engine,
`TurnController`, `EventBus`, attribution helpers, `multiplayerRoutes`,
`MultiplayerClient` and `useMultiplayerSession`, `InMemoryMultiplayerStore` —
plus the three defects found reviewing it
([findings](./reviews/2026-09-06-launch-review.md)) and these docs.

Full detail, including every breaking change between milestones, is in the
[changelog](../CHANGELOG.md).

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
