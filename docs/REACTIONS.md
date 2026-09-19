# Durable reactions

`TurnController` answers what to do when messages reach one running process at
the same time. A reaction runtime answers a different question: after a shared
conversation produces a burst of durable events, should the agent respond at
all, when should it run, and which worker is allowed to commit the result?

Use `@avant-garde/mastra-multiplayer/reactions` for webhook-driven channels,
long quiet windows, cron workers, and any deployment where an instance can die
between receiving a message and producing a response.

## Shape of the system

```text
provider webhook -> normalize -> ReactionStore.ingest
                                      |
scheduler/queue -> ReactionBus.runNext -> ReactionPolicy
                                      -> fenced claim
                                      -> ReactionRunner
                                      -> atomic result + 0/1 response intent
                                      |
provider dispatcher <- application outbox
```

The runtime never authenticates a provider, downloads private media, generates
application-specific proposals, or sends a response. Those remain host
responsibilities. In particular, a runner returns a **draft response intent**;
only a successful store commit makes that intent dispatchable.

## Burst policy

```ts
import {
  createBurstReactionPolicy,
  createReactionBus,
} from "@avant-garde/mastra-multiplayer/reactions";

const reactions = createReactionBus({
  store,
  policy: createBurstReactionPolicy({
    quietMs: 3_000,
    addressedDelayMs: 500,
    maxWaitMs: 15_000,
    maxBatchSize: 20,
  }),
  runner,
});

await reactions.ingest(normalizeProviderEvent(webhook));
await reactions.runNext({ workerId: process.env.INSTANCE_ID! });
```

The policy is pure and clock-driven:

- ordinary contributions extend a trailing quiet window;
- `maxWaitMs` prevents continuous conversation from postponing work forever;
- direct-address signals use a shorter coalescing delay;
- trusted urgent signals and a full batch run immediately;
- reaction-only traffic is consumed as successful silence;
- a paused session consumes pending work without running the model;
- `respondToAmbient: false` can still run an observer with zero authorized
  response intents.

Mention and urgency fields are trusted adapter classifications. Never infer
authority from message text inside the generic policy.

## Store semantics

`ReactionStore` is intentionally separate from `MultiplayerStore`. The latter
owns rooms, presence, approvals, and audit. The former is a transactional work
queue with stronger requirements:

1. `ingest` deduplicates by provider/account/route-scoped key. A duplicate does
   not extend a deadline or spend a budget.
2. `claimDue` evaluates policy, seals immutable event membership, assigns a
   stable batch id, reserves response budget, and grants a lease.
3. A retry keeps the batch id and event ids but increments its numeric fence.
4. `complete` accepts only the current fence. It atomically persists the
   canonical output, advances consumed evidence, and creates zero or one
   response intent.
5. A repeated completion returns the canonical committed output, not the
   caller's competing draft.
6. Consent, roster, or pause changes invalidate a stale attempt before commit.
7. `suppress/consume` is durable successful silence. `suppress/defer` retains
   evidence for a later policy decision.

`InMemoryReactionStore` is a reference implementation for tests and local
prototypes. It is not durable and is not suitable for multiple processes.

## Running a Mastra session

`createSessionReactionRunner()` adapts a claim to
`MultiplayerSession.runBatch()`. This preserves speaker attribution, roster
context, Mastra memory scoping, lifecycle events, and existing turn leases.

```ts
import {
  createSessionReactionRunner,
} from "@avant-garde/mastra-multiplayer/reactions";

const runner = createSessionReactionRunner(multiplayer);
```

`busy`, failed, and (by default) interrupted Mastra runs are released for
retry. Completed text becomes a response intent only when policy authorized
one. The adapter never delivers that text to a provider.

## Conformance

Database adapters should run the framework-neutral checks from
`@avant-garde/mastra-multiplayer/reactions/conformance`:

```ts
import { reactionConformanceChecks } from
  "@avant-garde/mastra-multiplayer/reactions/conformance";

for (const check of reactionConformanceChecks()) {
  it(`${check.group} - ${check.name}`, () =>
    check.run((options) => makeFreshReactionStore(options)));
}
```

The checks cover deduplication, burst membership, bounded batches, durable
wait/defer, successful silence, crash recovery, fencing, canonical replay,
state revision invalidation, and concurrent response-budget reservation.

Provider submission and callback reconciliation belong to a separate adapter
suite because provider idempotency guarantees vary. A dispatcher should model
`not_submitted`, `accepted`, `delivered`, `rejected`, and `unknown` explicitly;
an unknown submission outcome must not be retried blindly.
