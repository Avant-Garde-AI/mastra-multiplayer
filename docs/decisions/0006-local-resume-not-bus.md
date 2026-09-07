# 0006 — Workflow resumption is driven locally and reconciled from the store

**Status:** Accepted · `0.4.0`

## Context

An approval gate as a workflow step suspends the run. Something has to wake it
when the votes land. Votes arrive over this package's HTTP surface; workflows
continue through `run.resume()`; nothing joins the two, and a step factory
without that joint suspends every gate for ever.

The [plan for R6](../roadmap/0.4.0-integration.md#r6--workflow-step-approval-gates)
said the resumer would "subscribe to `approval.resolved` across sessions". That
turned out not to be a thing this package can do. `MultiplayerBus.subscribe` is
keyed by session, and deliberately: every consumer of the bus — the SSE stream,
the React client, the distributed interrupt — is watching one conversation.
Hearing about every resolution would mean either one subscription per session,
held for the life of the process and growing without bound, or a new
cross-session primitive on both bus implementations (a Redis `PSUBSCRIBE`, new
optional methods on `RedisLikeSubscriber`, and a contract change for anyone who
has written their own bus).

There was also a second problem that the bus could not solve at any price. The
bus is at-most-once. A resumer that was down when the event fired never sees it,
and the gate is stranded with the ledger insisting it was approved.

## Decision

Two triggers, neither of them the bus.

**`ApprovalGate.onResolved(handler)`** — a local, in-process listener list,
called from `vote()` and `refresh()` after the request is saved and published.
The instance that resolved a request is already holding it and already has the
application wired up; it is the obvious place to react, and it needs no network
hop to find out something it just did.

**`ApprovalResumer.reconcile()`** — a sweep over `listSessions()` and
`listApprovals()` for decided gates that may still be holding a run open. It
runs once inside `start()` and is meant to be called again from whatever timer
already sweeps expiries.

Handlers are not awaited, and one that throws is logged rather than propagated:
a resumer failing must not undo a vote, and a vote's HTTP response must not
block on a refund.

## Consequences

- **No new bus surface, and no per-session subscription bookkeeping.** The bus
  contract is unchanged, so an external implementation of `MultiplayerBus` keeps
  working.
- **The common path has no latency at all** — no publish, no round trip, no
  fan-out. The instance that took the vote resumes the run directly.
- **Correctness does not depend on delivery.** The sweep is the guarantee and
  the listener is the optimisation, which is the right way round for a bus that
  makes no delivery promise. This is why the sweep is not optional: without it,
  a decision made during a deploy strands a run for ever.
- **The sweep must stay cheap**, so `ApprovalRequest.resumedAt` records that a
  gate has been dealt with. Without it every approval ever resolved is
  re-checked against the workflow store on every sweep, for the life of the
  deployment.
- **Resumes have to be idempotent across instances**, because a local listener
  on one instance can race a sweep on another. The guard is the workflow store —
  a run that is not suspended on this step needs nothing, whoever resumed it —
  with an optional `TurnLease` in front to make the loser skip quietly instead
  of being rejected by Mastra.
- **A host that wants to react to decisions elsewhere still uses the bus.**
  `approval.resolved` is unchanged and still published. This decision is about
  what the *resumer* relies on, not about what the bus is for.

## Alternatives considered

**Add `subscribeAll` to `MultiplayerBus`.** Rejected. It is real new surface on
two implementations plus the contract, and it would still have needed the
reconciling sweep behind it, because at-most-once delivery cannot be the thing a
governance control depends on. Paying for a primitive that does not remove the
requirement it was bought for is the wrong trade.

**Poll only, with no listener.** Rejected. Correct, and it makes a human wait up
to a sweep interval after clicking approve. The listener costs almost nothing
and removes that entirely.

**Resume from inside `ApprovalGate` itself.** Rejected. The gate would have to
know about workflow registries, which drags `@mastra/core`'s shape into the core
module and makes approvals untestable without it. `onResolved` is the seam that
keeps the dependency pointing one way.

## Revisit when

- **The bus gains at-least-once delivery.** If `approval.resolved` becomes
  something a control can rely on, the sweep stops being the guarantee and the
  argument above loses its load-bearing half.
- **Something else needs cross-session events.** A second consumer would change
  the arithmetic on `subscribeAll` — it would then be a primitive two features
  want, not surface bought for one.
- **The sweep shows up in a profile.** `resumedAt` bounds it to gates that might
  still be stuck, but it is still `listSessions()` × `listApprovals()`. A
  deployment where that is too slow wants a store-level query for
  "decided, attached to a run, not yet resumed" — a `MultiplayerStore` change,
  and the point at which this record should be re-read.
