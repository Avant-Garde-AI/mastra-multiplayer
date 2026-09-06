#!/usr/bin/env node
/**
 * Verifies that every path named in package.json actually exists after a build.
 *
 * The test suite imports from `src/`, so it stays green even if the build stops
 * emitting an entry point — a broken `exports` map is invisible until someone
 * installs the package. This closes that gap by checking the published surface
 * rather than the source.
 *
 * Run after `npm run build`. Zero dependencies.
 *
 *   node scripts/check-exports.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const missing = [];
const checked = [];

/** Every string in an exports subtree is a path to check, except the keys. */
function collect(node, label) {
  if (typeof node === "string") {
    // "./package.json" and friends are real files; conditions point into dist.
    checked.push([label, node]);
    if (!existsSync(resolve(node))) missing.push(`${label} → ${node}`);
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      // `exports["./server"].types` reads better than `exports../server.types`.
      const child = key.startsWith(".") ? `${label}[${JSON.stringify(key)}]` : `${label}.${key}`;
      collect(value, child);
    }
  }
}

for (const field of ["main", "types", "module"]) {
  if (pkg[field]) collect(pkg[field], field);
}
if (pkg.exports) collect(pkg.exports, "exports");

// Every subpath export should carry types, or consumers get `any` with no
// warning — the failure mode is silent and shows up as bad autocomplete.
const untyped = [];
for (const [subpath, conditions] of Object.entries(pkg.exports ?? {})) {
  if (typeof conditions !== "object" || conditions === null) continue;
  if (!("types" in conditions)) untyped.push(subpath);
}

if (missing.length > 0) {
  console.error("Missing files referenced by package.json:\n");
  console.error(missing.map((m) => `  ${m}`).join("\n"));
  console.error("\nDid the build run, and does tsup still emit every entry?");
  process.exit(1);
}

if (untyped.length > 0) {
  console.error(`Export(s) without a "types" condition: ${untyped.join(", ")}`);
  process.exit(1);
}

console.log(`OK — ${checked.length} published path(s) exist, all subpaths typed.`);
