# Mastra's workflow and channel APIs

**Researched:** 2026-09-07 · against `mastra-ai/mastra@db7cc1c5`, `@mastra/core`
`1.65.0-alpha.7` on `main`

R6 (workflow-step gates) and R7 (channel adapters) had both been planned against
*assumptions* about Mastra's API rather than the API itself. This is what is
actually there, read from the repository rather than from memory. Two of the
findings change the plans.

> Read from source because `mastra.ai` is unreachable from this environment's
> egress proxy. The repository is the better source anyway — the docs describe
> a release, the source describes `main`.

## Workflows: suspend and resume

A step declares two extra schemas and receives `suspend` and `bail`:

```ts
const step1 = createStep({
  id: 'step-1',
  inputSchema: z.object({ userEmail: z.string() }),
  outputSchema: z.object({ output: z.string() }),
  resumeSchema: z.object({ approved: z.boolean() }),
  suspendSchema: z.object({ reason: z.string() }),
  execute: async ({ inputData, resumeData, suspend, bail }) => {
    const { approved } = resumeData ?? {}

    if (approved === false) return bail({ reason: 'User rejected the request.' })
    if (!approved) return await suspend({ reason: 'Human approval required.' })

    return { output: `Email sent to ${inputData.userEmail}` }
  },
})
```

Running and resuming:

```ts
const run = await workflow.createRun()
const result = await run.start({ inputData })

if (result.status === 'suspended') {
  const [stepPath] = result.suspended            // a path array
  const payload = result.steps[stepPath[0]].suspendPayload
}

await run.resume({ step: 'step-1', resumeData: { approved: true } })
```

### What this means for R6

**The step re-executes from the top on resume**, with `resumeData` populated —
it is not a continuation that picks up mid-function. So an approval gate is
naturally written as "no decision yet → request and suspend; decision present →
act on it", which is a clean fit.

**`bail()` matters more than expected.** A denied approval is not an error, and
it is not an exception to swallow — `bail` completes the run with `success` and
skips the rest of the step. A gate factory that threw on denial would be
fighting the framework. `bail` is the denial path.

**The real work is not a factory — it is a resumer.** Votes arrive over this
package's HTTP surface; workflows resume through `run.resume()`. Something has
to connect them: watch the bus for `approval.resolved`, find the suspended run,
call `resume` with the decision. A "step factory" alone leaves the gate
suspended for ever.

**The scaffold already anticipated this.** `ApprovalRequest` has carried
optional `runId` and `stepId` since `0.1.0` and nothing has ever used them.
They are exactly the keys a resumer needs. Nice to find rather than add.

## Channels

Added in `@mastra/core@1.22.0`. Configured on the agent, not on a server:

```ts
new Agent({
  id: 'support-agent',
  channels: {
    adapters: {
      slack: createSlackAdapter(),      // from @chat-adapter/slack
      discord: createDiscordAdapter(),  // from @chat-adapter/discord
    },
  },
})
```

In-repo adapters live under `channels/` (slack, telegram); documented platforms
include Slack, Discord, Teams, GitHub, Telegram, WhatsApp and iMessage.

A channel message carries, from
`packages/core/src/channels/agent-channels.ts`:

```ts
actor: { userId: string; userName?: string; fullName?: string; isBot?: boolean | 'unknown' }
threadId: string
channelId: string
```

### What this means for R7

**The vendor SDKs are Mastra's problem, not ours.** Adapters are separate
`@chat-adapter/*` packages that the *host application* installs and passes to
its agent. This package never imports one.

That answers the open question that had R7 at medium confidence — *"does this
belong here or in a companion package, since each adapter drags in a vendor
SDK?"* The premise was wrong. There is no SDK to drag in.

What is left is a **pure mapping** between two shapes we already own:

| Mastra channel | `Participant` |
| --- | --- |
| `actor.userId` | `id`, and `resourceId` as `${surface}:${userId}` |
| `actor.fullName ?? actor.userName ?? userId` | `displayName` |
| adapter key (`slack`, `discord`, …) | `surface` |
| `actor.isBot` | — filter, or a distinct role |
| `threadId` | the session's `threadId` |

No new dependency, no vendor knowledge, and testable with a plain object. R7
moves to high confidence and shrinks from `L` to `M`.

**Two things still need deciding**, and neither is a blocker:

- `actor.isBot` can be `'unknown'`. A bot posting into a shared session is a
  participant by every structural measure and not one by any useful one. Default
  to excluding bots, with an option — and say so, rather than letting each
  adapter decide.
- Mastra's `threadId` is per channel thread. Mapping it to a session is a lookup
  the host owns (they may want one session per thread, or per channel, or per
  ticket). Take a resolver rather than guessing.

## Signals

Mastra has a `SignalProvider` abstraction (`reference/signals/`), including
webhook and task providers. Not examined in depth. Worth a look before building
anything that polls, since `TurnController`'s modes were originally written to
mirror the Signal API and the two may have drifted.

Recorded as an open question rather than a finding — nothing in the current plan
depends on it.

## Provenance

Everything above is read from the repository at the commit named at the top. The
docs quoted are `docs/src/content/en/docs/workflows/human-in-the-loop.mdx` and
`docs/src/content/en/reference/agents/channels.mdx`; the type shapes are from
`packages/core/src/channels/agent-channels.ts`.

`@mastra/core` in that checkout is a pre-release (`1.65.0-alpha.7`) because it is
the monorepo's working version, not a published one. **Re-check against the
published release before implementing** — this package's peer range is
`>=1.0.0`, and an API that only exists on `main` would break every consumer.
