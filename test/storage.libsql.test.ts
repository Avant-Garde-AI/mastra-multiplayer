import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";

import { LibSQLMultiplayerStore } from "../src/storage/libsql.js";
import { conformanceChecks } from "../src/storage/conformance.js";

/**
 * The same suite the in-memory store runs, against a real database. That is
 * the point of writing the checks as data rather than as a test file.
 */
async function freshStore() {
  // A private in-memory database per check — no file, no shared state.
  const store = new LibSQLMultiplayerStore(createClient({ url: ":memory:" }));
  await store.migrate();
  return store;
}

describe("LibSQLMultiplayerStore conformance", () => {
  for (const check of conformanceChecks()) {
    it(`${check.group} — ${check.name}`, async () => {
      await check.run(await freshStore());
    });
  }
});
