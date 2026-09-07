# Horizons

Beyond `0.4.0`. Nothing here is scheduled, and the point of the page is to say
**what would have to be true** before any of it should be — so that a future
decision to build one is a decision, not a drift.

The near-term board is [ROADMAP.md](../ROADMAP.md). The next milestone's detail
is [0.4.0](./0.4.0-integration.md).

## The honest state of things

`0.3.0` is a correct, tested, deployable single- or multi-instance package with
no adopters. Almost every remaining idea is worth less than one real user, and
the roadmap should keep saying so until that changes.

That is why the two research items below have stayed unscheduled through five
milestones. It is not neglect.

## R11 · Shared state and co-editing

The feature most often asked for when people hear "multiplayer", and the one
least likely to be right.

**What would change my mind:** someone describing an artifact the agent *and*
the humans both edit — a document being drafted, a config being tuned, a query
being refined — rather than "live cursors". Cursors in a chat transcript are
close to useless. A shared artifact is the interesting case, and it is not
modelled anywhere in this package.

**What is already decided:** it does not go over SSE
([ADR 0002](../decisions/0002-sse-over-websockets.md)). A CRDT wants a
persistent bidirectional transport, and chat, presence and approvals do not.
That would be a second connection alongside this one, not a replacement.

**The question nobody has answered:** what happens when the model and a human
edit the same paragraph. Not a transport problem. Building the transport first
would be building the easy half, which is exactly what makes this tempting.

## R12 · An evaluation harness

There is no benchmark for "did the agent handle two people disagreeing
correctly". The README has said so since day one and it is still true.

**Why this may be worth doing before anyone asks:** the scenarios are a
contribution even without a score attached. Conflicting instructions; one
participant contradicting a group decision; an approval requested by someone who
then goes silent; a participant joining mid-run with no context. Writing those
down as runnable fixtures would sharpen `rosterPrompt()`, which is currently
prose nobody has measured.

**What would make it real:** picking one scenario and one model and showing that
the roster prompt changes the outcome. If it does not, that is a more valuable
finding than the harness.

## Things that would come from adopters

Listed because they are the shape of what real use produces, not because they
are planned:

- **A second store implementation** — Postgres, most likely. The
  [conformance suite](../STORAGE.md#the-conformance-suite) exists so that this
  is somebody else's afternoon rather than our milestone.
- **Metrics.** The logger seam landed in `0.3.0`; counters did not. Sessions,
  turns, gate outcomes, dropped frames. Cheap once someone can say which numbers
  they would act on.
- **`already_resolved` returning `409` rather than `403`.** A known wart
  ([HTTP-API](../HTTP-API.md#post-approvalsapprovalidvote)). It waits for a
  release that has other breaking changes rather than spending one on its own.
- **A `Signal API` alignment pass.** `TurnController`'s five modes were written
  to mirror Mastra's Signal API. Mastra now has a `SignalProvider` abstraction
  the modes have never been checked against
  ([research](./research/2026-09-07-mastra-apis.md#signals)). They may have
  drifted; nobody has looked.

## What would make this package fail

Worth naming, since a roadmap that only lists features is a roadmap that assumes
success:

- **Mastra ships this itself.** Entirely possible, and it would be the right
  outcome for users. `MultiplayerStore` would be deleted rather than
  reconciled ([ADR 0001](../decisions/0001-two-storage-systems.md)).
- **Nobody wants many humans in one agent session.** The whole premise is
  unvalidated. Everything built so far is correct; none of it is evidence that
  the problem is real.
- **The social layer turns out to belong in the product, not a library.** Who
  may approve what, how conflict is surfaced, what the room sees — these are
  product decisions, and a library that pre-decides them may be less useful than
  a page of documentation and an afternoon.

None of these is a reason to stop. All are reasons to keep the package small and
to prefer deleting an item over carrying it.
