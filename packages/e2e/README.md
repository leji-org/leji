# UI smoke suite

Three journeys, in a real browser, over the surfaces a unit test cannot reach:

- `specs/viewer.spec.ts`: the fixture layer served by `leji viewer serve`.
- `specs/export.spec.ts`: the same layer exported by `leji export` and served by a plain static host (`static-server.mjs`, no dependency of its own).
- `specs/site.spec.ts`: leji.org, as `astro preview` serves the built site.

The viewer and export specs import the same predicates from `assertions.ts`, so live and static are judged by one set and cannot drift apart.

This workspace is private and is never published. Its only dependency is `@playwright/test`, and only Chromium is installed.

## Run it

Once per machine, and again after the pinned Playwright version changes:

```bash
npm run browsers -w packages/e2e
```

Then, from the repository root:

```bash
npm run build -w packages/sdk
npm run build -w packages/site
npm run e2e
```

Both builds are required: the suite runs the CLI out of `packages/sdk/dist` and previews the site out of `packages/site/dist`.

`npm run e2e` runs `run.mjs`, which checks the three ports are free, copies `fixtures/valid-render-subset` to `packages/e2e/.work/fixture`, gives it a context index and an export, starts the three servers, runs Playwright, and then takes down everything it started, followed by `.work/`. Nothing is written into `fixtures/`.

Arguments reach Playwright, but option-shaped ones have to skip the root script, which npm would read them as flags of:

```bash
npm run e2e -- specs/viewer.spec.ts
npm run e2e -w packages/e2e -- --headed --repeat-each=3
```

## The exit-path contract

**What is guaranteed: the direct children.** The three servers and Playwright are each a direct child of `run.mjs`, and each is signalled by its own pid, through the handle Node holds for it: never a process group, never a pid read from the process table. So the set of processes this script can signal is exactly the set it spawned, by construction rather than by timing. Cleanup sends `SIGTERM` to each, waits up to three seconds for the sockets to close, then `SIGKILL`s whatever is still there and waits up to three seconds more. Both waits are bounded: a child that ignores both signals delays the exit but cannot hang it, and if one is still running at the end the run says so by name and pid.

That covers every exit path: a normal exit, a failing run, a Playwright crash or kill, a failure during preparation, and `Ctrl+C` or a `SIGTERM` to the script (exit `128 +` the signal number: `130` for `SIGINT`, `143` for `SIGTERM`). Cleanup runs exactly once whichever path reaches it, and exactly one path exits, so the code the caller sees is not a race.

**What is best-effort: grandchildren.** A browser started by Playwright is Playwright's child, not this script's, and this script will not reach around it to signal something it did not spawn. Playwright shuts its browsers down when it is asked to stop, and in practice a `SIGTERM` mid-run leaves nothing behind, but that is Playwright's behavior, not a guarantee made here. A browser that outlives a hard-killed Playwright holds no port of ours and is reported by nothing here; find it by its parent having gone away (`ps -o pid,ppid,command | grep ms-playwright`) and end that specific process, rather than killing every Playwright browser on the machine.

**On Windows**, `child.kill()` is `TerminateProcess`, which ends the child alone, so it is followed by `taskkill /T /F /PID` to take the tree with it. `taskkill`'s result is checked: anything other than success or "no such process" is printed, naming the child and its pid, rather than being assumed to have worked.

**What cannot be covered, and is not claimed:** a `SIGKILL` of `run.mjs` itself, which gets no chance to act. Its three servers keep running and keep their ports, and Playwright and its browser may survive alongside them (those hold no port, so only the servers are reported by the next run). The next run does not paper over that: it refuses to start, naming the port that is held and why:

```
e2e: port 23922 (the static export server) is already in use. Another e2e run, or a
server left behind by one that was killed, is holding it; stop that process and run again.
```

## Servers and ports

`run.mjs` starts three servers on fixed ports: the viewer (`leji viewer serve`) on 23921, the static export (`static-server.mjs`) on 23922, the site preview (`astro preview`) on 23923. Each has to accept a connection within 60 seconds or the run stops with that server named. Playwright's own `webServer` is deliberately not used: it starts its servers before `globalSetup`, which is too early for a fixture that has to be built first, and it detaches each one into a session of its own, which puts them out of reach of any cleanup but its own.

The ports are checked before anything starts (each by a two-second bounded bind), so a second concurrent run on the same machine stops with the port named rather than sharing a server with the first.

## When something fails

`report/` holds the HTML report and `test-results/` the traces and screenshots kept for failures; both are gitignored, and the CI job uploads them as artifacts. Open the report with:

```bash
npm run report -w packages/e2e
```
