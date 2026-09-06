# Concepts

The vocabulary the rest of the docs assumes. Short page; the ideas are simple
and the precision matters.

## Multiplayer means multi-human

One agent and four people in a shared session is multiplayer. Twenty agents and
one person reading a log is not.

The distinction is load-bearing rather than pedantic, because the hard problems
are different ones. Multi-agent is a routing and orchestration problem: which
agent handles this, how does work get handed off, how do results merge.
Multiplayer is a *social* problem that happens to be implemented in TypeScript:
whose instruction wins when two people disagree, who is allowed to approve a
destructive action, what the model should be told about the room it is speaking
to.

Nothing in this package routes between agents. If that is what you need, it is
a different tool.

## Session

A shared agent conversation more than one human can see and act in. It is bound
one-to-one to a Mastra thread (`SessionRecord.threadId`) and adds what a thread
does not model: a roster, presence, approvals, and an audit ledger.

A session is not a room that outlives its conversation, and not a channel. If
you need a long-lived space containing many conversations, that is your
application's concept, and it holds session ids.

## Participant

One human, in one session, on one surface.

```ts
{ id, displayName, role, surface, resourceId?, email?, avatarUrl?, metadata? }
```

`role` (`owner` · `editor` · `approver` · `viewer`) is what approval policies
gate on. `surface` records where they are connected from (`web`, `slack`,
`discord`, `teams`, `github`, `linear`, `api`, `unknown`) and is what channel
adapters will populate ([R7](./ROADMAP.md#r7--channel-adapters)).

The `id` is your identity system's id, not one this package mints. It has to
be, because it is what the audit ledger attributes actions to and what
four-eyes compares. See [SECURITY](./SECURITY.md).

## Roster vs. presence

Two different questions, and the most common source of bugs in this kind of
system:

- **Roster** — *who belongs to this session.* Changes on `join` and `leave`.
  Persisted. A person who closes their laptop is still on the roster.
- **Presence** — *who is here right now.* Heartbeat-based, ephemeral, ages out
  on its own.

Presence is heartbeat-based rather than connection-based on purpose. A Slack
participant has no socket to hold open, and a browser tab that crashes never
sends a clean disconnect, so "who checked in recently" is the only definition
that works across surfaces. Participants transition `active → idle → dropped`
on configurable windows.

Dropping out of presence does not remove anyone from the roster. That
distinction is what [F1 in the launch review](./reviews/2026-09-06-launch-review.md#f1--a-dropped-sse-stream-evicted-people-from-the-roster)
was about.

## Turn

One agent run, triggered by one or more human messages.

A single-user chat loop can assume one message, one turn. The moment two people
share a session, messages interleave and arrive mid-run, and something has to
decide what that means. `TurnController` is that something, and it is the *only*
thing that starts a run — every path into the agent goes through `submit()`, so
there is exactly one place where the question is answered.

The five modes (`queue`, `debounce`, `batch`, `skip`, `preempt`) encode
different assumptions about what a group is doing. They are not
interchangeable; see [CONCURRENCY](./CONCURRENCY.md).

## Gate, policy, and binding

An **approval gate** stops an action until enough of the right humans say yes.

A **policy** says what "enough" and "the right humans" mean: quorum, whether
the requester is excluded, which roles may vote, how long the request stays
open, and what silence means when it expires.

A **binding** is a SHA-256 over the tool name and a stable serialization of its
arguments, stored on the request. It is what stops an approval granted for one
action being replayed against another — a signature on a specific call, not a
general permission. `assertBinding()` re-checks it immediately before the side
effect. See [APPROVALS](./APPROVALS.md).

## Event, sequence, replay

Every state change is an event published on the `EventBus`, carrying a
`sessionId` and a monotonically increasing per-session `seq`.

Clients track the highest `seq` they have seen and send it on reconnect, which
turns a dropped connection from a correctness problem into a latency one. The
replay buffer is bounded (200 events by default) and is for network blips, not
cold starts — a client that has been gone longer fetches a
[state snapshot](./HTTP-API.md#get-sessionssessionidstate) instead.

## Attribution

A model handed a shared transcript with no speaker labels reads it as one person
contradicting themselves.

`labelBatch()` prefixes each message with its author. `rosterPrompt()` appends a
system-prompt fragment describing who is in the room and how to behave in one —
including the guideline that earns its place:

> If two people ask for conflicting things, say so plainly and ask which to
> follow rather than picking silently.

Without it the model picks a side silently, and the person it ignored has no
idea it happened.

## Memory scoping

Mastra keys memory on `threadId` (per conversation) and `resourceId` (per user,
across threads). In a shared session:

- **`threadId`** → the session. Everyone reads and writes one conversation.
- **`resourceId`** → **currently the session id.** `runTurn` passes
  `memory: { thread: session.threadId, resource: session.id }`, which makes
  resource-scoped memory per-room rather than per-person. That is the right
  default for a shared session — resource-scoped working memory keyed to an
  individual means what one person tells the agent silently follows them out of
  the room — but it means `Participant.resourceId` is not yet used by the
  library. It is stored for your own per-user lookups and for channel adapters.
  Making the mapping configurable is unscheduled; open an issue if you need it.
- **Working memory** should be `scope: "thread"` in a shared session, for the
  same reason.

Long shared threads outgrow the context window faster than single-user ones.
Mastra's memory processors are the right tool for trimming; this package does
not duplicate them.

## Two storage systems

Mastra owns messages and threads. This package owns the roster, presence,
approvals, and audit. Duplicating messages into a second store would give you
two sources of truth and a reconciliation bug —
[ADR 0001](./decisions/0001-two-storage-systems.md).
