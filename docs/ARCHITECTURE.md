# Architecture

How the layers fit together and why. For the vocabulary, read
[CONCEPTS](./CONCEPTS.md) first; for the reasoning behind individual choices,
the [decision records](./decisions/).

## Layering

```
                    ┌──────────────────────────────┐
  browser / Slack   │  MultiplayerClient  ·  hook  │
                    └──────────────┬───────────────┘
                                   │ SSE + JSON POST
                    ┌──────────────▼───────────────┐
  Mastra server     │      multiplayerRoutes       │  registerApiRoute
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │      MultiplayerSession      │
                    ├──────┬─────────┬─────────────┤
                    │ Turn │ Approval│  Presence   │
                    │ Ctrl │  Gate   │  Manager    │
                    └──────┴────┬────┴─────────────┘
                          EventBus (seq + replay)
                                 │
                    ┌────────────▼─────────────────┐
                    │      MultiplayerStore        │  roster, presence,
                    └──────────────────────────────┘  approvals, audit
                                 │
                    ┌────────────▼─────────────────┐
                    │   Mastra Agent + Memory      │  threads, messages
                    └──────────────────────────────┘
```

Two storage systems on purpose. Mastra owns the conversation; this package owns
the social layer around it. Duplicating messages into a second store would give
you two sources of truth and a reconciliation bug —
[ADR 0001](./decisions/0001-two-storage-systems.md).

## Why SSE and not WebSockets

Every event in a shared agent session flows server → client: someone else's
message, a presence change, a token from the agent. The few client → server
actions (send, vote, heartbeat) are ordinary POSTs that want normal HTTP
semantics — auth, retries, status codes.

SSE also survives the boring infrastructure better. It is plain HTTP, so it
passes through proxies and CDNs that mangle WebSocket upgrades, and it
reconnects with `Last-Event-ID` for free. Mastra's own agent streaming is
already SSE, so there is one transport rather than two.

The cost is head-of-line blocking on HTTP/1.1 connection limits, and that
`EventSource` cannot send custom headers — so bearer-token auth works on every
route except the stream. If you need live cursors at 60fps, add a dedicated CRDT
transport alongside this rather than replacing it.
[ADR 0002](./decisions/0002-sse-over-websockets.md).

## Sequencing and replay

Every event gets a monotonic per-session `seq`. Clients track the highest they
have seen and send it on reconnect, which turns a dropped connection from a
correctness problem into a latency one.

The replay buffer is bounded (200 events by default). A client gone longer than
that should refetch session state rather than replaying — the buffer is for
network blips, not for cold starts.

Cold starts are what `GET /sessions/:id/state` is for. It returns the roster,
presence, and open approvals together with the `seq` they are consistent with,
so a client hydrates and then opens the stream from exactly that point. Order
matters: hydrating *after* connecting leaves a window where replayed frames
below the snapshot are still in flight and would be skipped by the cursor
jumping forward. `MultiplayerClient.start()` sequences it correctly.

## Concurrency

`TurnController` is the only component that decides when the agent runs. Every
path into the agent goes through `submit()`, so there is exactly one place
where the "what if two people type at once" question is answered.

The five modes are not equivalent — they encode different assumptions about
what a group is doing:

- `queue` assumes every message deserves a reply
- `debounce` assumes the last message supersedes the earlier ones
- `batch` assumes the messages are one collective thought
- `skip` assumes stale requests are worse than dropped ones
- `preempt` assumes the newest instruction overrides whatever is running

Picking wrong is not subtle. `debounce` in a busy channel silently discards
what most people said.

## Approval binding

The threat: an approval is granted for one action and reused for another. The
mitigation is a SHA-256 over the tool name and a *stable* serialization of the
arguments — keys sorted, `undefined` dropped — so `{a:1,b:2}` and `{b:2,a:1}`
hash identically but `{amount:40}` and `{amount:4000}` do not.

`assertBinding()` must be called immediately before the side effect, not at
approval time. Anything else leaves a window.
[ADR 0005](./decisions/0005-approval-argument-binding.md).

## Roster and presence are separate

The roster is who belongs to the session; presence is who is here right now.
They change on different events and for different reasons, and conflating them
is the classic bug in this kind of system — a dropped SSE stream is a reconnect,
a tab switch, or a closed laptop, not a departure. `PresenceManager.leave()`
announces a departure; `disconnected()` only clears presence.
[ADR 0003](./decisions/0003-heartbeat-presence.md).

## What is deliberately not here

- **Message storage.** Mastra's memory owns it.
- **Multi-agent routing.** Different problem, well covered elsewhere.
- **Durable execution.** Checkpoints are not durable execution. If a gate needs
  to stay open for days across deploys, put it in Temporal, Inngest, Restate,
  or Durable Objects and use this package for the human-facing half.
- **A UI.** The hook is headless. Design systems do not survive being vendored.

The full list, with reasoning, is in the roadmap's
[Deliberately not doing](./ROADMAP.md#deliberately-not-doing) section.

## Running more than one process

Two of the three single-process limits are gone. `LibSQLMultiplayerStore` makes
storage durable and shared; `RedisEventBus` makes the event bus shared. Both are
swapped in at construction — nothing outside `src/bus/` or `src/storage/` knows
which implementation it has.

```ts
createMultiplayer({
  agent,
  store: new LibSQLMultiplayerStore(createClient({ url })),
  bus: new RedisEventBus({ client, subscriber }),
});
```

**Sequencing is the hard part of a distributed bus, not fan-out.** Every client
discards events at or below the highest `seq` it has seen, so two instances
minting the same number would make clients throw away real events while
believing they were duplicates — a silent failure, and worse than the
limitation it replaces. The sequence therefore comes from a Redis `INCR` inside
the same Lua script that appends to the replay list and publishes, so ordering
cannot diverge from numbering.

This is why `MultiplayerBus.publish` is async. A synchronous signature would
have forced fire-and-forget sequence allocation, and errors would vanish.

`subscribeFrom(sessionId, afterSeq, handler)` exists for the same reason:
replaying and then subscribing drops whatever is published in between, and
subscribing and then replaying delivers live events ahead of older ones, which a
client tracking its highest sequence will discard as stale. Both lose data
quietly, so the bus owns the transition rather than documenting an ordering rule
for callers to get wrong.

## What multiple instances still get wrong

`TurnController` is per-process, and that breaks two documented guarantees.
Both were confirmed against two live instances rather than reasoned about:

- **"One run at a time per session" holds per process, not per session.** Two
  people posting to different instances at the same moment start two agent runs
  into one session, interleaving deltas from two different `runId`s.
- **`interrupt()` only aborts a run in the process that receives it.** Hit the
  wrong instance and the abort silently does nothing — but
  `agent.run.interrupted` is still published, so every client shows the run as
  stopped while the agent keeps streaming. That is worse than a no-op: the UI
  lies.

`queueDepth` is likewise local, so the `skip`-mode signal undercounts.

Note what is *not* broken: a message is submitted to `TurnController` only by
the instance that received the HTTP request, so two instances never answer the
same message twice. See [ROADMAP](./ROADMAP.md).
