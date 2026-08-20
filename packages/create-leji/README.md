# create-leji

Bootstrap a [Leji](https://leji.org) context layer with one command. Leji is the open
specification for the shared context layer of AI-native teams.

```bash
npm create leji@latest            # the current directory
npm create leji@latest my-app     # a directory, created if it is not there yet
```

No install step: `npm create` fetches the package, runs it once, and leaves nothing behind.
`npx create-leji@latest` does the same thing.

## What it runs

`create-leji` looks at the target directory once and delegates to the `leji` CLI. It asks no
question of its own and writes nothing itself.

| The target directory | What runs |
| --- | --- |
| does not exist yet, or has nothing to adopt | `leji init` |
| has a docs root (`docs/`, `doc/`, `documentation/`, any capitalization) or an agent entrypoint (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursorrules`, `.cursor/rules`, `.windsurfrules`, `.github/copilot-instructions.md`) | `leji adopt` |
| already has a `leji.json` | nothing. It names the next command, `leji start`, and exits 0 |
| cannot be read: a file, a broken symlink, or a directory without permission | nothing. It exits 2 |

Only the target directory is inspected, at those exact paths. Nothing is searched recursively,
so pointing it at one package of a monorepo classifies that package and not the repository
around it. Nothing outside the target decides the answer either: each path is resolved before
it is read, and one that resolves outside the target, or to nothing at all, counts as absent.
A `docs` symlink pointing somewhere else is not a docs root here.

It is a heuristic, and it can be wrong: a generated `docs/` that is not documentation reads as
an existing repository, and a code repository whose only entrypoint is `CLAUDE.md` does too.

## Overrides

```bash
npm create leji@latest -- --init     # scaffold a new layer, whatever is there
npm create leji@latest -- --adopt    # scaffold alongside what is there
```

`--init` and `--adopt` force the branch and are the escape hatch when the routing rule reads
your repository wrong. They take a directory like any other invocation
(`npm create leji@latest my-app -- --adopt`). Giving both is an error.

## Flags

Everything else passes straight through to the command that runs, in order, so every flag it
accepts works here:

```bash
npm create leji@latest my-app -- --yes --level indexed --name acme-context
```

`leji init` and `leji adopt` do not declare the same flags: `--level` and `--name` are init's,
`--wire-adapters` is adopt's. A flag the routed command does not declare is a usage error from
leji's own flag check, not something `create-leji` absorbs, so when you need a branch-specific
flag, pick the branch with `--init` or `--adopt` rather than relying on the routing rule.

The target directory is the positional argument, or a `--dir <path>` you write yourself, or
`--root <path>` when there is no `--dir`, or the current directory, in that order. Both flags
take either spelling, `--dir <path>` or `--dir=<path>`, as `leji` does. That is exactly how
`leji` resolves it, so the directory the routing rule reads is always the directory the command
acts on. Give it once: a positional plus `--dir` in either spelling is an error.

**Package managers differ in how flags reach the package.** npm needs `--` before them:

```bash
npm create leji@latest -- --yes
pnpm create leji --yes
yarn create leji --yes
bun create leji --yes
npx create-leji@latest --yes
```

`--yes` takes every default and asks nothing, which is what CI wants. `--dry-run` prints the
write plan and touches no file.

- Specification: https://leji.org
- License: Apache-2.0
