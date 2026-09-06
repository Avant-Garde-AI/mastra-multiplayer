import { describe, expect, it } from "vitest";

import { InMemoryMultiplayerStore } from "../src/storage/index.js";
import { conformanceChecks } from "../src/storage/conformance.js";

/**
 * The reference implementation must pass its own conformance suite. If it
 * cannot, either the store is wrong or the suite is claiming something the
 * interface never promised — both worth finding out.
 */
describe("InMemoryMultiplayerStore conformance", () => {
  for (const check of conformanceChecks()) {
    it(`${check.group} — ${check.name}`, async () => {
      await check.run(new InMemoryMultiplayerStore());
    });
  }
});
