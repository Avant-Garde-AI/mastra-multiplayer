# Contributing

```bash
npm install
npm run check     # typecheck + tests + doc links — run this before pushing
npm run build     # tsup → dist/
```

Individually: `npm test` (vitest), `npm run typecheck` (tsc --noEmit),
`npm run docs:check` (relative markdown links and heading anchors). After a
build, `node scripts/check-exports.mjs` verifies the published `exports` map —
the tests import from `src/`, so they stay green even if the build stops
emitting an entry point.

CI runs all of it on Node 20 and 22 for every push and pull request.

## Conventions

- Everything in `src/` is dependency-free except for `node:crypto`. Mastra,
  React, `@libsql/client`, and `ioredis` are peer dependencies and must stay
  optional — the
  core primitives are testable without any of them installed. A driver import
  belongs in its own subpath module, never on a path the root entry point
  reaches.
- A change to `MultiplayerStore` semantics belongs in
  `src/storage/conformance.ts`, not only in a test file. That suite is what a
  third-party implementation is checked against; a contract that lives only in
  our tests is a contract nobody else can meet.
- Mastra types are declared structurally (`AgentLike`, `HonoLikeContext`)
  rather than imported, so the package compiles standalone. When Mastra's shape
  changes, widen these rather than importing.
- New behaviour needs a test. The approval policy engine in particular is pure
  and has no excuse.
- Prefer adding a mode or policy over adding a flag to an existing one.
- Every HTTP route goes through `guard()`, which answers both "who is this" and
  "may they be here". A route that reads `authenticate` directly has skipped the
  second question. `test/server.test.ts` asserts that every route reports its
  action to `authorize`, so a new one that forgets will fail.

## Documentation

Docs live in [`docs/`](./docs) and are part of the change, not a follow-up.

- If a change alters behaviour someone could rely on, update the page that
  describes it in the same commit. A page describing something the code does not
  do is a bug in the page.
- Roadmap items have stable ids (`R1`, `R2`, …). Reference them in commits and
  issues, and move the item's status when the work lands rather than leaving the
  list to drift.
- A choice that is hard to reverse, or that you have now explained twice, earns
  a [decision record](./docs/decisions). Include what it costs and what would
  reopen it — a record with no downsides listed is a justification, not a
  decision.

## Testing against real infrastructure

The Redis bus is tested against a real `redis-server`, not a fake. The guarantee
it makes — that a sequence is never issued twice across processes — is a
property of Redis, so a fake would only be checking our own assumptions.

`redis-server --port 6399` locally; CI runs a service container. The tests skip
with a warning when Redis is unreachable, **except under `CI`, where they fail**
— a silent skip there would quietly delete the only coverage of the thing the
class exists for.

Same reasoning applies to the LibSQL store: real SQLite, and one test that
reopens an actual file, because an in-memory database passes every other test
in the file without proving durability.

## Naming

The `@mastra/*` npm scope is controlled by the Mastra org. Community packages
use either an unscoped `mastra-` prefix or their own scope. Do not publish
under `@mastra/`.
