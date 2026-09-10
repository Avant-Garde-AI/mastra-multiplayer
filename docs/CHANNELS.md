# Channels

A session can span a web UI and a Slack thread. Everyone appears in the same
roster, is labelled by name in the prompt the agent sees, and can vote on an
approval — regardless of which surface they arrived on.

## No vendor SDK is involved

Mastra's channel adapters are separate `@chat-adapter/*` packages your *agent*
installs:

```ts
new Agent({
  id: "support",
  channels: { adapters: { slack: createSlackAdapter() } },
});
```

This package never imports one. What it provides is the mapping between Mastra's
`actor` and this package's `Participant` — no dependency, no vendor knowledge,
testable with a plain object.

## The mapping

```ts
import { channelParticipant } from "@avant-garde-ai/mastra-multiplayer/channels";

channelParticipant({
  surface: "slack",
  actor: { userId: "U06CK1E9HN2", fullName: "Alice Chen" },
});
// { id: "slack:U06CK1E9HN2", displayName: "Alice Chen", role: "editor",
//   surface: "slack", resourceId: "slack:U06CK1E9HN2" }
```

| Mastra | `Participant` |
| --- | --- |
| `actor.userId` | `id` and `resourceId`, prefixed with the surface |
| `actor.fullName ?? actor.userName ?? userId` | `displayName` |
| adapter key | `surface` |
| `actor.isBot` | filtered, not mapped |

**Ids are prefixed with the surface, and that is load-bearing.** Two platforms
will eventually hand out the same opaque id. An unprefixed collision merges two
people into one participant — and under `excludeRequester`, silently turns
four-eyes into two with nothing looking wrong.

**`displayName` falls back to the raw id** rather than a placeholder. `U06CK1E9HN2`
is ugly and honest; `"Unknown"` would put one label on two different people in a
roster the model reads.

## The bridge

```ts
import { channelBridge } from "@avant-garde-ai/mastra-multiplayer/channels";

const bridge = channelBridge(multiplayer, {
  resolveSession: ({ threadId }) => sessionForThread(threadId),
  role: ({ actor }) => (approvers.has(actor.userId) ? "approver" : "editor"),
});

await bridge.receive({
  surface: "slack",
  actor: { userId, fullName, isBot },
  threadId,
  channelId,
  text,
  addressedToAgent: text.includes("@support"),
});
```

`receive` joins the sender if they are new, forwards the text, and reports what
it did: `delivered`, `ignored_bot`, `ignored_no_session`, or `ignored_empty`.

That is the whole integration. See
[`examples/slack-session/`](../examples/slack-session/mastra.ts) for a session
spanning Slack and a web client.

### `resolveSession` is required, deliberately

Mastra's `threadId` is per channel thread. Whether that means one session per
thread, per channel, or per support ticket is your decision, and guessing it
wrong silently merges or splits conversations. There is no default.

### `role` is a function

Who may approve what is your policy, and it is the one security-relevant
decision here. A Slack user id is not a permission.

### Bots are excluded by default

A bot is a participant by every structural measure and not one by any useful
one: it would appear in `rosterPrompt()` and count toward a quorum, so an
automation posting into a channel could satisfy a four-eyes gate.

**`isBot: 'unknown'` counts as a bot.** Adapters cannot always tell. That
default errs toward excluding a real human — a *visible* failure, where someone
says "I am not in the room" — over letting an automation vote, which is a silent
governance one. It is logged at `warn` so it can be diagnosed rather than
puzzled over.

`allowBots: true` turns the filter off.

### Joining is not per message

`addParticipant` is an upsert, so joining on every message would be safe — but
it publishes `participant.joined` every time, and a chatty channel would fill
the event stream with one person repeatedly arriving.

The bridge joins when someone is new, or when their display name or role has
changed. A rename propagates; a hundred messages do not.

## What this does not do

- **It does not send anything back to the channel.** The agent's reply reaches
  Slack through Mastra's adapter, which owns that half. This package is the
  social layer around the conversation, not a transport.
- **It does not model leaving.** A channel has no reliable "left" signal.
  Presence ages out on its own; the roster does not.
- **It does not deduplicate across surfaces.** The same human on Slack and on
  the web is two participants with two ids, and under four-eyes they are two
  people. If your identity system can link them, pass your own `participant`
  mapping and give both the same id — and be sure the link is real, because
  getting it wrong is exactly the collision the surface prefix prevents.
