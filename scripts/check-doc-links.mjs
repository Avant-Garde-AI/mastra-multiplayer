#!/usr/bin/env node
/**
 * Verifies that every relative markdown link resolves — both the file and, when
 * present, the heading anchor.
 *
 * Docs rot silently. A moved file or a renamed heading leaves a link that looks
 * fine in review and 404s for a reader, and nothing in a TypeScript build
 * catches it. Zero dependencies, on purpose.
 *
 *   node scripts/check-doc-links.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, extname } from "node:path";

const ROOT = resolve(process.cwd());
const SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".turbo"]);

function markdownFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...markdownFiles(path));
    else if (extname(path) === ".md") found.push(path);
  }
  return found;
}

/** GitHub's heading-to-anchor rule: lowercase, drop punctuation, space → hyphen. */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](href) → text
    .replace(/[`*_~]/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s/g, "-"); // each space, not each run — "a  b" → "a--b"
}

function anchorsIn(file) {
  const set = new Set();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) set.add(slug(heading[1]));
  }
  return set;
}

const files = markdownFiles(ROOT);
const anchorCache = new Map(files.map((f) => [f, anchorsIn(f)]));
const problems = [];

for (const file of files) {
  const body = readFileSync(file, "utf8");
  for (const [, href] of body.matchAll(/\[[^\]]+\]\(([^)\s]+)[^)]*\)/g)) {
    if (/^(https?:|mailto:|#!)/.test(href)) continue;

    const [path, anchor] = href.split("#");
    const target = path ? resolve(dirname(file), path) : file;
    const where = relative(ROOT, file);

    let stats;
    try {
      stats = statSync(target);
    } catch {
      problems.push(`${where}: no such file — ${href}`);
      continue;
    }

    if (!anchor || !stats.isFile() || extname(target) !== ".md") continue;
    if (!anchorCache.get(target)?.has(anchor)) {
      problems.push(`${where}: no such heading — ${href}`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} broken link(s).`);
  process.exit(1);
}

console.log(`OK — links resolve across ${files.length} markdown files.`);
