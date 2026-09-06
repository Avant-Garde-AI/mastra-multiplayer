# 0001 — Two storage systems

**Status:** Accepted · `0.1.0`

## Context

A shared agent session has two kinds of state: the conversation (messages,
threads, memory) and the social layer around it (who is in the room, who is
present, what has been approved, who did what).

Mastra already owns the first. It has storage adapters, memory processors,
thread and message APIs, and semantic recall. The tempting move is to store
everything in one place — one store, one query to render a session, no
coordination.

## Decision

`MultiplayerStore` covers only the roster, presence, approvals, and audit.
Messages and threads stay in Mastra's storage. A `SessionRecord` holds a
`threadId` and nothing more of the conversation.

## Consequences

**Good.** One source of truth for messages. Mastra's memory features —
processors, working memory, semantic recall — keep working untouched, because
this package never intercepts the transcript. The interface stays small enough
that implementing it against a real database is an afternoon rather than a
project.

**Costs.** Rendering a session takes two reads, against two systems. There is no
transaction spanning both, so a session can exist with a thread that does not,
or outlive one. Nothing enforces that both point at the same database, so
retention and deletion have to be handled in two places — worth knowing before
a compliance conversation rather than during one.

`GET /state` returns roster, presence, and approvals but **not** messages, which
surprises people until they know why. It is documented in
[HTTP-API](../HTTP-API.md#get-sessionssessionidstate).

## Revisit when

Mastra models participants or approvals itself. At that point most of this
package's storage layer should be deleted rather than reconciled.
