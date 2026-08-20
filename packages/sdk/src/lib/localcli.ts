import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MIN_SDK_FOR_SPEC_LINE, VERSION_RE, installedNodeBin } from '../commands/preflight.js';
import { effectiveRoot } from '../index.js';
import { DEP_NAME, detectEcosystem } from './ecosystem.js';
import { guardRoot, openVerifiedSource, resolvedPath, toPosix } from './fsx.js';
import { MANIFEST_FILENAME } from './manifest.js';

/**
 * The hand-off the INSTALLED EXECUTABLE performs before it parses anything: inside a
 * repository that declares the Leji CLI and has it installed, an invocation of the
 * global `leji` belongs to the repository's own pinned copy, so a teammate, a hook,
 * CI, and a person typing `leji` all run one version of the tool.
 *
 * Nothing here is reachable from the library. `run()` is imported in-process by the
 * scaffolder and by tests, and a library call must never turn into another program.
 *
 * Every negative outcome is SILENT and spawns nothing: the global runs exactly as it
 * did before, so a repository that does not qualify pays a few bounded reads and
 * notices no difference. The reads that decide the execution are the verified form
 * (`openVerifiedSource`), because the bytes that decide what runs must come from the
 * file the containment check cleared. The residual is the recorded check-before-act limit, stated
 * in `docs/practice/trust-boundary.md`: a target swapped between the check and the
 * exec cannot be closed portably, and it is named in the allowance rather than
 * claimed away.
 */

/** The node ecosystem statuses that still permit a hand-off. Which package manager
 * a repository uses is irrelevant here: the target is the installed package itself,
 * never a manager's script runner, so an ambiguous or unknown manager does not stop
 * a copy that is provably installed inside the repository. A manifest that could not
 * be read, or evidence the scan refused, is not "installed here" and stops it. */
const NODE_ACCEPTED_STATUSES: ReadonlySet<string> = new Set(['ok', 'ambiguous-manager', 'unsupported-manager']);

/** The one variable that turns the hand-off off, set to ANY value including empty.
 * Nothing of ours is ever ADDED to the environment: the agent host `leji start`
 * launches inherits the user's environment untouched, so no sentinel of ours can
 * leak into it and silently disable the hand-off for everything it runs. */
const OPT_OUT = 'LEJI_NO_LOCAL';

/** The installed package's own metadata, read whole and bounded. A package manifest
 * is a few kilobytes; anything past this is not one, and reading it is not this
 * wrapper's job. */
const MAX_METADATA_BYTES = 64 * 1024;

/** No repository copy runs this invocation: the global CLI continues. */
export interface LocalCliNone {
   kind: 'none';
}

/** The repository's own CLI, and exactly how to run it. `args` is the argv this
 * process received, verbatim. */
export interface LocalCliHandoff {
   kind: 'handoff';
   /** The program to execute. Argv, never a shell. */
   bin: string;
   args: string[];
   /** The target as a failure would name it: repository-relative, POSIX-spelled. */
   display: string;
}

export type LocalCli = LocalCliNone | LocalCliHandoff;

const NONE: LocalCliNone = { kind: 'none' };

/**
 * Decide whether this invocation belongs to a repository's own pinned CLI.
 *
 * `selfEntryRealpath` is the resolved path of the running entry file, or null when
 * it could not be resolved; the hand-off is refused when the package's own ENTRY is
 * that file, which is what keeps a repository whose install points back at this very
 * executable from handing off to itself forever. An unknown self is refused for the
 * same reason.
 *
 * The entry is the identity of the copy, on every platform, and it is deliberately
 * NOT the thing POSIX executes: a package manager's shim may be a symlink to the
 * entry (npm, bun, Yarn's node-modules linker) or a small script that runs it
 * (pnpm), and only the first has a realpath that equals the entry. Comparing the
 * shim would leave the script shape unguarded, and the loop it opens is unbounded:
 * the global runs the shim, the shim runs the entry, and the entry resolves the shim
 * again forever. So identity is resolved from the package's own `bin.leji` and the
 * shim is only what gets executed.
 *
 * All of the following must hold, and each one is checked on the resolved path
 * rather than on a spelling:
 *
 * | condition | why |
 * | --- | --- |
 * | `LEJI_NO_LOCAL` absent from the environment | the single opt-out |
 * | the argv names a root at all | a malformed command line selects no repository |
 * | the root has a node record whose status is accepted | it is a Node repository |
 * | that record declares the CLI directly | the repository committed the intent |
 * | the layer's spec line reads back and has a minimum | the bar to meet |
 * | the installed package identifies itself as this package | a directory spelling is not an identity |
 * | its version parses and its major meets the minimum | an older copy cannot serve this layer |
 * | its entry resolves inside the package's own directory | a `bin` field is repository-controlled text |
 * | the executable resolves inside the real root | never a linked copy elsewhere |
 * | that entry is not this running entry | no recursion, whatever shape the shim has |
 *
 * Every read here is TOTAL: an unreadable manifest, a permission error, a directory
 * where a file was expected, or any other I/O failure is no hand-off, never an
 * exception. This runs before `run()` and outside its error handling, so a throw
 * would be a stack trace where the global CLI was supposed to run.
 */
export function resolveLocalCli(
   argv: string[],
   env: NodeJS.ProcessEnv,
   platform: NodeJS.Platform,
   selfEntryRealpath: string | null,
): LocalCli {
   try {
      return resolve(argv, env, platform, selfEntryRealpath);
   } catch {
      return NONE;
   }
}

function resolve(
   argv: string[],
   env: NodeJS.ProcessEnv,
   platform: NodeJS.Platform,
   selfEntryRealpath: string | null,
): LocalCli {
   if (OPT_OUT in env) return NONE;
   if (selfEntryRealpath === null) return NONE;
   const rootArg = effectiveRoot(argv);
   if (rootArg === null) return NONE;
   const rootAbs = path.resolve(rootArg);
   const rootReal = guardRoot(rootAbs);

   const node = detectEcosystem(rootAbs).all.find((r) => r.ecosystem === 'node');
   if (node === undefined || !NODE_ACCEPTED_STATUSES.has(node.status) || !node.directDeclared) return NONE;

   const specLine = readSpecLine(rootReal, path.join(rootAbs, MANIFEST_FILENAME));
   if (specLine === null) return NONE;
   const minimum = MIN_SDK_FOR_SPEC_LINE[specLine];
   if (minimum === undefined) return NONE;

   const packageDir = path.join(rootAbs, 'node_modules', ...DEP_NAME.split('/'));
   const metadata = readInstalledMetadata(rootReal, path.join(packageDir, 'package.json'));
   if (metadata === null || metadata.name !== DEP_NAME) return NONE;
   if (typeof metadata.version !== 'string') return NONE;
   const version = VERSION_RE.exec(metadata.version);
   if (version === null || Number(version[1]) < Number(minimum.split('.')[0])) return NONE;

   // The identity of the copy, on every platform: what a hand-off would end up
   // running, whichever shape the shim in front of it has.
   const entry = packageEntry(packageDir, metadata);
   if (entry === null || entry.real === selfEntryRealpath) return NONE;

   if (platform === 'win32') {
      // The `.cmd` shim cannot be executed without a shell, and this tool passes
      // argv and never a command line, so Windows runs the entry under this Node.
      const display = toPosix(path.relative(rootAbs, entry.file));
      return { kind: 'handoff', bin: process.execPath, args: [entry.file, ...argv], display };
   }
   // POSIX executes the shim the manager installed, exactly as `leji start`'s probe
   // does, so whatever setup that manager's shim performs is preserved rather than
   // guessed at. It must still be the repository's own: a regular file after
   // symlinks, resolving inside the real root, executable.
   const shim = installedNodeBin(rootAbs);
   if (shim === null) return NONE;
   return { kind: 'handoff', bin: shim, args: [...argv], display: toPosix(path.relative(rootAbs, shim)) };
}

/** The package's own entry: where it really lives, and the path to run it by. */
interface Entry {
   file: string;
   real: string;
}

/**
 * The entry the installed package declares (`bin` as a string or as a map), or null.
 * It must resolve INSIDE the package's own resolved directory and be a regular file:
 * a `bin` field is repository-controlled text, and a path escaping the package it
 * belongs to is not this package's entry, whatever else it is.
 */
function packageEntry(packageDir: string, metadata: InstalledMetadata): Entry | null {
   const bin = metadata.bin;
   const declared =
      typeof bin === 'string'
         ? bin
         : typeof bin === 'object' && bin !== null
           ? (bin as Record<string, unknown>)['leji']
           : undefined;
   if (typeof declared !== 'string' || declared === '') return null;
   const packageReal = resolvedPath(packageDir);
   if (packageReal === null) return null;
   const file = path.join(packageDir, declared);
   const real = resolvedPath(file);
   if (real === null || !(real === packageReal || real.startsWith(packageReal + path.sep))) return null;
   let entry: fs.Stats;
   try {
      entry = fs.statSync(real);
   } catch {
      return null;
   }
   return entry.isFile() ? { file, real } : null;
}

/** The fields of the installed package's metadata this wrapper reads. */
interface InstalledMetadata {
   name?: unknown;
   version?: unknown;
   bin?: unknown;
}

/**
 * The layer's declared spec line, read the way the bytes that decide an execution
 * have to be: through the verified helper, inside the real root, bounded, and total.
 * Only this one field is the wrapper's business. Whether the rest of the manifest is
 * a valid layer is `run()`'s question, asked after the hand-off decision and by
 * whichever CLI ends up answering it.
 */
function readSpecLine(rootReal: string, abs: string): string | null {
   const data = readVerifiedJson(rootReal, abs);
   if (data === null) return null;
   const line = (data as { leji?: unknown }).leji;
   return typeof line === 'string' ? line : null;
}

/**
 * The installed package's `package.json`, or null. Verified: the path is resolved,
 * the resolved path is required to stay inside the real repository root, and the
 * bytes come from the descriptor `fstat` proved a regular file, so the metadata that
 * decides what runs is the metadata the containment check judged. Bounded, malformed
 * input included: a size past the cap, unparseable JSON, or anything that is not a
 * JSON object is simply no hand-off.
 */
function readInstalledMetadata(rootReal: string, abs: string): InstalledMetadata | null {
   return readVerifiedJson(rootReal, abs);
}

/**
 * One JSON document whose bytes decide whether repository code runs. Verified: the
 * path is resolved, the resolved path is required to stay inside the real repository
 * root, and the bytes come from the descriptor `fstat` proved a regular file, so the
 * document that decides is the document the containment check judged. Bounded and
 * total: a size past the cap, an I/O failure, unparseable JSON, or anything that is
 * not a JSON object is simply no hand-off.
 */
function readVerifiedJson(rootReal: string, abs: string): Record<string, unknown> | null {
   let fd: number | null = null;
   try {
      fd = openVerifiedSource(abs, (real) => real === rootReal || real.startsWith(rootReal + path.sep)).fd;
      if (fd === null) return null;
      if (fs.fstatSync(fd).size > MAX_METADATA_BYTES) return null;
      const data: unknown = JSON.parse(fs.readFileSync(fd, 'utf8'));
      return typeof data === 'object' && data !== null && !Array.isArray(data)
         ? (data as Record<string, unknown>)
         : null;
   } catch {
      return null;
   } finally {
      if (fd !== null) fs.closeSync(fd);
   }
}

/** What running the repository's CLI produced: its exit status, the signal that
 * ended it, or the failure to start it at all. The three are exhaustive, and the
 * fourth row of the table below is the pair that should be impossible. */
export interface LaunchOutcome {
   status: number | null;
   signal: NodeJS.Signals | null;
   error?: Error;
}

/** Everything the launcher does to the outside world, injectable so every row of the
 * result table is provable without ending the test runner. */
export interface LaunchIo {
   platform: NodeJS.Platform;
   spawn(bin: string, args: string[]): LaunchOutcome;
   /** Re-raise a signal on ourselves so the shell sees the termination the child
    * had, with our own handlers removed first: the default disposition, not a
    * listener of ours, has to be what acts. */
   reraise(signal: NodeJS.Signals): void;
   stderr(line: string): void;
   exit(code: number): never;
}

/** The real world. Argv, never a shell, and the child inherits this terminal: it IS
 * this invocation now, so its stdin, stdout, stderr, cwd and environment are ours. */
function spawnInherit(bin: string, args: string[]): LaunchOutcome {
   const result = spawnSync(bin, args, { stdio: 'inherit' });
   return { status: result.status, signal: result.signal, error: result.error };
}

function defaultLaunchIo(): LaunchIo {
   return {
      platform: process.platform,
      spawn: spawnInherit,
      reraise: (signal) => {
         process.removeAllListeners(signal);
         process.kill(process.pid, signal);
      },
      stderr: (line) => {
         console.error(line);
      },
      exit: (code) => process.exit(code),
   };
}

/**
 * Run the repository's CLI and become its result. Never returns.
 *
 * | outcome | what this process does |
 * | --- | --- |
 * | integer status | exits with it: the child's 0/1/2 contract is the one that surfaces |
 * | signal, POSIX | re-raises it on itself, so the shell sees the same termination; exits 128+signum if that somehow leaves us alive |
 * | signal, Windows | names it on stderr and exits 1, the documented limitation |
 * | the spawn failed | names it on stderr and exits 2 |
 * | neither status nor signal | the same fail-closed exit 2 |
 *
 * Failure is CLOSED, never a quiet fall-through to the global CLI: an eligible
 * pinned copy was already selected, so running a different version instead would
 * recreate the exact drift this hand-off exists to remove, possibly under a command
 * that writes.
 */
export function launchLocalCli(handoff: LocalCliHandoff, io: LaunchIo = defaultLaunchIo()): never {
   const result = io.spawn(handoff.bin, handoff.args);
   if (result.error !== undefined) {
      return failed(io, handoff, (result.error as NodeJS.ErrnoException).code ?? result.error.message);
   }
   if (result.signal !== null) {
      if (io.platform === 'win32') {
         io.stderr(`leji: the repository's Leji CLI ended by ${result.signal}`);
         return io.exit(1);
      }
      io.reraise(result.signal);
      return io.exit(128 + (os.constants.signals[result.signal] ?? 0));
   }
   if (result.status === null) return failed(io, handoff, 'no exit status');
   return io.exit(result.status);
}

function failed(io: LaunchIo, handoff: LocalCliHandoff, code: string): never {
   io.stderr(`leji: cannot run the repository's Leji CLI at ${handoff.display}: ${code}`);
   return io.exit(2);
}
