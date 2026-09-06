# 0003 — Presence is heartbeat-based, not connection-based

**Status:** Accepted · `0.1.0`

## Context

The obvious implementation of presence is "who holds an open connection". It is
free — the transport already tracks it — and it is wrong in two ordinary cases.

A participant on Slack has no long-lived socket to this server at all, so they
would never be present. And a browser tab that crashes, sleeps, or loses network
never sends a clean disconnect, so they would be present forever.

Both failures are silent, and the second is worse: a stale roster makes people
believe someone is watching who is not.

## Decision

Presence is "who checked in recently". Participants heartbeat, and a background
sweep ages them `active → idle → dropped` on configurable windows (30s / 90s by
default). Presence state lives in the store, not in connection objects.

## Consequences

**Good.** Works identically for a web client, a Slack adapter, and an API
consumer — anything that can make an HTTP request can be present. Crashes
resolve themselves. Presence survives a reconnect, so a client bouncing between
networks does not flicker out of the room. The sweep is testable with an
injected clock, and the tests use one.

**Costs.** A POST per participant per interval — real traffic on a busy
deployment, and a real write amplification problem if presence goes in your
primary database ([STORAGE](../STORAGE.md#presence-is-not-durable-state)
recommends Redis with a TTL). Presence lags reality by up to the drop window, so
someone who closes their laptop stays visible for up to 90 seconds. That is the
right trade — a false "present" for 90 seconds is much less damaging than a
false "gone" — but it should be a deliberate one.

The distinction this creates is the thing to hold onto: **roster and presence are
different**. Being disconnected is not leaving. Conflating them evicts people
from the room every time their network hiccups, which was a real bug —
[F1](../reviews/2026-09-06-launch-review.md#f1--a-dropped-sse-stream-evicted-people-from-the-roster).

## Revisit when

Never, probably. This is settled design in every system that has tried both.
