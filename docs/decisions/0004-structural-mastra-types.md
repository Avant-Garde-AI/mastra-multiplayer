# 0004 — Mastra and Hono types are declared structurally, not imported

**Status:** Accepted · `0.1.0`

## Context

The package integrates with Mastra agents and serves routes into Mastra's Hono
server. The natural approach is to import `Agent` from `@mastra/core` and
`Context` from `hono` and use them directly.

That would make both hard dependencies of a package whose core primitives —
presence, turn-taking, the policy engine, the bus — need neither, and would pin
consumers to whichever versions this package resolved.

## Decision

Declare the slice actually used, structurally:

```ts
interface AgentLike {
  id?: string; name?: string; instructions?: string;
  stream(input: string, options?: Record<string, unknown>):
    Promise<{ textStream: AsyncIterable<string> }>;
}

interface HonoLikeContext { req: { param; query; json; header }; json; body; get; }
```

`@mastra/core` and `react` are optional peer dependencies. Nothing under `src/`
imports either.

## Consequences

**Good.** The package installs and compiles with no Mastra present, which is
what lets the whole test suite run against a fake agent — a generator yielding
strings — with no model, no API key, and no network. That is why the suite
finishes in about a second, and it is the single biggest contributor to the
project being pleasant to work on. Consumers control their own Mastra version.

**Costs.** The structural types can drift from Mastra's real ones, and nothing
catches it at compile time — a signature change surfaces as a runtime failure in
someone's app rather than a red build here. The convention when Mastra's shape
changes is to *widen* these types, not to start importing.

`examples/` carries `@ts-nocheck` because it imports the real packages, which
are not installed. That is a small ongoing wart: the examples are not
type-checked, so they can rot without anyone noticing.

## Revisit when

Drift causes a real bug in a real consumer, or the examples rot far enough that
they mislead. The fix then is probably a dev-dependency on `@mastra/core` and a
type-level compatibility test, not making it a hard runtime dependency.
