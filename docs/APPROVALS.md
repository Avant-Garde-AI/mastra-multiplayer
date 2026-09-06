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
   answer, and a factory for it is [R6](./ROADMAP.md#r6--workflow-step-factory-for-gates).

For a gate that needs to stay open for hours or days across deploys, none of
these is enough — put it in a durable execution engine (Temporal, Inngest,
Restate, Durable Objects) and use this package for the human-facing half.

## Expiry is lazy

`evaluate()` compares against the clock, but nothing fires on its own. A request
expires when someone next calls `vote()` or `refresh()` on it.

Practically: a gate that expires at 3am is still `pending` in the store at 8am
and resolves when the first person opens the page. Call `refresh()` from your own
scheduler if the resolution time needs to be accurate. Making this less
awkward is [R8](./ROADMAP.md#r8--durable-expiry).

## Known limitation: policies do not survive a restart

`ApprovalGate` keeps policies in a process-local `Map` keyed by approval id. The
`ApprovalRequest` persists `policyName` — a label — but not the policy.

Restart the process with a request still pending, and the gate falls back to
`defaultApprovalPolicy` (or `{ name: "default" }`, i.e. `quorum: 1`). **A
four-eyes gate becomes a one-signature gate across a deploy**, and nothing warns
you.

Until [R2](./ROADMAP.md#r2--persisted-approval-policies)
lands, either keep `expiresAfterMs` shorter than your deploy cadence, or pass
the same non-default `defaultApprovalPolicy` you use for gates so the fallback
is not weaker than the intent.

## Client-side rendering

`evaluate()` and `remainingApprovals()` are pure and exported, so a UI can
render "1 of 2 approvals" without a round trip:

```ts
import { evaluate, remainingApprovals, fourEyes } from "mastra-multiplayer";

const left = remainingApprovals(fourEyes(), request); // 2 → 1 → approved
```

The server remains the authority. This is for copy, not for decisions.
