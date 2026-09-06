# Architecture

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
you two sources of truth and a reconciliation bug.

## Why SSE and not WebSockets

Every event in a shared agent session flows server → client: someone else's
message, a presence change, a token from the agent. The few client → server
actions (send, vote, heartbeat) are ordinary POSTs that want normal HTTP
semantics — auth, retries, status codes.

SSE also survives the boring infrastructure better. It is plain HTTP, so it
passes through proxies and CDNs that mangle WebSocket upgrades, and it
reconnects with `Last-Event-ID` for free. Mastra's own agent streaming is
already SSE, so there is one transport rather than two.

The cost is head-of-line blocking on HTTP/1.1 connection limits. If you need
live cursors at 60fps, add a dedicated CRDT transport alongside this rather
than replacing it.

## Sequencing and replay

Every event gets a monotonic per-session `seq`. Clients track the highest they
have seen and send it on reconnect, which turns a dropped connection from a
correctness problem into a latency one.

The replay buffer is bounded (200 events by default). A client gone longer than
that should refetch session state rather than replaying — the buffer is for
network blips, not for cold starts.

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

## What is deliberately not here

- **Message storage.** Mastra's memory owns it.
- **Multi-agent routing.** Different problem, well covered elsewhere.
- **Durable execution.** Checkpoints are not durable execution. If a gate needs
  to stay open for days across deploys, put it in Temporal, Inngest, Restate,
  or Durable Objects and use this package for the human-facing half.
- **A UI.** The hook is headless. Design systems do not survive being vendored.
