import { describe, expect, it } from "vitest";

import { labelBatch, rosterPrompt, withMultiplayerContext } from "../src/attribution/index.js";
import type { InboundMessage, Participant } from "../src/types.js";

const people: Participant[] = [
  { id: "alice", displayName: "Alice", role: "owner", surface: "web" },
  { id: "bob", displayName: "Bob", role: "editor", surface: "slack" },
];

const msg = (participantId: string, text: string): InboundMessage => ({
  sessionId: "s1",
  participantId,
  text,
  receivedAt: 0,
  addressedToAgent: true,
});

describe("attribution", () => {
  it("labels each message with its author", () => {
    const labelled = labelBatch(
      [msg("alice", "ship it"), msg("bob", "wait, not yet")],
      people,
    );
    expect(labelled).toBe("[Alice]: ship it\n[Bob]: wait, not yet");
  });

  it("leaves unknown authors unlabelled rather than guessing", () => {
    expect(labelBatch([msg("mallory", "hi")], people)).toBe("hi");
  });

  it("lists everyone in the roster prompt", () => {
    const prompt = rosterPrompt(people);
    expect(prompt).toContain("Alice (owner)");
    expect(prompt).toContain("Bob (editor)");
  });

  it("returns an empty roster prompt for an empty session", () => {
    expect(rosterPrompt([])).toBe("");
    expect(withMultiplayerContext("base", [])).toBe("base");
  });
});
