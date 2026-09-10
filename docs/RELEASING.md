# Releasing

Short, because most of it is automated and the rest is judgement.

## Before

```bash
npm run check     # typecheck + tests + doc links
npm run build
node scripts/check-exports.mjs
```

`prepublishOnly` runs all three, so `npm publish` cannot ship a package that
fails them. Run them yourself first anyway — finding out during a publish is a
worse time to find out.

The Redis tests skip when no server is reachable. **Run them before a release**:

```bash
redis-server --port 6399 --daemonize yes --save '' --appendonly no
npm test
```

Skipping them locally is fine day to day because CI runs a Redis service and
fails rather than skips. Cutting a release from a machine that never ran them is
not.

## Deciding the version

Pre-1.0, so the rule is the pragmatic one rather than the strict one:

- **Minor** (`0.3.0` → `0.4.0`) for anything a consumer must react to: a changed
  signature, a removed field, a new requirement on a custom `MultiplayerStore`,
  a status code that moved. This package has had several of those per milestone
  and will have more.
- **Patch** for fixes that need no reaction.

Every breaking change goes in the changelog's **Upgrading** table with what to
do about it, not just what changed. A changelog that says `publish` is now async
without saying "await it" has done half the job.

## Steps

1. Land everything; `main` green.
2. Bump `version` in `package.json`.
3. Move the changelog's unreleased entries under a dated heading for the new
   version, and add any breaking changes to the Upgrading table.
4. Garden [the roadmap](./ROADMAP.md): statuses, the `Released` section, and the
   `Last gardened` line — which is a contract, not a decoration.
5. Update the status line in the [README](../README.md) and the version note in
   [SECURITY](./SECURITY.md).
6. Commit, tag `v<version>`, push the tag.
7. `npm publish`.

## The scope is not decoration

The package is `@avant-garde-ai/mastra-multiplayer`, and **a scoped package
defaults to `restricted`** — which on a free account fails the publish outright.
`publishConfig.access: "public"` in `package.json` is what prevents that; it was
inert while the name was unscoped and is load-bearing now. Do not remove it.

Publishing also needs the `avant-garde-ai` npm organization to exist and to have
you as a member with publish rights. A token cannot create a scope.

## What ships

`files` in `package.json` is an allowlist: `dist`, `README.md`, `CHANGELOG.md`,
`LICENSE`. Source, tests, docs and examples are not published — they are in the
repository, which the package links to.

Source maps *are* published. They roughly triple the tarball, and they are what
turns a stack trace from a consumer into something answerable. Worth it until
someone shows otherwise.

Verify with `npm pack --dry-run` before publishing. `scripts/check-exports.mjs`
already proves every path in the `exports` map exists in `dist/` and carries
types, which is the failure that is otherwise invisible until someone installs
the package.

## After

Watch the first install from a clean directory:

```bash
npm pack
cd $(mktemp -d) && npm init -y > /dev/null && npm i /path/to/avant-garde-ai-mastra-multiplayer-*.tgz
node -e "import('@avant-garde-ai/mastra-multiplayer').then(m => console.log(Object.keys(m).length, 'exports'))"
```

Peer dependencies are all optional, so a bare install must work with none of
them present. That is the claim most likely to be quietly false.
