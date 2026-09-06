# 0002 — SSE for server→client, plain POSTs for client→server

**Status:** Accepted · `0.1.0`

## Context

A shared session needs a live channel. WebSockets are the reflexive answer for
anything called "multiplayer".

But look at the actual traffic. Almost everything flows server → client:
someone else's message, a presence change, a token from the agent, an approval
resolving. The client → server actions — send, vote, heartbeat, interrupt — are
infrequent, discrete, and want ordinary HTTP semantics: auth headers, status
codes, retries, idempotency, a response body.

## Decision

SSE for the server → client stream. Plain JSON POSTs for everything the client
initiates.

## Consequences

**Good.** One transport, since Mastra's own agent streaming is already SSE.
Reconnection with `Last-Event-ID` is free and standard. It is plain HTTP, so it
passes through proxies and CDNs that mangle WebSocket upgrades, and every piece
of HTTP infrastructure — auth middleware, rate limiters, logging — applies to
the write path unchanged.

**Costs.** Head-of-line blocking against HTTP/1.1 per-origin connection limits;
six tabs on the same origin is a real ceiling. No client → server channel on the
stream itself, so a heartbeat is a POST rather than a frame — more requests,
though cheap ones.

`EventSource` cannot send custom headers, which means bearer-token auth does not
work on the stream while working everywhere else. This is the sharpest edge of
the decision and is documented at
[HTTP-API](../HTTP-API.md#bearer-tokens-do-not-work-on-the-stream).

60fps cursor updates are not viable over this. That is the intended
consequence, not an oversight — see below.

## Revisit when

Live cursors or CRDT co-editing ([R11](../ROADMAP.md#r11--shared-state--co-editing))
become real requirements. The answer then is a *dedicated* bidirectional
transport alongside this one, not replacing it. Chat, presence, and approvals do
not need a socket, and making them share one with a CRDT couples two very
different scaling stories.
