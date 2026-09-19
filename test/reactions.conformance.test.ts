import { describe, it } from "vitest";

import { reactionConformanceChecks } from "../src/reactions/conformance.js";
import { InMemoryReactionStore } from "../src/reactions/index.js";

describe("InMemoryReactionStore conformance", () => {
  for (const check of reactionConformanceChecks()) {
    it(`${check.group} - ${check.name}`, async () => {
      await check.run((options) => new InMemoryReactionStore(options));
    });
  }
});
