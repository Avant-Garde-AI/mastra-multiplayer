# Concurrency

Two people type at once. What happens?

A single-user chat loop never has to answer this. A shared session has to answer
it on every message, and the answer is a product decision rather than a
technical one — which is why it is a mode you pick rather than a behaviour the
package assumes.

## Picking a mode

```ts
createMultiplayer({ agent, concurrency: { mode: "batch", windowMs: 2000 } });
```

| Mode | Behaviour | Pick it when |
| --- | --- | --- |
| `queue` | Run turns in arrival order, one at a time | **Default.** Every message deserves a reply. |
| `debounce` | Wait for a quiet window, run only the last message | Someone thinks out loud across several messages. |
| `batch` | Collect a window into one turn | A group is riffing and you want one coherent reply. |
| `skip` | Drop messages arriving mid-run | High-volume channels where a stale answer is worse than none. |
| `preempt` | Abort the in-flight run, start over | "Stop, do this instead" is common in your product. |

Options: `windowMs` (default 1500, used by `debounce` and `batch`) and
`maxBatchSize` (default 10).

## What each mode assumes — and discards

The modes are not interchangeable, and picking wrong is not subtle. Each one
encodes an assumption about what a group is doing, and each throws something
away when the assumption is wrong.

- **`queue`** assumes every message deserves a reply. Discards nothing;
  costs latency. In a busy session the agent falls behind and answers a
  question the room moved past ten minutes ago.
- **`debounce`** assumes the last message supersedes the earlier ones. True for
  one person refining a thought. **Catastrophically false for three people
  talking** — it silently discards what most of them said, and nobody is told.
  Read that sentence again before choosing `debounce` for a group.
- **`batch`** assumes the messages are one collective thought. The best default
  for genuinely collaborative sessions, and the one that pairs with attribution:
  the agent sees `[Alice]: … / [Bob]: …` in one prompt and can answer both,
  or point out that they conflict.
- **`skip`** assumes stale requests are worse than dropped ones. Honest about
  discarding, but discards without telling anyone. If you use it, surface
  "the agent was busy" in the UI — `queueDepth()` is returned by the messages
  endpoint for exactly this.
- **`preempt`** assumes the newest instruction overrides whatever is running.
  Powerful and easy to weaponize: in a shared session, one person can cancel
  everyone else's turn by typing. Fine when the room is a pair; questionable
  when it is a dozen people.

If you are unsure, `queue` is the safest and `batch` is the one most shared
sessions actually want.

## Cancellation

`preempt` and `interrupt()` both fire an `AbortSignal`, which is passed through
to `agent.stream` as `abortSignal` and is available on `TurnContext.signal`.
Tools that do real work should honour it:

```ts
buildStreamOptions: ({ signal }) => ({ abortSignal: signal })
```

The streaming loop checks `signal.aborted` between deltas, so an aborted run
stops publishing quickly rather than at the end of the response.

`interrupt()` also clears the queue and any pending debounce/batch window.
Anyone in the session may call it — this is deliberate, on the theory that a
room can always stop its own agent, but note it is not role-gated.

## Guarantees, precisely

- **One run at a time per session.** `TurnController` is the only thing that
  starts a run, and `drain()` will not start one while `running` is true.
- **Order is preserved within a session** for `queue` and `batch`.
- **No cross-session interference.** State is keyed by `sessionId`.
- **A thrown runner does not wedge the session.** Errors are logged and
  `running` is cleared in a `finally`, so the queue keeps draining. Errors from
  an aborted run are swallowed on purpose.

## What is not guaranteed

- **Nothing survives a process restart.** The queue and pending windows are in
  memory. A restart mid-turn loses the queue silently.
- **Turn-taking is per-process unless you give it a lease.** Without one, two
  people posting to *different* instances at the same moment start two
  concurrent runs into one session. See below.
- **Messages are published to the room before the mode is applied.** Everyone
  sees every message in the transcript even when the agent skips or debounces
  it away. This is intentional — humans should see what other humans said —
  but it means "in the transcript" and "the agent read it" are different things,
  and a UI that implies otherwise will mislead people.

## Running on more than one instance

`TurnController` enforces "one run at a time per session" with an in-memory
flag — correct in one process, and silently wrong in two. A `TurnLease` makes
it true across processes:

```ts
import { RedisTurnLease } from "@avant-garde-ai/mastra-multiplayer/concurrency/redis-lease";

createMultiplayer({
  agent,
  bus,
  concurrency: {
    mode: "queue",
    lease: new RedisTurnLease(new Redis(url)),
    leaseTtlMs: 30_000,   // default
    leaseRetryMs: 250,    // default
  },
});
```

An instance takes the lease before running, renews it while streaming, and
releases it at the end. An instance that cannot take it **waits and retries**
rather than dropping the message — the reply is still owed once the other
instance finishes.

What this is not: a message is submitted to `TurnController` only by the
instance that received the HTTP request, so nobody was ever answering the same
message twice. The bug is *concurrent* turns, not duplicated ones.

### Two things the lease costs you

- **A lost lease aborts the run.** If renewal fails — a Redis blip, or a stall
  past the TTL — the run is aborted, because another instance may already have
  taken over and continuing would produce exactly the interleaved output the
  lease prevents. The cost is real: a network hiccup cuts a legitimate reply
  short. Raise `leaseTtlMs` if your agent runs long and your Redis is flaky.
- **A lease backend that is down stops turns entirely.** `acquire` failing is
  treated as "not acquired", logged, and retried. Degrading to "run anyway"
  would silently reintroduce the bug the lease exists to prevent, so it does
  not.

Without a lease, session affinity at the load balancer gets you the same
guarantee for free, and fails only when an instance dies mid-session. That is a
legitimate choice, not a workaround.

### Interrupts cross instances

`interrupt()` aborts locally and publishes `agent.run.interrupted`. A run in
flight listens for that event for its duration, so an interrupt raised on any
instance stops the run wherever it is actually happening.

This needs no lease and is on by default. Before it, hitting the wrong instance
published the event and aborted nothing — every client showed the run stopped
while the agent kept streaming.

## Not addressed to the agent

```ts
await multiplayer.send({ sessionId, participantId, text, addressedToAgent: false });
```

The message is broadcast to the room and written to the audit ledger, but never
reaches `TurnController`. This is how side conversation between humans works in
a shared session without provoking a reply to every line.

Whatever decides `addressedToAgent` — an @-mention, a UI toggle, a channel
convention — is your application's call.
