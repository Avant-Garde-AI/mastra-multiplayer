# Contributing

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run build     # tsup → dist/
```

## Conventions

- Everything in `src/` is dependency-free except for `node:crypto`. Mastra and
  React are peer dependencies and must stay optional — the core primitives are
  testable without either installed.
- Mastra types are declared structurally (`AgentLike`, `HonoLikeContext`)
  rather than imported, so the package compiles standalone. When Mastra's shape
  changes, widen these rather than importing.
- New behaviour needs a test. The approval policy engine in particular is pure
  and has no excuse.
- Prefer adding a mode or policy over adding a flag to an existing one.

## Naming

The `@mastra/*` npm scope is controlled by the Mastra org. Community packages
use either an unscoped `mastra-` prefix or their own scope. Do not publish
under `@mastra/`.
