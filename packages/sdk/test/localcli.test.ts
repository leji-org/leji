import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { effectiveRoot, run } from '../dist/index.js';
import {
   type LaunchIo,
   type LaunchOutcome,
   type LocalCliHandoff,
   launchLocalCli,
   resolveLocalCli,
} from '../dist/lib/localcli.js';

// The hand-off decision and the launch that follows it, unit level: the resolver over
// the committed `fixtures/handoff/` family with the installed state written here, and
// the launcher over an injected spawn, so every row of its result table is provable
// without ending this process. The end-to-end proof (real argv through a real child)
// is `test/proc/handoff.test.ts`.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(testDir, '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures', 'handoff');
const realCli = path.join(pkgRoot, 'dist', 'cli.js');

/** The platform this suite runs on, for the cases whose target is the POSIX shim.
 * The Windows branch is exercised by passing `win32` explicitly, since it resolves a
 * declared entry rather than asking the filesystem for an executable bit. */
const HOST: NodeJS.Platform = process.platform;

/** A self entry no fixture can ever be: the recursion guard is asserted with the
 * real one in its own case. */
const NOT_SELF = path.join(os.tmpdir(), 'leji-not-the-running-entry.js');

function tmpdir(prefix = 'leji-handoff-'): string {
   return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * The marker the hand-off must reach. It prints its own argv JSON-ENCODED, so
 * argument boundaries are provable rather than inferred from a joined string, and
 * exits 3, a status no leji command returns, so exit forwarding is observable.
 */
const MARKER =
   "#!/usr/bin/env node\nprocess.stdout.write('handoff:node:' + JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exit(3);\n";

/**
 * The shapes a package manager's bin shim actually takes. npm, bun and Yarn's
 * node-modules linker install a SYMLINK to the package entry; pnpm installs a small
 * SCRIPT that runs it. The difference is the whole reason identity is resolved from
 * the package's own entry rather than from what gets executed: only the symlink's
 * realpath is the entry, so a guard comparing the shim leaves the script shape open
 * to an unbounded loop.
 */
type ShimShape = 'symlink' | 'script';

interface InstallOptions {
   /** The installed package's declared version. */
   version?: string;
   /** Its declared identity. */
   name?: string;
   /** Its `bin` field, as JSON. */
   bin?: unknown;
   /** Raw metadata bytes, for the malformed cases. */
   metadata?: string;
   /** The marker is a symlink to the RUNNING entry: the recursion case. */
   selfEntry?: boolean;
   /** How the manager's shim reaches the entry. */
   shim?: ShimShape;
}

/** The state a committed fixture cannot carry: `node_modules` is never committed, so
 * the installed package, its entry, and the manager's bin shim are written here,
 * statically, exactly as an install would leave them. */
function install(dir: string, opts: InstallOptions = {}): string {
   const pkgDir = path.join(dir, 'node_modules', '@leji-org', 'leji');
   const entry = path.join(pkgDir, 'dist', 'cli.js');
   fs.mkdirSync(path.dirname(entry), { recursive: true });
   if (opts.selfEntry === true) fs.symlinkSync(realCli, entry);
   else fs.writeFileSync(entry, MARKER, { mode: 0o755 });
   const metadata =
      opts.metadata ??
      JSON.stringify(
         {
            name: opts.name ?? '@leji-org/leji',
            version: opts.version ?? '1.4.0',
            bin: 'bin' in opts ? opts.bin : { leji: 'dist/cli.js' },
         },
         null,
         2,
      ) + '\n';
   fs.writeFileSync(path.join(pkgDir, 'package.json'), metadata);
   installShim(dir, entry, opts.shim ?? 'symlink');
   return pkgDir;
}

/** The manager's shim, in the shape that manager installs. */
function installShim(dir: string, entry: string, shape: ShimShape): string {
   const binDir = path.join(dir, 'node_modules', '.bin');
   fs.mkdirSync(binDir, { recursive: true });
   const shim = path.join(binDir, 'leji');
   fs.rmSync(shim, { force: true });
   if (shape === 'symlink') {
      fs.symlinkSync(path.relative(binDir, entry), shim);
   } else {
      // pnpm's shape, reduced to what matters here: a real file that runs the entry.
      fs.writeFileSync(shim, `#!/bin/sh\nexec node "$(dirname "$0")/${path.relative(binDir, entry)}" "$@"\n`, {
         mode: 0o755,
      });
   }
   return shim;
}

/**
 * One case of the family: the committed miniature repository copied out, plus the
 * installed state its name declares. Every fixture is seeded by a file copy and a
 * write here; nothing is produced by running a CLI.
 */
function seed(name: string): string {
   const dir = tmpdir();
   fs.cpSync(path.join(fixturesDir, name), dir, { recursive: true });
   switch (name) {
      case 'node-eligible':
      case 'node-undeclared':
      case 'node-ambiguous-manager':
      case 'node-unsupported-manager':
      case 'node-unknown-spec-line':
      case 'node-shim-symlink':
      case 'node-shim-yarn':
      case 'polyglot':
         install(dir);
         break;
      case 'node-shim-script':
         install(dir, { shim: 'script' });
         break;
      case 'node-self':
         install(dir);
         break;
      case 'node-declared-missing':
      case 'go-tool':
         break; // nothing is installed at all
      case 'node-below-minimum':
         install(dir, { version: '0.9.3' });
         break;
      case 'node-malformed-version':
         install(dir, { version: '1.x' });
         break;
      case 'node-wrong-identity':
         install(dir, { name: '@example/leji' });
         break;
      case 'node-malformed-metadata':
         install(dir, { metadata: '{ this is not json\n' });
         break;
      case 'node-entry-not-regular':
         // A declared entry that is a directory. The entry is the copy's identity on
         // EVERY platform, so this is refused everywhere, not only where it is run.
         install(dir, { bin: { leji: 'dist' } });
         break;
      case 'node-metadata-not-regular': {
         const pkgDir = install(dir);
         fs.rmSync(path.join(pkgDir, 'package.json'));
         fs.mkdirSync(path.join(pkgDir, 'package.json'));
         break;
      }
      case 'node-escaped': {
         // The whole package directory is a link out of the repository: a copy that
         // is not installed HERE, whatever the spelling says.
         const outside = tmpdir('leji-handoff-outside-');
         install(outside);
         const scope = path.join(dir, 'node_modules', '@leji-org');
         fs.mkdirSync(scope, { recursive: true });
         fs.symlinkSync(path.join(outside, 'node_modules', '@leji-org', 'leji'), path.join(scope, 'leji'));
         break;
      }
      case 'node-refused': {
         // The manifest that gates the ecosystem resolves outside the repository, so
         // the evidence is refused and nothing about this root is decided from it.
         const outside = tmpdir('leji-handoff-outside-');
         fs.writeFileSync(path.join(outside, 'package.json'), '{ "devDependencies": { "@leji-org/leji": "^1" } }\n');
         fs.symlinkSync(path.join(outside, 'package.json'), path.join(dir, 'package.json'));
         install(dir);
         break;
      }
      default:
         throw new Error(`unseeded fixture ${name}`);
   }
   return dir;
}

/** The resolver as the executable calls it, with the root named explicitly (the
 * `--root` path is what a nested cwd would otherwise decide). */
function resolveIn(dir: string, extra: string[] = [], env: NodeJS.ProcessEnv = {}, platform = HOST) {
   return resolveLocalCli(['--root', dir, ...extra], env, platform, NOT_SELF);
}

// --- the decision table ------------------------------------------------------

/** Every fixture whose answer is the same on both platforms, with the reason the
 * hand-off is or is not made. */
const DECISIONS: ReadonlyArray<[string, boolean, string]> = [
   ['node-eligible', true, 'declared, installed inside the root, and at the minimum'],
   ['node-ambiguous-manager', true, 'two lockfile families: the manager is not what is being run'],
   ['node-unsupported-manager', true, 'an unknown packageManager: the target is the package, not the manager'],
   ['polyglot', true, "a Python repository too, decided on Node's own record"],
   ['node-undeclared', false, 'installed but not declared: the repository never asked for it'],
   ['node-declared-missing', false, 'declared but nothing is installed'],
   ['node-below-minimum', false, 'the installed major is under the layer minimum'],
   ['node-escaped', false, 'the package directory resolves outside the repository'],
   ['node-refused', false, 'the ecosystem evidence itself was refused'],
   ['node-wrong-identity', false, 'a directory spelled like the package is not the package'],
   ['node-malformed-metadata', false, 'the metadata does not parse'],
   ['node-malformed-version', false, 'the version does not parse'],
   ['node-metadata-not-regular', false, 'the metadata is not a regular file'],
   ['node-unknown-spec-line', false, 'the layer declares a spec line this SDK has no minimum for'],
   ['go-tool', false, 'a Go repository has no Node record to decide on'],
   ['node-shim-symlink', true, "npm and bun's shape: the shim is a symlink to the entry"],
   ['node-shim-script', true, "pnpm's shape: the shim is a script that runs the entry"],
   ['node-shim-yarn', true, "Yarn's node-modules linker: a symlink, like npm's"],
];

for (const [name, handoff, why] of DECISIONS) {
   test(`resolve: ${name} ${handoff ? 'hands off' : 'runs the global'} (${why})`, () => {
      const dir = seed(name);
      const resolved = resolveIn(dir);
      assert.equal(resolved.kind, handoff ? 'handoff' : 'none');
      if (resolved.kind === 'handoff') {
         assert.equal(resolved.display, 'node_modules/.bin/leji');
         assert.deepEqual(resolved.args, ['--root', dir]);
      }
   });
}

test('resolve: the package ENTRY is never the running entry (no recursion)', () => {
   // A repository whose installed copy IS the executable now running: handing off
   // would run it again, forever. Identity is the package's own entry, so the guard
   // holds whichever shape the shim in front of it has.
   for (const shim of ['symlink', 'script'] as const) {
      const dir = seed('node-eligible');
      install(dir, { shim });
      const self = fs.realpathSync.native(path.join(dir, 'node_modules', '@leji-org', 'leji', 'dist', 'cli.js'));
      assert.equal(resolveLocalCli(['--root', dir], {}, HOST, self).kind, 'none', shim);
      assert.equal(resolveLocalCli(['--root', dir], {}, 'win32', self).kind, 'none', shim);
      // The same tree with a different self hands off, so the refusal above is the
      // recursion guard and not the fixture being ineligible for another reason.
      assert.equal(resolveIn(dir).kind, 'handoff', shim);
   }
});

test('resolve: a script shim is executed, and the entry behind it is what identity compares', () => {
   const dir = seed('node-shim-script');
   const shim = path.join(dir, 'node_modules', '.bin', 'leji');
   // The shim is a regular file, NOT a link: its own realpath is itself, so a guard
   // comparing what gets executed would never recognize the copy behind it.
   assert.equal(fs.lstatSync(shim).isSymbolicLink(), false);
   const entryReal = fs.realpathSync.native(path.join(dir, 'node_modules', '@leji-org', 'leji', 'dist', 'cli.js'));
   assert.notEqual(fs.realpathSync.native(shim), entryReal);
   const resolved = resolveIn(dir);
   assert.equal(resolved.kind, 'handoff');
   if (resolved.kind === 'handoff') assert.equal(resolved.bin, shim);
   assert.equal(resolveLocalCli(['--root', dir], {}, HOST, entryReal).kind, 'none');
});

test('resolve: a package that declares no usable entry hands off nothing', () => {
   // Identity is the entry, so a copy whose entry cannot be resolved cannot be
   // proved distinct from this running one: fail closed, on every platform.
   for (const bin of [null, { leji: 'dist' }, { leji: '../../../elsewhere.js' }, {}, 'dist']) {
      const dir = seed('node-eligible');
      install(dir, { bin });
      assert.equal(resolveIn(dir).kind, 'none', JSON.stringify(bin));
      assert.equal(resolveLocalCli(['--root', dir], {}, 'win32', NOT_SELF).kind, 'none', JSON.stringify(bin));
   }
   // The plain string form is an entry like any other, and it is accepted.
   const ok = seed('node-eligible');
   install(ok, { bin: 'dist/cli.js' });
   assert.equal(resolveIn(ok).kind, 'handoff');
});

test('resolve: an unresolvable running entry refuses the hand-off', () => {
   const dir = seed('node-eligible');
   assert.equal(resolveLocalCli(['--root', dir], {}, HOST, null).kind, 'none');
});

test('resolve: LEJI_NO_LOCAL at any value refuses, and only its presence counts', () => {
   const dir = seed('node-eligible');
   for (const value of ['', '0', '1', 'no']) {
      assert.equal(resolveIn(dir, [], { LEJI_NO_LOCAL: value }).kind, 'none', `LEJI_NO_LOCAL=${value}`);
   }
   assert.equal(resolveIn(dir, [], { LEJI_NO_LOCAL_OTHER: '1' }).kind, 'handoff');
});

test('resolve: a nested cwd is not the root, and no scan walks up', () => {
   const dir = seed('node-eligible');
   const nested = path.join(dir, 'docs', 'context');
   fs.mkdirSync(nested, { recursive: true });
   assert.equal(resolveLocalCli(['--root', nested], {}, HOST, NOT_SELF).kind, 'none');
});

test('resolve: argv is forwarded verbatim, tokens after -- included', () => {
   const dir = seed('node-eligible');
   const argv = ['start', '--root', dir, '--json', '--', '--root', 'ignored', '', ' ', 'ünïcødé'];
   const resolved = resolveLocalCli(argv, {}, HOST, NOT_SELF);
   assert.equal(resolved.kind, 'handoff');
   if (resolved.kind !== 'handoff') return;
   assert.deepEqual(resolved.args, argv);
   assert.notEqual(resolved.bin, process.execPath); // the shim, executed as a file
});

test('resolve: a malformed root selects nothing', () => {
   const dir = seed('node-eligible');
   for (const argv of [['--root'], ['--root', '--json'], ['--root', ''], ['--name', '--root', dir]]) {
      assert.equal(resolveLocalCli(argv, {}, HOST, NOT_SELF).kind, 'none', argv.join(' '));
   }
});

// --- the Windows branch ------------------------------------------------------
// The `.cmd` shim cannot be executed without a shell, and this tool passes argv and
// never a command line, so the target there is the package's declared entry run by
// this Node. The resolution is pure path work, so it is provable on any platform.

test('resolve (win32): the declared entry runs under this Node, inside the package', () => {
   const dir = seed('node-eligible');
   const resolved = resolveLocalCli(['--root', dir], {}, 'win32', NOT_SELF);
   assert.equal(resolved.kind, 'handoff');
   if (resolved.kind !== 'handoff') return;
   assert.equal(resolved.bin, process.execPath);
   assert.deepEqual(resolved.args, [
      path.join(dir, 'node_modules', '@leji-org', 'leji', 'dist', 'cli.js'),
      '--root',
      dir,
   ]);
   assert.equal(resolved.display, 'node_modules/@leji-org/leji/dist/cli.js');
});

test('resolve (win32): a bin string, not only a map, names the entry', () => {
   const dir = tmpdir();
   fs.cpSync(path.join(fixturesDir, 'node-eligible'), dir, { recursive: true });
   install(dir, { bin: 'dist/cli.js' });
   const resolved = resolveLocalCli(['--root', dir], {}, 'win32', NOT_SELF);
   assert.equal(resolved.kind, 'handoff');
});

test('an entry that is not a regular file is refused on every platform', () => {
   // The entry is the identity of the copy now, so POSIX refuses it too: a copy whose
   // entry cannot be resolved cannot be proved distinct from this running one.
   const dir = seed('node-entry-not-regular');
   assert.equal(resolveLocalCli(['--root', dir], {}, 'win32', NOT_SELF).kind, 'none');
   assert.equal(resolveLocalCli(['--root', dir], {}, HOST, NOT_SELF).kind, 'none');
});

test('resolve (win32): an entry escaping the package directory is refused', () => {
   const dir = tmpdir();
   fs.cpSync(path.join(fixturesDir, 'node-eligible'), dir, { recursive: true });
   install(dir, { bin: { leji: '../../../elsewhere.js' } });
   fs.writeFileSync(path.join(dir, 'elsewhere.js'), MARKER, { mode: 0o755 });
   assert.equal(resolveLocalCli(['--root', dir], {}, 'win32', NOT_SELF).kind, 'none');
});

test('resolve (win32): a missing bin field is refused', () => {
   const dir = tmpdir();
   fs.cpSync(path.join(fixturesDir, 'node-eligible'), dir, { recursive: true });
   install(dir, { bin: null });
   assert.equal(resolveLocalCli(['--root', dir], {}, 'win32', NOT_SELF).kind, 'none');
});

test('resolve: package metadata past the read bound is refused', () => {
   const dir = tmpdir();
   fs.cpSync(path.join(fixturesDir, 'node-eligible'), dir, { recursive: true });
   const padded = JSON.stringify({
      name: '@leji-org/leji',
      version: '1.4.0',
      bin: { leji: 'dist/cli.js' },
      pad: 'x'.repeat(65 * 1024),
   });
   install(dir, { metadata: padded });
   assert.equal(resolveIn(dir).kind, 'none');
});

// --- unreadable eligibility state --------------------------------------------
// Resolution runs BEFORE `run()` and outside its error handling, so anything that
// throws here would reach the user as a stack trace where the global CLI was meant
// to run. Every read is total: refusal and unreadability are both no hand-off.

test('resolve: an unreadable installed package.json runs the global, silently', (t) => {
   const dir = seed('node-eligible');
   const metadata = path.join(dir, 'node_modules', '@leji-org', 'leji', 'package.json');
   fs.chmodSync(metadata, 0o000);
   try {
      if (fs.readFileSync(metadata).length >= 0) {
         t.skip('this user can read a 0o000 file (root); the permission case cannot be built here');
         return;
      }
   } catch {
      /* expected: the file is unreadable, which is the case under test */
   }
   assert.equal(resolveIn(dir).kind, 'none');
});

test('resolve: an unreadable spec line runs the global, silently', (t) => {
   const dir = seed('node-eligible');
   const manifest = path.join(dir, 'leji.json');
   fs.chmodSync(manifest, 0o000);
   try {
      if (fs.readFileSync(manifest).length >= 0) {
         t.skip('this user can read a 0o000 file (root)');
         return;
      }
   } catch {
      /* expected */
   }
   assert.equal(resolveIn(dir).kind, 'none');
});

test('resolve: a leji.json that is a directory runs the global, silently', () => {
   const dir = seed('node-eligible');
   const manifest = path.join(dir, 'leji.json');
   fs.rmSync(manifest);
   fs.mkdirSync(manifest);
   assert.equal(resolveIn(dir).kind, 'none');
});

test('resolve: a spec line read through a link out of the repository is refused', () => {
   const dir = seed('node-eligible');
   const outside = tmpdir('leji-handoff-outside-');
   fs.writeFileSync(path.join(outside, 'leji.json'), '{"leji":"1.0"}\n');
   fs.rmSync(path.join(dir, 'leji.json'));
   fs.symlinkSync(path.join(outside, 'leji.json'), path.join(dir, 'leji.json'));
   assert.equal(resolveIn(dir).kind, 'none');
});

test('resolve: a spec line past the read bound, or not a string, is refused', () => {
   for (const body of [
      JSON.stringify({ leji: '1.0', pad: 'x'.repeat(65 * 1024) }),
      JSON.stringify({ leji: 1 }),
      JSON.stringify(['1.0']),
      '{ not json',
   ]) {
      const dir = seed('node-eligible');
      fs.writeFileSync(path.join(dir, 'leji.json'), body);
      assert.equal(resolveIn(dir).kind, 'none', body.slice(0, 24));
   }
});

test('resolve: the spec line is the only thing the wrapper asks of the manifest', () => {
   // A manifest that would fail validation still names a spec line, and the hand-off
   // is about which CLI answers, not about whether the layer is valid: the CLI that
   // runs reports that, as it does today.
   const dir = seed('node-eligible');
   fs.writeFileSync(path.join(dir, 'leji.json'), JSON.stringify({ leji: '1.0' }) + '\n');
   assert.equal(resolveIn(dir).kind, 'handoff');
});

// --- the effective root ------------------------------------------------------

test('effectiveRoot: the pinned cases', () => {
   assert.equal(effectiveRoot([]), '.');
   assert.equal(effectiveRoot(['validate']), '.');
   assert.equal(effectiveRoot(['--root', 'x']), 'x');
   assert.equal(effectiveRoot(['--root=x']), 'x');
   assert.equal(effectiveRoot(['--root', 'a', '--root', 'b']), 'b', 'last --root wins');
   assert.equal(effectiveRoot(['--root=a', '--root', 'b']), 'b');
   assert.equal(effectiveRoot(['--json', '--root', 'x', 'validate']), 'x');
   assert.equal(effectiveRoot(['--topics', 'a b', '--root', 'x']), 'x', 'a value flag consumes its own value');
   assert.equal(effectiveRoot(['--root', '-']), '-', 'a bare dash is a value, not a flag');
   assert.equal(effectiveRoot(['--', '--root', 'x']), '.', 'tokens after -- are not our flags');
   assert.equal(effectiveRoot(['--root', 'x', '--', '--root', 'y']), 'x');
   assert.equal(effectiveRoot(['--root']), null, 'a missing value decides nothing');
   assert.equal(effectiveRoot(['--root', '--json']), null, 'a flag-looking value decides nothing');
   assert.equal(effectiveRoot(['--root', '']), null, 'an empty value is the usage error');
   assert.equal(effectiveRoot(['--name', '--root', 'x']), null, 'a malformed sequence decides nothing');
   assert.equal(effectiveRoot(['--root=']), null);
});

/**
 * The drift test. `parseFlags` is not exported, so the root it lands on is asserted
 * where it is observable: WHICH repository the command answered about. One root
 * carries a layer and the other does not, so a parse that landed on the other root
 * cannot produce the same exit code. Every pinned case whose argv is a valid
 * `validate` invocation is run this way; the ones that are usage errors assert the
 * usage exit, which is what a null effective root means.
 */
test('effectiveRoot: the parser lands on the root the wrapper computed', async (t) => {
   const layer = tmpdir('leji-handoff-layer-');
   fs.cpSync(path.join(repoRoot, 'fixtures', 'valid-minimal-core'), layer, { recursive: true });
   fs.rmSync(path.join(layer, 'expected.json'), { force: true });
   const empty = tmpdir('leji-handoff-empty-');
   const cases: string[][] = [
      ['validate', '--root', layer],
      ['validate', `--root=${layer}`],
      ['validate', '--root', empty, '--root', layer],
      ['validate', '--json', '--root', layer],
      ['validate', '--root', empty],
      ['validate', '--root'],
      ['validate', '--root', '--json'],
      ['validate', '--name', '--root', layer],
   ];
   const origLog = console.log;
   const origError = console.error;
   const origCwd = process.cwd();
   console.log = () => {};
   console.error = () => {};
   try {
      process.chdir(empty);
      for (const argv of cases) {
         const root = effectiveRoot(argv.slice(1));
         const code = await run(argv);
         // A root the wrapper could not decide is the usage error the parse reports;
         // a decided root is answered about, and only the layer validates clean.
         const expected = root === null ? 2 : path.resolve(root) === path.resolve(layer) ? 0 : 1;
         assert.equal(code, expected, `${argv.join(' ')} (effective root ${root})`);
      }
   } finally {
      process.chdir(origCwd);
      console.log = origLog;
      console.error = origError;
      t.diagnostic(`${cases.length} argv forms compared`);
   }
});

// --- the launcher's result table ---------------------------------------------

interface Recorded {
   stderr: string[];
   exits: number[];
   reraised: NodeJS.Signals[];
   spawned: Array<{ bin: string; args: string[] }>;
}

class Exited extends Error {}

/** An injected world: every effect is recorded, and `exit` throws so the launcher's
 * "never returns" contract is observable without ending the test runner. */
function recorder(outcome: LaunchOutcome, platform: NodeJS.Platform = 'linux'): { io: LaunchIo; log: Recorded } {
   const log: Recorded = { stderr: [], exits: [], reraised: [], spawned: [] };
   const io: LaunchIo = {
      platform,
      spawn: (bin, args) => {
         log.spawned.push({ bin, args });
         return outcome;
      },
      reraise: (signal) => log.reraised.push(signal),
      stderr: (line) => log.stderr.push(line),
      exit: (code) => {
         log.exits.push(code);
         throw new Exited(`exit ${code}`);
      },
   };
   return { io, log };
}

const HANDOFF: LocalCliHandoff = {
   kind: 'handoff',
   bin: '/repo/node_modules/.bin/leji',
   args: ['validate', '--json'],
   display: 'node_modules/.bin/leji',
};

function launched(outcome: LaunchOutcome, platform: NodeJS.Platform = 'linux'): Recorded {
   const { io, log } = recorder(outcome, platform);
   assert.throws(() => launchLocalCli(HANDOFF, io), Exited, 'the launcher must never return');
   return log;
}

test('launch: an integer status is the status this process exits with', () => {
   for (const status of [0, 1, 2, 3, 127]) {
      const log = launched({ status, signal: null });
      assert.deepEqual(log.exits, [status]);
      assert.deepEqual(log.stderr, []);
      assert.deepEqual(log.spawned, [{ bin: HANDOFF.bin, args: HANDOFF.args }]);
   }
});

test('launch: a signal is re-raised on POSIX so the shell sees the same end', () => {
   const log = launched({ status: null, signal: 'SIGTERM' });
   assert.deepEqual(log.reraised, ['SIGTERM']);
   assert.deepEqual(log.exits, [128 + os.constants.signals.SIGTERM]);
   assert.deepEqual(log.stderr, []);
});

test('launch: a signal on Windows is named and exits 1, the documented limitation', () => {
   const log = launched({ status: null, signal: 'SIGKILL' }, 'win32');
   assert.deepEqual(log.reraised, []);
   assert.deepEqual(log.stderr, ["leji: the repository's Leji CLI ended by SIGKILL"]);
   assert.deepEqual(log.exits, [1]);
});

test('launch: a failed spawn fails closed, never falling through to the global', () => {
   const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
   const log = launched({ status: null, signal: null, error });
   assert.deepEqual(log.stderr, ["leji: cannot run the repository's Leji CLI at node_modules/.bin/leji: ENOENT"]);
   assert.deepEqual(log.exits, [2]);
});

test('launch: a spawn error without an errno code still names the failure', () => {
   const log = launched({ status: null, signal: null, error: new Error('no code here') });
   assert.deepEqual(log.stderr, ["leji: cannot run the repository's Leji CLI at node_modules/.bin/leji: no code here"]);
   assert.deepEqual(log.exits, [2]);
});

test('launch: neither a status nor a signal is never accidental success', () => {
   const log = launched({ status: null, signal: null });
   assert.deepEqual(log.stderr, [
      "leji: cannot run the repository's Leji CLI at node_modules/.bin/leji: no exit status",
   ]);
   assert.deepEqual(log.exits, [2]);
});
