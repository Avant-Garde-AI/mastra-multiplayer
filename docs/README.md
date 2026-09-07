# mastra-multiplayer docs

Many humans, one agent session. These pages are the long-form version of the
[project README](../README.md).

## Start here

| | |
| --- | --- |
| [Concepts](./CONCEPTS.md) | The vocabulary: session, participant, presence, turn, gate, binding. Read this first — the rest assumes it. |
| [Architecture](./ARCHITECTURE.md) | How the layers fit together, and why there are two storage systems. |
| [Roadmap](./ROADMAP.md) | What is planned, what is deliberately out of scope, and how the list is kept honest. |
| [Medium-term plans](./roadmap/) | The next milestone in detail, longer horizons, and the research they are built on. |

## Reference

| | |
| --- | --- |
| [API](./API.md) | Every exported symbol, grouped by module. |
| [HTTP & SSE](./HTTP-API.md) | The wire protocol: routes, event frames, reconnect semantics. |
| [Storage](./STORAGE.md) | Implementing `MultiplayerStore` against a real database. |

## Guides

| | |
| --- | --- |
| [Approvals](./APPROVALS.md) | Multi-approver gates: policies, argument binding, expiry, the workflow pattern. |
| [Concurrency](./CONCURRENCY.md) | Choosing a turn-taking mode, and what each one silently discards. |
| [Security](./SECURITY.md) | Threat model, what the package does and does not defend against. |

## Project record

| | |
| --- | --- |
| [Decisions](./decisions/) | Architecture decision records — choices made, with the reasoning attached. |
| [Releasing](./RELEASING.md) | Cutting a version: checks, versioning rule, what ships. |
| [Reviews](./reviews/) | Point-in-time reviews of the codebase. Findings feed the roadmap. |

## Conventions used in these docs

- **Status labels.** Anything not marked otherwise describes code that exists on
  `main` and is covered by a test. Planned behaviour is labelled `Planned` and
  linked to a roadmap item. Speculative ideas live in the roadmap's Later
  section and nowhere else.
- **No aspirational documentation.** If a page describes something the code does
  not do, that is a bug in the page. Fix the page or delete the claim.
- **Version markers.** A bare version (`0.3.0`) means shipped in that release.
  `→ 0.4.0` means targeted at it. `0.1.0` and `0.2.0` are development
  milestones that were never published; see the
  [changelog](../CHANGELOG.md).
