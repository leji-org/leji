// The suite's one entry point: prepare the fixtures, start the five servers the
// specs address, run Playwright over them, and take down everything it started.
//
// Two things are owned here rather than by Playwright, for the same reason:
// Playwright starts every `webServer` before `globalSetup` runs and detaches each
// one into a session of its own, so preparation cannot happen early enough and
// the servers cannot be reached afterwards. So this script builds the trees first
// and spawns the five servers itself.
//
// Every process this script signals is a DIRECT child of it, signalled by the pid
// its own `spawn` returned and only while Node still holds that child. Nothing is
// read from the process table, no process group is ever signalled, and no pid this
// script did not spawn can be named, which is the whole of the guarantee, and
// exactly as far as it goes: a grandchild (a browser under Playwright) is the
// child's to end, and the README says so rather than claiming otherwise.
//
// Nothing is written into `fixtures/`: the repository's fixture is copied out twice
// (once as it stands, once with a custom `viewer.theme.primary`), and each copy is
// what gets a viewer, an export, and a pair of servers.

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const POSIX = process.platform !== 'win32';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const work = path.join(here, '.work');
const fixture = path.join(work, 'fixture');
// The same layer with `viewer.theme.primary` set. The accent is baked into the
// chrome when the viewer is generated, so a custom accent can only be judged on a
// layer that declares one, hence a second copy, prepared and served like the first.
const accentFixture = path.join(work, 'fixture-accent');
const ACCENT = '#2244AA';
const source = path.join(repoRoot, 'fixtures/valid-render-subset');
const cli = path.join(repoRoot, 'packages/sdk/dist/cli.js');

/** Fixed ports in a high range, matching the base URLs in `assertions.ts`. */
const VIEWER_PORT = 23921;
const STATIC_PORT = 23922;
const SITE_PORT = 23923;
const ACCENT_VIEWER_PORT = 23924;
const ACCENT_STATIC_PORT = 23925;

/** How long a server gets to accept a connection before the run gives up. */
const READY_TIMEOUT_MS = 60_000;
/** How long a signalled child gets to exit before it is killed outright. */
const TERM_GRACE_MS = 3_000;
/** How long a port check gets to answer before the run gives up on it. */
const PORT_CHECK_TIMEOUT_MS = 2_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- the children this script owns ----------------------------------------
//
// Every child is spawned plainly, in this process's own group, and no signal is
// ever sent to a group. A group signal reaches processes by an id that outlives
// the group and can be reused, so
// the only way to be certain a signal lands on this script's own work is to send
// it through the child handle Node keeps: `child.kill()` addresses the pid Node
// spawned, and Node will not send to it once it has reaped it. Narrower than a
// group signal, and true by construction rather than by timing.

/** `{ name, child, alive, failure, exited }` for each child, in start order. */
const owned = [];

/** Track a child: its liveness, the error if it never started, and a promise of
 * its exit that always settles (a child that failed to spawn at all settles on
 * `error`, so cleanup never waits for an exit event that will not come). */
function adopt(name, child) {
   const record = { name, child, alive: true, failure: null, exited: null };
   record.exited = new Promise((resolve) => {
      const settle = (result) => {
         record.alive = false;
         resolve(result);
      };
      child.once('exit', (code, signal) => settle({ code, signal }));
      child.once('error', (error) => {
         record.failure = error;
         settle({ code: null, signal: null });
      });
   });
   owned.push(record);
   return record;
}

/** A child's ending as an exit status: its own code, or the shell's convention of
 * 128 plus the signal that killed it. The signal NUMBER, not a flat 128: which
 * signal ended a run is the first thing anyone reading a red job wants. */
function exitStatus({ code, signal }) {
   if (signal) return 128 + (os.constants.signals[signal] ?? 0);
   return code ?? 1;
}

/** Windows has no signals: `child.kill()` maps onto `TerminateProcess`, which ends
 * the child and nothing below it, so `taskkill /T /F` follows to take the tree.
 * Its result is checked and reported: a tree this script could not remove is a
 * fact the run has to state, not one to swallow. Exit code 128 means "no such
 * process": the child was already gone, which is the ordinary case. */
function taskkill(record, pid) {
   const result = spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
      windowsHide: true,
      encoding: 'utf8',
   });
   if (result.error) {
      console.error(
         `e2e: taskkill could not run for the ${record.name} process tree (pid ${pid}): ${result.error.message}`,
      );
      return;
   }
   if (result.status !== 0 && result.status !== 128) {
      const detail = (result.stderr ?? '').trim() || (result.stdout ?? '').trim();
      console.error(
         `e2e: taskkill exited ${result.status} for the ${record.name} process tree (pid ${pid}): ${detail}`,
      );
   }
}

/** Signal every child still running, by its own pid and through the handle Node
 * holds for it. A child that ended between the check and the call is already
 * reaped, and `child.kill()` on it is a no-op rather than a signal to a stranger. */
function signalOwned(signal) {
   for (const record of owned) {
      const pid = record.child.pid;
      if (!record.alive || typeof pid !== 'number') continue;
      try {
         record.child.kill(signal);
      } catch {
         // Already gone; nothing to take down.
      }
      if (!POSIX) taskkill(record, pid);
   }
}

/** Take down every child this script started: SIGTERM, three seconds for the
 * sockets to close, then SIGKILL for whatever is left and three more. Both waits
 * are bounded, so a child that ignores both signals delays the exit but cannot
 * hang it, and the README says that plainly rather than promising every exit
 * event is in hand. */
async function terminateOwned() {
   const live = owned.filter((record) => record.alive);
   if (live.length === 0) return;
   const allExited = Promise.all(live.map((record) => record.exited));
   signalOwned('SIGTERM');
   await Promise.race([allExited, delay(TERM_GRACE_MS)]);
   if (live.some((record) => record.alive)) {
      signalOwned('SIGKILL');
      await Promise.race([allExited, delay(TERM_GRACE_MS)]);
   }
   const stubborn = live.filter((record) => record.alive).map((record) => `${record.name} (pid ${record.child.pid})`);
   if (stubborn.length > 0) console.error(`e2e: still running after SIGKILL: ${stubborn.join(', ')}`);
}

function removeWork() {
   fs.rmSync(work, { recursive: true, force: true });
}

// --- one cleanup, one exit -------------------------------------------------
//
// Cleanup is a single promise, whoever asks for it: the main flow at the end of a
// run, or a signal handler part-way through one. Both await the same settlement,
// and the `terminating` flag decides which of them gets to exit, so a signal that
// also ends the child the main flow is awaiting cannot produce two exit paths
// racing for the code. A SIGKILL of this process cannot be handled at all; the
// README says what that leaves behind and how the next run reports it.

let cleanupOnce = null;
/** Take down the children and remove `.work/`, exactly once per run. */
function cleanup() {
   if (cleanupOnce === null) {
      cleanupOnce = (async () => {
         await terminateOwned();
         removeWork();
      })();
   }
   return cleanupOnce;
}

/** Set when a signal owns the exit: the main flow then finishes without calling
 * `process.exit`, and the handler exits with the signal's status. */
let terminating = false;

for (const signal of ['SIGINT', 'SIGTERM']) {
   process.on(signal, () => {
      if (terminating) return;
      terminating = true;
      const code = 128 + (os.constants.signals[signal] ?? 0);
      // The signal owns the exit code either way: a cleanup failure is reported,
      // never allowed to turn a 130 or 143 into an unhandled rejection.
      void cleanup().then(
         () => process.exit(code),
         (error) => {
            console.error(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(code);
         },
      );
   });
}

// --- running things -------------------------------------------------------

/** Run a command to completion as an owned child, inheriting stdio; resolves with
 * how it ended, or rejects with the reason it never ran at all. */
async function run(name, command, args, options = {}) {
   const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, ...options });
   const record = adopt(name, child);
   const ending = await record.exited;
   if (record.failure !== null) throw record.failure;
   return ending;
}

/** A server's output, line by line, on this script's own streams, tagged with the
 * server it came from. Piped rather than inherited so three servers and Playwright
 * cannot interleave mid-line, and so a server that keeps talking after the run is
 * over is visibly still ours. */
function tagOutput(name, child) {
   for (const [stream, sink] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
   ]) {
      if (stream === null) continue;
      stream.setEncoding('utf8');
      let pending = '';
      stream.on('data', (chunk) => {
         const lines = (pending + chunk).split('\n');
         pending = lines.pop() ?? '';
         for (const line of lines) sink.write(`[${name}] ${line}\n`);
      });
      stream.on('end', () => {
         if (pending !== '') sink.write(`[${name}] ${pending}\n`);
      });
   }
}

/** Whether anything is listening on a loopback port, asked by binding it: the
 * question the servers are about to ask, answered the same way they would. Bounded
 * like every other wait here: a bind that neither succeeds nor fails within two
 * seconds is not an answer, and the run stops rather than hanging on the check
 * that exists to stop it hanging. */
function portFree(port) {
   return new Promise((resolve, reject) => {
      const probe = net.createServer();
      const timer = setTimeout(() => {
         probe.close();
         reject(new Error(`port ${port} could not be checked within ${PORT_CHECK_TIMEOUT_MS / 1000}s`));
      }, PORT_CHECK_TIMEOUT_MS);
      timer.unref();
      const settle = (act) => {
         clearTimeout(timer);
         act();
      };
      probe.once('error', (error) => settle(() => (error.code === 'EADDRINUSE' ? resolve(false) : reject(error))));
      probe.once('listening', () => probe.close(() => settle(() => resolve(true))));
      probe.listen(port, '127.0.0.1');
   });
}

/** Refuse to start on top of anything already holding one of the three ports:
 * a second concurrent run, or a server left behind by a run that was killed
 * outright. Loudly, by name and number, because the alternative is a suite that
 * silently asserts against somebody else's server. */
async function requirePortsFree() {
   for (const [name, port] of [
      ['viewer', VIEWER_PORT],
      ['static export', STATIC_PORT],
      ['site preview', SITE_PORT],
      ['custom-accent viewer', ACCENT_VIEWER_PORT],
      ['custom-accent static export', ACCENT_STATIC_PORT],
   ]) {
      if (!(await portFree(port))) {
         throw new Error(
            `port ${port} (the ${name} server) is already in use. ` +
               `Another e2e run, or a server left behind by one that was killed, is holding it; ` +
               `stop that process and run again.`,
         );
      }
   }
}

/** Wait until a port accepts a connection, or the server that should be holding
 * it dies, or the budget runs out. */
async function waitForPort(record, port) {
   const deadline = Date.now() + READY_TIMEOUT_MS;
   while (Date.now() < deadline) {
      if (!record.alive) {
         const why =
            record.failure === null
               ? `exited before it listened on ${port}`
               : `failed to start: ${record.failure.message}`;
         throw new Error(`the ${record.name} server ${why}`);
      }
      const listening = await new Promise((resolve) => {
         const socket = net.connect({ host: '127.0.0.1', port });
         const done = (answer) => {
            socket.destroy();
            resolve(answer);
         };
         socket.setTimeout(1_000, () => done(false));
         socket.once('connect', () => done(true));
         socket.once('error', () => done(false));
      });
      if (listening) return;
      await delay(100);
   }
   throw new Error(`the ${record.name} server did not listen on ${port} within ${READY_TIMEOUT_MS / 1000}s`);
}

/** Start one server as an owned child and wait until it answers on its port. */
async function startServer({ name, port, args, cwd }) {
   const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
   // A spawn failure is recorded by `adopt` and reported by the readiness wait,
   // which sees the child is not alive and says why.
   const record = adopt(name, child);
   tagOutput(name, child);
   await waitForPort(record, port);
}

/** The five servers, as commands. Astro is resolved the way the site workspace
 * resolves it and run directly, so the preview is this script's own child rather
 * than an npm wrapper's grandchild. */
function serverPlan() {
   const siteRoot = path.join(repoRoot, 'packages/site');
   const astroPackage = createRequire(path.join(siteRoot, 'package.json')).resolve('astro/package.json');
   const astroBin = path.resolve(
      path.dirname(astroPackage),
      JSON.parse(fs.readFileSync(astroPackage, 'utf8')).bin.astro,
   );
   return [
      {
         name: 'viewer',
         port: VIEWER_PORT,
         args: [cli, 'viewer', 'serve', '--root', fixture, '--port', String(VIEWER_PORT)],
         cwd: here,
      },
      {
         name: 'static',
         port: STATIC_PORT,
         args: [path.join(here, 'static-server.mjs'), path.join(fixture, '.leji/dist'), String(STATIC_PORT)],
         cwd: here,
      },
      {
         // The site is built by a prior step (the CI job, or the README's local
         // instructions); preview serves that build, never a dev server.
         name: 'site',
         port: SITE_PORT,
         args: [astroBin, 'preview', '--root', siteRoot, '--port', String(SITE_PORT), '--host', '127.0.0.1'],
         cwd: repoRoot,
      },
      {
         name: 'viewer (accent)',
         port: ACCENT_VIEWER_PORT,
         args: [cli, 'viewer', 'serve', '--root', accentFixture, '--port', String(ACCENT_VIEWER_PORT)],
         cwd: here,
      },
      {
         name: 'static (accent)',
         port: ACCENT_STATIC_PORT,
         args: [
            path.join(here, 'static-server.mjs'),
            path.join(accentFixture, '.leji/dist'),
            String(ACCENT_STATIC_PORT),
         ],
         cwd: here,
      },
   ];
}

/** Index and export one prepared copy, so its live and static servers are never a
 * generation apart.
 *
 * The context index first: a real layer has one on disk, and the export copies what
 * is there. Without it the exported tree is the only one of the two whose
 * classification badge cannot resolve, and the parity the shared assertions claim
 * would be judged against a layer the fixture never is.
 *
 * Then one command for both trees: `export` regenerates `.leji/viewer` (what
 * `leji viewer serve` serves) and writes `.leji/dist` (what the static host serves).
 */
async function build(label, root) {
   const indexed = exitStatus(await run(`leji index (${label})`, process.execPath, [cli, 'index', '--root', root]));
   if (indexed !== 0) throw new Error(`leji index failed for the ${label} layer (exit ${indexed})`);
   const exported = exitStatus(await run(`leji export (${label})`, process.execPath, [cli, 'export', '--root', root]));
   if (exported !== 0) throw new Error(`leji export failed for the ${label} layer (exit ${exported})`);
}

/** The accent copy's manifest: the fixture's own, plus the one field that makes it
 * a different layer. Written as JSON rather than patched as text, so the copy stays
 * valid however the fixture's manifest is formatted. */
function declareAccent(root) {
   const file = path.join(root, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
   manifest.viewer = { ...manifest.viewer, theme: { ...manifest.viewer?.theme, primary: ACCENT } };
   fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
}

async function prepare() {
   // Also the cleanup for a run that was killed outright: whatever a SIGKILLed
   // orchestrator left behind is removed here, before anything is copied.
   removeWork();
   fs.mkdirSync(work, { recursive: true });
   fs.cpSync(source, fixture, { recursive: true });
   fs.cpSync(source, accentFixture, { recursive: true });
   declareAccent(accentFixture);
   await build('default', fixture);
   await build('accent', accentFixture);
}

let code = 1;
try {
   // Before anything is built: a bound port is somebody else's server, and the
   // run has to stop while it can still say so plainly.
   await requirePortsFree();
   await prepare();
   for (const server of serverPlan()) await startServer(server);
   const playwrightCli = createRequire(import.meta.url).resolve('@playwright/test/cli');
   code = exitStatus(
      await run('playwright', process.execPath, [playwrightCli, 'test', ...process.argv.slice(2)], { cwd: here }),
   );
} catch (error) {
   console.error(`e2e: ${error instanceof Error ? error.message : String(error)}`);
} finally {
   await cleanup();
}
// Only when no signal has claimed the exit. If one has, its handler is awaiting
// the same cleanup and exits with `128 + signal`; this path stands down rather
// than racing it for the code the caller sees.
if (!terminating) process.exit(code);
