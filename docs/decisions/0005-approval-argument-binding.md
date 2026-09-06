# 0005 — Approvals are bound to a hash of the exact call

**Status:** Accepted · `0.1.0`

## Context

"Human approved this" is the easy half. The hard half is *what*, exactly, was
approved.

A naive gate stores a boolean against a request id, waits for a human to say
yes, and then executes whatever arguments the tool has at that moment. Between
approval and execution the arguments can change — a retried run, a re-planned
tool call, a model that recomputes its input, or an attacker who found the
resume endpoint. The human approved "refund $40 on order 123" and the system
executes "refund $4,000 on order 456", with a genuine approval attached.

That failure is undetectable after the fact. The audit ledger shows a real
person approving a real request, and the amount is simply different.

## Decision

Every `ApprovalRequest` stores `bindingHash`: SHA-256 over the tool name and a
*stable* serialization of the arguments — object keys sorted, `undefined`
dropped, arrays positional. `assertBinding(request, toolName, args)` recomputes
it and throws `binding_mismatch` unless it matches, and must be called
immediately before the side effect.

An approval is a signature on one specific call, not a permission that lingers.

## Consequences

**Good.** `{a:1,b:2}` and `{b:2,a:1}` hash identically, so an approval survives
harmless reserialization; `{amount:40}` and `{amount:4000}` do not, so it does
not survive a changed value. The check is cheap, local, and requires no
coordination — a stateless function of the request and the call.

**Costs.** Any legitimate change to the arguments invalidates the approval and
requires a new one. This is correct and occasionally annoying: normalizing a
string, adding a defaulted field, or attaching a trace id between approval and
execution all break the binding. Normalize arguments *before* requesting
approval, so the human approves the same shape that executes.

The check is only as good as its placement. Calling `assertBinding()` early and
executing later reopens exactly the window it closes, and nothing enforces the
ordering — it is a discipline, documented in
[APPROVALS](../APPROVALS.md#argument-binding).

Non-JSON values (`Date`, `Map`, class instances) in `toolArgs` serialize
through `JSON.stringify` semantics and may hash unstably across a store
round-trip. Keep tool arguments plain.

## Revisit when

Someone needs an approval that legitimately covers a *range* rather than a value
— "refunds up to $100 for this customer today". That is a different primitive, a
standing authorization with its own expiry and budget, and it should be built
alongside binding rather than by loosening it.
