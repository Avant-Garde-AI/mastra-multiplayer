# Medium-term roadmap

[`../ROADMAP.md`](../ROADMAP.md) is the board: every item, its status, one
paragraph each. It answers *what* and *when*.

This folder answers *how*, for work not yet started — the detail that would
otherwise bloat the board into something nobody reads, or worse, sit in
somebody's head until they start and rediscover it.

| | |
| --- | --- |
| [`0.4.0-integration.md`](./0.4.0-integration.md) | The next milestone, in enough detail to start on. |
| [`HORIZONS.md`](./HORIZONS.md) | Beyond it — and what would have to be true before any of it is scheduled. |
| [`research/`](./research/) | Findings that plans are built on, dated and sourced. |

## The rule that makes this worth keeping

**A plan here is only as good as what it was checked against.** Both `0.4.0`
items were planned from assumptions about Mastra's API; reading the actual
source changed one item's size, the other's confidence, and revealed that the
larger of the two was missing half its scope
([research](./research/2026-09-07-mastra-apis.md)).

So: **research before planning, and record what you read.** A plan that cites a
dated finding can be re-checked when the finding goes stale. A plan that cites
nothing has to be re-derived from scratch, and usually isn't — it just gets
built.

## How these files behave

- **A milestone file is deleted when the milestone ships.** Its content moves to
  the board's `Released` section and the changelog. Keeping a shipped plan
  alongside a shipped feature is how two descriptions of the same thing start
  disagreeing.
- **A research note is never edited after the fact** — it is a record of what
  was true on a date. Superseded by a newer note, not rewritten. The date at the
  top is the whole value.
- **`HORIZONS.md` is pruned, not appended to.** An idea that has sat there for
  three milestones with nobody asking gets deleted or moved to
  [Deliberately not doing](../ROADMAP.md#deliberately-not-doing). Growth is not
  the goal.

## Status of these plans

`0.4.0` is **proposed**, not committed. Nothing in it has been started, and its
R6 plan carries an explicit precondition: re-check Mastra's workflow API against
a *published* release, since the research read a pre-release version from the
monorepo. If that check fails, R7 ships alone.
