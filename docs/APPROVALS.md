# Approvals

Human-in-the-loop stops being simple the moment there is more than one human.
"Wait for a human to click yes" is one line of code. "Wait for two humans, not
counting whoever asked, both of whom must be allowed to approve this kind of
thing, and treat silence as refusal" is a policy engine.

## The lifecycle

```
request()  →  pending  →  vote()  →  approved
                    ↘             ↘  denied
                     ↘  refresh() →  expired
```

Every step writes to the audit ledger with the acting participant attached.

## Policies

A policy answers four questions: how many, who, what does a "no" mean, and what
does silence mean.

```ts
interface ApprovalPolicy {
  name: string;
  quorum?: number;               // default 1
  excludeRequester?: boolean;    // default false
  allowedRoles?: ParticipantRole[];   // default ["owner", "editor", "approver"]
  allowedParticipants?: ParticipantId[];
  denyIsFinal?: boolean;         // default true
  expiresAfterMs?: number;       // default 15 minutes
  onExpiry?: "deny" | "approve"; // default "deny"
}
```

Three built-ins cover the patterns that show up in governance reviews:

```ts
import { fourEyes, quorumOf, approverOnly } from "mastra-multiplayer";

fourEyes()     // two approvals, requester excluded (maker-checker)
quorumOf(3)    // any three eligible participants
approverOnly() // one signature, but only from an approver or owner
```

Each takes overrides:

```ts
fourEyes({ expiresAfterMs: 60 * 60 * 1000, allowedRoles: ["approver"] })
```

Prefer adding a policy over adding a flag to an existing one. A policy is a
named governance decision that can be pointed at in a review; a boolean is not.

### Building policies from config

`mergePolicy()` layers a policy over the defaults and **skips keys that are
explicitly `undefined`**, which is what makes this safe:

```ts
quorumOf(2, { allowedRoles: config.approverRoles })  // may be unset
```

A plain spread would set `allowedRoles: undefined` and `canVote` would throw on
`.includes()`. Two other keys fail more quietly:

| Key, set to `undefined` | Effect without `mergePolicy` |
| --- | --- |
| `quorum` | `approvals.length >= undefined` is false for every count — **the gate never approves** |
| `denyIsFinal` | Falsy, so **a deny stops resolving the request** |
| `allowedRoles` | `canVote` throws a `TypeError` |

Two directions of failure for a governance control, plus a crash, all reached
through ordinary calling code — which is why the handling lives in one place
rather than at each call site.

(`expiresAfterMs` and `onExpiry` happen to be safe under a spread:
`request()` resolves the expiry with `??` at creation time, and an `undefined`
`onExpiry` falls through to the same `"deny"` the default specifies. They go
through `mergePolicy` anyway, because relying on that coincidence is how the
next key becomes a bug.)

### The defaults are opinionated

- **Deny is final.** One "no" resolves the request. Wanting the opposite is
  unusual enough to be worth writing down: `denyIsFinal: false`.
- **Expiry denies.** Silence is not consent. `onExpiry: "approve"` exists
  because timeouts-to-allow are a real pattern in low-stakes flows, but it
  should be a deliberate choice.
- **No one votes twice.** Enforced by `canVote`, not by the caller.
- **`allowedParticipants` widens, it does not narrow.** It is checked as an
  escape hatch when the role check fails, so listing someone there lets them
  vote regardless of role. It cannot be used to restrict a role that is already
  permitted.

## Argument binding

The threat is an approval granted for one action being reused for another.
Approving a $40 refund must not authorize a $4,000 one.

Every request stores a SHA-256 over the tool name and a *stable* serialization
of the arguments — keys sorted, `undefined` dropped — so `{a:1,b:2}` and
`{b:2,a:1}` hash identically while `{amount:40}` and `{amount:4000}` do not.

```ts
gate.assertBinding(request, "refund-order", actualArgs); // throws on mismatch
await issueRefund(actualArgs);
```

**Call it immediately before the side effect, not at approval time.** Anything
in between is a window. This is the whole point of the mechanism: an approval is
a signature on one specific call, not a permission that lingers.

## The tool pattern

The shape used in [`examples/approval-gate/refund-tool.ts`](../examples/approval-gate/refund-tool.ts):

```ts
execute: async ({ context, runtimeContext }) => {
  const request = await multiplayer.approvals.request({
    sessionId: runtimeContext.get("sessionId"),
    requestedBy: runtimeContext.get("participantId"),
    toolName: "refund-order",
    toolArgs: context,
    summary: `Refund $${context.amountCents / 100} on order ${context.orderId}`,
    policy: fourEyes(),
  });

  const resolved = await waitFor(request.id);          // poll or suspend
  if (resolved.status !== "approved") {
    return { status: resolved.status, approvalId: request.id };
  }

  multiplayer.approvals.assertBinding(resolved, "refund-order", context);
  await issueRefund(context);
  return { status: "refunded", approvalId: request.id };
}
```

`requestedBy` must come from verified identity — the runtime context your
authenticated route populated — and never from a model-supplied argument. A
model that can name the requester can name someone else and defeat
`excludeRequester`.

## Waiting for a decision

The decision arrives over HTTP from whoever votes, so the tool has to wait for
something outside its own call stack. Options, worst to best:

1. **Poll `store.getApproval()`.** What the example does. Simple, works, burns
   a run for the duration.
2. **Subscribe to the bus** for `approval.resolved` on that session. Better,
   still holds the process.
3. **Suspend a workflow step** with Mastra's `suspend()`/`resume()`. The right
   answer, and [R6](./ROADMAP.md#r6--workflow-step-approval-gates) builds it —
   both the step *and* the resumer that wakes it when a vote lands, which is the
   half that is easy to forget. See the
   [plan](./roadmap/0.4.0-integration.md#r6--workflow-step-approval-gates).

For a gate that needs to stay open for hours or days across deploys, none of
these is enough — put it in a durable execution engine (Temporal, Inngest,
Restate, Durable Objects) and use this package for the human-facing half.

## Expiry needs something to drive it

`evaluate()` compares against the clock, but nothing fires on its own. Left
alone, a gate that expires at 3am sits `pending` in the store until someone
votes or refreshes it — so "silence is not consent" only holds if something does
the asking.

Drive it from whatever scheduler your application already runs:

```ts
// Per session, when you know which are live.
const resolved = await multiplayer.approvals.sweepExpired(sessionId);

// Or across every session, for hosts that do not track that.
const resolved = await multiplayer.sweepExpiredApprovals();
```

Each returns the requests that resolved, and each publishes
`approval.resolved` and writes to the audit ledger exactly as a vote would. It
is idempotent — a second sweep resolves nothing — and one unreadable record does
not strand the rest of the session.

**`resolvedAt` is the deadline, not the sweep time.** A request that expired at
3am records 3am even if nothing noticed until 9am; the ledger's job is to answer
*when was this decided*, and the answer is when the window closed. The same
holds for a vote that lands after expiry.

### Why no timer in here

The right cadence depends on how tight your approval windows are, and a library
that owns a scheduler owns a shutdown story, a leader-election story on more
than one instance, and a surprise for anyone who imports it in a script. Sweep
every minute, or every hour, or on each page load — it is your call, and it is
one line.

## Policies are stored on the request

The **resolved** policy — every defaultable field filled in — is written onto
the `ApprovalRequest` when it is created, and read back from there on every vote
and refresh.

```ts
request.policy
// { name: "four-eyes", quorum: 2, excludeRequester: true,
//   allowedRoles: [...], denyIsFinal: true, expiresAfterMs: 900000,
//   onExpiry: "deny" }
```

This matters for two reasons beyond surviving a restart:

- **A later release that changes a default cannot retroactively change a
  pending gate.** The decision a requester saw is the decision that resolves.
- **The record is self-describing.** An auditor reading the ledger months later
  can see the rule that was applied, not just its name.

Storing the resolved policy rather than the caller's sparse object is the whole
point. `fourEyes()` names a rule; `{ quorum: 2, excludeRequester: true, ... }`
*is* the rule.

A request created before this existed has no `policy`, and the gate falls back
to its configured default with a loud `console.error` naming the approval —
that fallback is the exact failure this design ends, so it is never silent.

## Client-side rendering

`evaluate()` and `remainingApprovals()` are pure and exported, so a UI can
render "1 of 2 approvals" without a round trip:

```ts
import { evaluate, remainingApprovals, fourEyes } from "mastra-multiplayer";

const left = remainingApprovals(fourEyes(), request); // 2 → 1 → approved
```

The server remains the authority. This is for copy, not for decisions.
