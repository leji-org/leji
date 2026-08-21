import { strict as assert } from 'node:assert';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SDK_VERSION } from '../../dist/index.js';

// The hand-off end to end, through the real bin: a seeded repository from
// `fixtures/handoff/`, the installed CLI a marker that prints the argv it received,
// and the assertion that the marker ran (or that the global did). The decision table
// itself is unit-level in `test/localcli.test.ts`; what is proved here is that the
// executable performs it, that a real argv survives the crossing byte for byte, and
// that the child's exit status and signal are what the shell sees.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(testDir, '..', '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const cli = path.join(pkgRoot, 'dist', 'cli.js');
const fixturesDir = path.join(repoRoot, 'fixtures', 'handoff');

function tmpdir(prefix = 'leji-handoff-proc-'): string {
   return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** The installed CLI these runs must reach: it prints its own argv JSON-encoded, so
 * argument boundaries are proved rather than inferred, and exits 3, a status no leji
 * command returns. */
const MARKER =
   "#!/usr/bin/env node\nprocess.stdout.write('handoff:node:' + JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exit(3);\n";

/** The same marker, ending in a signal instead of a status. */
const SIGNAL_MARKER = "#!/usr/bin/env node\nprocess.kill(process.pid, 'SIGTERM');\nsetTimeout(() => {}, 5000);\n";

/** A target that passes every check and still cannot be executed: its interpreter
 * does not exist. This is what a target REMOVED or stripped of its executable bit
 * between the check and the spawn leaves behind, deterministically, without a test
 * having to win the race itself. */
const UNRUNNABLE = '#!/nonexistent/interpreter\n';

/**
 * The shapes a package manager's bin shim actually takes: npm, bun and Yarn's
 * node-modules linker install a SYMLINK to the package entry, pnpm a small SCRIPT
 * that runs it. Both are executed here as installed, so the hand-off is proved
 * through the real thing rather than through one convenient shape.
 */
type ShimShape = 'symlink' | 'script';

/** The installed state a committed fixture cannot carry, written statically here. */
function install(dir: string, body = MARKER, entryIsSelf = false, shim: ShimShape = 'symlink'): void {
   const pkgDir = path.join(dir, 'node_modules', '@leji-org', 'leji');
   const entry = path.join(pkgDir, 'dist', 'cli.js');
   fs.mkdirSync(path.dirname(entry), { recursive: true });
   if (entryIsSelf) fs.symlinkSync(cli, entry);
   else fs.writeFileSync(entry, body, { mode: 0o755 });
   fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@leji-org/leji', version: '1.4.0', bin: { leji: 'dist/cli.js' } }, null, 2) + '\n',
   );
   installShim(dir, entry, shim);
}

function installShim(dir: string, entry: string, shape: ShimShape): void {
   const binDir = path.join(dir, 'node_modules', '.bin');
   fs.mkdirSync(binDir, { recursive: true });
   const target = path.join(binDir, 'leji');
   fs.rmSync(target, { force: true });
   if (shape === 'symlink') {
      fs.symlinkSync(path.relative(binDir, entry), target);
   } else {
      fs.writeFileSync(target, `#!/bin/sh\nexec node "$(dirname "$0")/${path.relative(binDir, entry)}" "$@"\n`, {
         mode: 0o755,
      });
   }
}

function seed(name: string, body = MARKER, entryIsSelf = false, shim: ShimShape = 'symlink'): string {
   const dir = tmpdir();
   fs.cpSync(path.join(fixturesDir, name), dir, { recursive: true });
   if (name !== 'node-declared-missing' && name !== 'go-tool') install(dir, body, entryIsSelf, shim);
   return dir;
}

interface Result {
   status: number | null;
   signal: NodeJS.Signals | null;
   stdout: string;
   stderr: string;
}

/** The real bin, in its own process, so the exit status and any signal are the
 * process's own rather than a return value. A generous timeout, because a hand-off
 * that recursed would otherwise hang the suite instead of failing it. */
function leji(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Result {
   const r: SpawnSyncReturns<string> = spawnSync(process.execPath, [cli, ...args], {
      cwd: opts.cwd ?? repoRoot,
      env: { ...process.env, ...opts.env },
      encoding: 'utf8',
      timeout: 30_000,
   });
   assert.equal(r.error, undefined, `spawning the CLI failed: ${r.error?.message}`);
   return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}

/** What the marker prints for one argv. */
function marker(argv: string[]): string {
   return `handoff:node:${JSON.stringify(argv)}\n`;
}

test('an eligible repository runs its own CLI, with the argv it was given', () => {
   const dir = seed('node-eligible');
   const argv = ['--root', dir, '--version'];
   const r = leji(argv);
   assert.equal(r.stdout, marker(argv));
   assert.equal(r.status, 3, 'the child status is the one that surfaces');
   assert.equal(r.stderr, '');
});

test('the argv crosses verbatim: --json, tokens after --, empty, spaced and unicode', () => {
   const dir = seed('node-eligible');
   const argv = ['start', '--root', dir, '--json', '--', '--root', 'not-a-root', '', '  ', 'ünïcødé', '--'];
   assert.equal(leji(argv).stdout, marker(argv));
});

test('the cwd decides the root when no --root is given, and a nested cwd does not', () => {
   const dir = seed('node-eligible');
   assert.equal(leji(['--version'], { cwd: dir }).stdout, marker(['--version']));
   const nested = path.join(dir, 'docs', 'context');
   fs.mkdirSync(nested, { recursive: true });
   // No upward walk: the root is where the invocation points, never where a layer
   // happens to be found above it.
   assert.equal(leji(['--version'], { cwd: nested }).stdout, `${SDK_VERSION}\n`);
});

test('LEJI_NO_LOCAL runs the global at any value, and only when it is set', () => {
   const dir = seed('node-eligible');
   for (const value of ['', '0', '1']) {
      const r = leji(['--version'], { cwd: dir, env: { LEJI_NO_LOCAL: value } });
      assert.equal(r.stdout, `${SDK_VERSION}\n`, `LEJI_NO_LOCAL=${JSON.stringify(value)}`);
      assert.equal(r.status, 0);
   }
   assert.equal(leji(['--version'], { cwd: dir }).stdout, marker(['--version']), 'unset hands off');
});

/** The metadata that disqualifies an otherwise complete install, or null when the
 * fixture's own tree is what disqualifies it. */
function metadata(name: string, version: string): string {
   return JSON.stringify({ name, version, bin: { leji: 'dist/cli.js' } }, null, 2) + '\n';
}

const DISQUALIFIED: ReadonlyArray<[string, string | null]> = [
   ['node-undeclared', null],
   ['node-declared-missing', null],
   ['node-unknown-spec-line', null],
   ['go-tool', null],
   ['node-below-minimum', metadata('@leji-org/leji', '0.9.3')],
   ['node-wrong-identity', metadata('@example/leji', '1.4.0')],
   ['node-malformed-version', metadata('@leji-org/leji', '1.x')],
   ['node-malformed-metadata', '{ not json\n'],
];

test('every repository that does not qualify runs the global, silently', () => {
   for (const [name, installed] of DISQUALIFIED) {
      const dir = seed(name);
      if (installed !== null) {
         fs.writeFileSync(path.join(dir, 'node_modules', '@leji-org', 'leji', 'package.json'), installed);
      }
      const r = leji(['--version'], { cwd: dir });
      assert.equal(r.stdout, `${SDK_VERSION}\n`, name);
      assert.equal(r.stderr, '', name);
      assert.equal(r.status, 0, name);
   }
});

// --- every shim shape a manager installs --------------------------------------

const SHIMS: ReadonlyArray<[string, ShimShape, string]> = [
   ['node-shim-symlink', 'symlink', "npm's shape, which bun installs too"],
   ['node-shim-script', 'script', "pnpm's shape: a real file that runs the entry"],
   ['node-shim-yarn', 'symlink', "Yarn's node-modules linker, a symlink like npm's"],
];

for (const [fixture, shape, why] of SHIMS) {
   test(`the hand-off runs the installed shim as ${fixture} has it (${why})`, () => {
      const dir = seed(fixture, MARKER, false, shape);
      const argv = ['--root', dir, '--version'];
      const r = leji(argv);
      assert.equal(r.stdout, marker(argv));
      assert.equal(r.status, 3);
      assert.equal(r.stderr, '');
   });
}

/**
 * The re-entry test, which is the one that would have caught the loop: the installed
 * package is the REAL built CLI, not a marker, reached through a SCRIPT shim whose
 * realpath is itself. The global hands off once; the local copy then resolves the
 * same repository, recognizes its own entry, and answers. Exactly one hand-off, and
 * the version printed is the local one, so which copy answered is not in doubt.
 *
 * The package is assembled by copying the built artifacts rather than by running a
 * package manager: the same tree an install produces, with no network in a unit
 * suite. The real packed-install path is proved separately at build verification.
 */
function installRealCli(dir: string, shim: ShimShape): void {
   const pkgDir = path.join(dir, 'node_modules', '@leji-org', 'leji');
   fs.mkdirSync(pkgDir, { recursive: true });
   fs.cpSync(path.join(pkgRoot, 'dist'), path.join(pkgDir, 'dist'), { recursive: true });
   // The copy carries the BUILD's mode, and `tsc` emits a plain 0644 file; installing
   // is what makes an entry runnable (npm chmods the bin target executable when it
   // links the shim). A symlink shim IS that file, so without this the shim points at
   // something no POSIX exec will run, the eligibility check declines it, and the
   // global answers — which is not this test's subject and looks like a passing
   // suite anywhere the working tree still carries the bit from an earlier install.
   fs.chmodSync(path.join(pkgDir, 'dist', 'cli.js'), 0o755);
   fs.cpSync(path.join(pkgRoot, 'cli.json'), path.join(pkgDir, 'cli.json'));
   // The installed copy declares a DIFFERENT version, which is also what it reports:
   // `--version` reads the package's own metadata, so the answer names the copy.
   const own = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
   fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ ...own, version: LOCAL_VERSION }, null, 2) + '\n',
   );
   // Its runtime dependencies, resolved the way Node resolves them for a real
   // install: from the tree the entry lives in.
   const deps = path.join(dir, 'node_modules');
   for (const dep of ['ajv', 'yaml']) {
      fs.symlinkSync(path.join(repoRoot, 'node_modules', dep), path.join(deps, dep));
   }
   installShim(dir, path.join(pkgDir, 'dist', 'cli.js'), shim);
}

const LOCAL_VERSION = '1.4.0-local';

test('the real local CLI, behind a script shim, answers exactly once', () => {
   const dir = tmpdir();
   fs.cpSync(path.join(fixturesDir, 'node-shim-script'), dir, { recursive: true });
   installRealCli(dir, 'script');
   const r = leji(['--version'], { cwd: dir });
   // One line, from the local copy: a second hand-off would print it again, and an
   // unbounded one would hit the runner's timeout instead of answering at all.
   assert.equal(r.stdout, `${LOCAL_VERSION}\n`);
   assert.equal(r.status, 0);
   assert.equal(r.signal, null, 'a loop would be killed by the timeout, not exit cleanly');
});

test('the real local CLI, behind a symlink shim, answers exactly once', () => {
   const dir = tmpdir();
   fs.cpSync(path.join(fixturesDir, 'node-shim-symlink'), dir, { recursive: true });
   installRealCli(dir, 'symlink');
   const r = leji(['--version'], { cwd: dir });
   assert.equal(r.stdout, `${LOCAL_VERSION}\n`);
   assert.equal(r.status, 0);
   assert.equal(r.signal, null);
});

test('a repository whose installed CLI is this very executable runs once and stops', () => {
   // The shim resolves to the running entry itself. Nothing hands off: the copy is
   // not installed inside this repository at all (it resolves out of it), and the
   // recursion guard stands behind that. What is proved here is the outcome a loop
   // would break: ONE process, one version line, a normal exit.
   const dir = seed('node-self', MARKER, true);
   const r = leji(['--version'], { cwd: dir });
   assert.equal(r.stdout, `${SDK_VERSION}\n`);
   assert.equal(r.status, 0);
   assert.equal(r.signal, null);
});

test('unreadable eligibility state runs the global, with no stack trace', (t) => {
   // The resolution happens before `run()` and outside its error handling, so a
   // throw here would reach the user as a traceback instead of the CLI they typed.
   const unreadable = (relative: string): string | null => {
      const dir = seed('node-eligible');
      const target = path.join(dir, relative);
      fs.chmodSync(target, 0o000);
      try {
         fs.readFileSync(target);
         return null; // running as root: this case cannot be built here
      } catch {
         return dir;
      }
   };
   const directory = seed('node-eligible');
   fs.rmSync(path.join(directory, 'leji.json'));
   fs.mkdirSync(path.join(directory, 'leji.json'));
   const cases = [
      unreadable('node_modules/@leji-org/leji/package.json'),
      unreadable('leji.json'),
      unreadable('package.json'),
      directory,
   ];
   if (cases.some((dir) => dir === null)) {
      t.diagnostic('some permission cases were skipped: this user can read a 0o000 file');
   }
   for (const dir of cases) {
      if (dir === null) continue;
      const r = leji(['--version'], { cwd: dir });
      assert.equal(r.stdout, `${SDK_VERSION}\n`);
      assert.equal(r.stderr, '', 'nothing is printed, and nothing throws');
      assert.equal(r.status, 0);
   }
});

test('a selected target that cannot be executed fails closed: named on stderr, exit 2', () => {
   const dir = seed('node-eligible', UNRUNNABLE);
   const r = leji(['validate'], { cwd: dir });
   assert.equal(r.status, 2);
   assert.equal(r.stdout, '');
   assert.match(r.stderr, /^leji: cannot run the repository's Leji CLI at node_modules\/\.bin\/leji: [A-Z]+\n$/);
});

test('a child that dies by signal ends this process the same way', (t) => {
   if (process.platform === 'win32') {
      t.skip('POSIX signal semantics; Windows names the signal and exits 1 instead');
      return;
   }
   const dir = seed('node-eligible', SIGNAL_MARKER);
   const r = leji(['validate'], { cwd: dir });
   assert.equal(r.signal, 'SIGTERM', 'the shell must see the termination the child had');
   assert.equal(r.status, null);
});
