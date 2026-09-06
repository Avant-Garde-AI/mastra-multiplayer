# Launch review — 2026-09-06

Scope: all of `src/`, `test/`, `examples/`, and the packaging metadata, at
`0.1.0`, two commits in. Baseline: `npm run build`, `npm run typecheck`, and
`npm test` (26 tests) all green before any change.

## Summary

The codebase is in better shape than most day-two projects. The module
boundaries are real — `EventBus`, `TurnController`, `ApprovalGate`, and
`PresenceManager` each do one thing and depend on the others through narrow
interfaces, which is what makes the `0.2.0` distribution work tractable rather
than a rewrite. The policy engine is pure and tested. `structuredClone` in the
in-memory store means tests cannot accidentally rely on shared mutable state.

Findings below are split into what was fixed in this pass and what became a
roadmap item. Nothing found was a reason to delay anything; the three fixed
defects were each small, local, and testable.

## Fixed in this pass

### F1 · A dropped SSE stream evicted people from the roster

`src/server/index.ts` — the stream's `cancel` handler called
`presence.leave()`, which publishes `participant.left`. The client reducer
treats that event as removal from the roster.

An SSE stream closes on every reconnect, tab switch, network change, and laptop
lid. It also closes when someone with two tabs open closes one. In all of those
cases the person is still in the session, and everyone else's roster just lost
them. Because the client reconnects automatically, the roster would flap.

**Fix.** Added `PresenceManager.disconnected()`: clears presence, broadcasts
`presence.updated`, and does not touch the roster. `leave()` keeps its old
behaviour for an actual departure via `POST /leave`. Two tests.

A dropped transport and a departure are different events. Conflating them is
the recurring bug in every presence system.

### F2 · A client opening a live session rendered an empty room

`src/client/index.ts` — the client's only source of state was the SSE stream,
whose replay buffer holds 200 events and is explicitly documented as covering
network blips rather than cold starts. Someone opening a session that had been
running for an hour saw no roster, no presence, and no pending approvals — an
open approval gate simply would not appear.

**Fix.** Added `GET /sessions/:id/state` returning the session record, roster,
presence, and pending approvals, plus the `seq` the snapshot is consistent with
(via a new `EventBus.currentSeq()`). `MultiplayerClient.hydrate()` applies it,
and `start()` sequences join → hydrate → connect so the stream opens *from* the
snapshot's sequence.

Ordering is the subtle part. Hydrating after connecting leaves a window where
replayed frames below `snapshot.seq` are still in flight and would be dropped by
the cursor jumping forward, so `hydrate()` only adopts the snapshot's sequence
when no stream is open yet.

### F3 · An `undefined` policy override silently replaced a default

`src/approvals/policy.ts` — both `canVote` and `evaluate` resolved a policy with
`{ ...DEFAULT_POLICY, ...policy }`. A spread does not skip `undefined` values,
so a policy assembled from optional config replaced defaults with `undefined`:

```ts
quorumOf(2, { allowedRoles: config.approverRoles })  // roles unset
```

Checking each optional key against the old code, three of five actually break:

| Key, set to `undefined` | Old behaviour |
| --- | --- |
| `quorum` | `approvals.length >= undefined` is false for every count — the gate never approves |
| `denyIsFinal` | Falsy, so a deny no longer resolves the request |
| `allowedRoles` | `canVote` throws a `TypeError` on `.includes()` |
| `expiresAfterMs` | Safe — `request()` resolves it with `??`, and `evaluate` reads `request.expiresAt` |
| `onExpiry` | Safe by coincidence — `undefined === "approve"` is false, which is the default anyway |

The first two are failures of a governance control in opposite directions, and
the third is a crash. All three are reached through ordinary calling code.

**Fix.** `mergePolicy()` skips `undefined` values, and is used by `canVote`,
`evaluate`, and `remainingApprovals`. Five tests, one per real failure plus the
merge semantics.

## Raised as roadmap items

Each of these is real but larger than a review-pass fix. They are the `0.2.0`
milestone in [ROADMAP.md](../ROADMAP.md).

| Finding | Item |
| --- | --- |
| `authenticate` establishes identity; nothing establishes *membership*. Any authenticated participant can pass any `sessionId` and read that session's stream, roster, and audit ledger. | R5 |
| `ApprovalGate` holds policies in a process-local `Map`. A restart mid-approval drops a four-eyes policy back to the `quorum: 1` default — a governance control weakening silently across a deploy. | R2 |
| `EventBus` fans out in-process, so a second server instance splits the room in half. Sequence allocation, not fan-out, is the hard part. | R1 |
| `src/server/` and `src/client/` are 570 lines with no tests — and they hold auth, framing, and reconnection. | R4 |
| `InMemoryMultiplayerStore` is the only implementation, so every adopter writes persistence from an unproven interface. | R3 |
| `controller.enqueue` is unconditional; a slow client grows the stream queue without bound. | R9 |
| Approval expiry is enforced lazily on read, so a gate that expires overnight resolves whenever someone next looks, with a misleading timestamp. | R8 |
| `console.error` is the entire error-reporting story. | R10 |

## Packaging and hygiene

Fixed:

- `package.json` had no `repository`, `homepage`, or `bugs`. npm renders a
  package page without them and it looks abandoned.
- No `"./package.json"` export. With `exports` set, tooling that reads a
  dependency's manifest cannot.
- `CHANGELOG.md` was not in `files`, so it was written but never published.
- Added `publishConfig.access: "public"` — harmless for an unscoped package,
  and correct in advance of any scope decision.
- Added `scripts/check-doc-links.mjs` and `npm run docs:check`, wired into a
  combined `npm run check`. Nothing in a TypeScript build catches a moved page
  or a renamed heading, and a docs set this size will otherwise rot within a
  release. It found four broken anchors in these very docs on first run.
- Deleted `.npmignore`. It was dead config: when `files` is present npm ignores
  it, so two contradictory ignore mechanisms sat in the repo, one of them
  inert. Whichever one someone edits next, they have a 50% chance of editing
  the one that does nothing.

Not fixed, deliberately:

- **No CI.** There is no `.github/workflows`, so the checks run only when
  someone remembers. Left out because CI configuration is a choice about the
  project's infrastructure rather than a cleanup — raised as
  [R13](../ROADMAP.md#r13--continuous-integration), and it is the cheapest item
  on the list. `npm run check` was added so there is one command for CI to run
  when it exists.
- **No linter beyond `tsc`.** `"lint": "tsc --noEmit"` is the same command as
  `typecheck`. Fine for now; adding ESLint or Biome is a taste decision.

## Doc/code drift found

The README described behaviour the code does not have. Corrected in this pass:

- The quickstart imported `fourEyes` and never used it.
- A stray duplicate `# mastra-multiplayer` heading sat below the licence line.
- **Memory scoping.** The README documents `resourceId` as per-user, and
  `Participant.resourceId` exists for exactly that. But `runTurn` passes
  `memory: { thread: session.threadId, resource: session.id }` — the session id,
  not any participant's resource. The behaviour is defensible for a shared
  session (per-room memory rather than per-person), but it is not what the page
  described, and `Participant.resourceId` is currently unused by the library.
  The README and [CONCEPTS](../CONCEPTS.md) now say what the code does and flag
  the gap.

## Not findings

Noted so the next reviewer does not re-derive them:

- `TurnController.drain()` recurses at the end. It is `await`ed, so this builds
  a promise chain rather than a stack, and the queue is drained one turn at a
  time. Not a stack-overflow risk.
- `stableStringify` handles top-level `undefined` via `?? "null"`, arrays
  positionally, and drops `undefined` object values. Key order independence is
  tested. The binding hash is sound.
- `unrefTimer` probes for `unref` rather than assuming Node. Correct — the
  package targets both.
- `@ts-nocheck` in `examples/` is why `npm run typecheck` passes without
  `@mastra/core` installed. Intentional, and the alternative (excluding
  `examples` from `tsconfig`) is not obviously better.
- `EventSource` cannot send custom headers, so `MultiplayerClientOptions.headers`
  applies to the POSTs but not the stream, which relies on cookies via
  `withCredentials`. This is a browser limitation, not a defect. It is now
  documented in [HTTP-API](../HTTP-API.md) because it will otherwise be
  rediscovered by everyone who tries bearer-token auth.
