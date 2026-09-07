# Decision records

Choices that would otherwise be re-litigated every few months, with the
reasoning attached. One file per decision, numbered, never renumbered.

| | Decision | Status |
| --- | --- | --- |
| [0001](./0001-two-storage-systems.md) | Two storage systems: Mastra owns messages, this package owns the social layer | Accepted |
| [0002](./0002-sse-over-websockets.md) | SSE for server→client, plain POSTs for client→server | Accepted |
| [0003](./0003-heartbeat-presence.md) | Presence is heartbeat-based, not connection-based | Accepted |
| [0004](./0004-structural-mastra-types.md) | Mastra and Hono types declared structurally, not imported | Accepted |
| [0005](./0005-approval-argument-binding.md) | Approvals are bound to a hash of the exact call | Accepted |
| [0006](./0006-local-resume-not-bus.md) | Workflow resumption is driven locally and reconciled from the store | Accepted |

## Writing one

Add a record when a choice is (a) hard to reverse, (b) likely to be questioned
by someone who was not there, or (c) something you already had to explain twice.

Keep the shape: **Context** (the forces), **Decision** (what was chosen),
**Consequences** (what it costs, honestly), and **Revisit when** (the concrete
signal that would reopen it). That last section is what separates a decision
record from a justification.

A superseded record is not deleted. Mark it superseded, link forward, and leave
the original reasoning in place — the reason a decision was later wrong is
usually more useful than the decision.
