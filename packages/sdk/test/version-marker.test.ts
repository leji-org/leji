import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// `--version`, `-v`, and `version` print a build marker when the CLI runs from a
// source checkout: `X.Y.Z+dev.<sha7>`, or `X.Y.Z+dev` when the checkout's revision
// cannot be read. A published artifact prints the bare `X.Y.Z`. The three cases are
// distinguished by where the package sits, so each one is a real run of the built
// CLI from a real layout rather than a call with the layout mocked out.
//
// Every run here names the CLI by path and never by command name: an ambient `leji`
// on PATH is exactly the artifact these assertions must not read.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(testDir, '..');
const cli = path.join(packageDir, 'dist', 'cli.js');
const BARE = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version as string;
/** The files a run of `leji --version` needs: the built code, its metadata, and the
 * cli.json the top-level help is generated from (read at module load). */
const PACKAGE_FILES = ['dist', 'package.json', 'cli.json'];

const temps: string[] = [];

function tmpdir(): string {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-version-marker-'));
   temps.push(dir);
   return dir;
}

after(() => {
   for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

/** One version run of the built CLI at `bin`, from a neutral working directory.
 * `env` adds to (and can override) the sanitized environment the run starts from. */
function version(bin: string, args: string[], env: Record<string, string> = {}): string {
   const res = spawnSync(process.execPath, [bin, ...args], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      env: {
         ...process.env,
         GIT_DIR: undefined,
         // No ancestor of a temp copy may answer for it: without a ceiling, a git
         // repository above os.tmpdir() would hand the copy a revision it has no
         // claim to, and the fallback cases below would pass for the wrong reason.
         GIT_CEILING_DIRECTORIES: os.tmpdir(),
         ...env,
      },
   });
   assert.equal(res.status, 0, `leji ${args.join(' ')} exited ${res.status}\n${res.stderr}`);
   return res.stdout.trim();
}

/** A copy of the built package at `rel` inside a fresh temp directory. The copy runs
 * against this checkout's installed dependencies, linked in where Node's resolver
 * looks for them; only the package's own location is what these cases vary. */
function copyPackage(rel: string[]): string {
   const root = tmpdir();
   const dest = path.join(root, ...rel);
   fs.mkdirSync(dest, { recursive: true });
   for (const entry of PACKAGE_FILES) {
      fs.cpSync(path.join(packageDir, entry), path.join(dest, entry), { recursive: true });
   }
   fs.symlinkSync(path.resolve(packageDir, '..', '..', 'node_modules'), path.join(root, 'node_modules'), 'junction');
   return root;
}

test('the CLI in this checkout prints the version with a build marker', () => {
   const printed = version(cli, ['--version']);
   assert.match(printed, /^\d+\.\d+\.\d+\+dev\.[0-9a-f]{7}$/, `--version printed ${printed}`);
   assert.equal(printed, `${BARE}+dev.${printed.slice(-7)}`, 'the marker is appended to the package version');
   assert.equal(version(cli, ['-v']), printed, '-v prints what --version prints');
   assert.equal(version(cli, ['version']), printed, 'the version subcommand prints what --version prints');
});

test('a checkout layout whose revision cannot be read prints +dev', () => {
   const root = copyPackage(['packages', 'sdk']);
   // A `.git` directory with nothing in it: the layout says checkout, git cannot say
   // which revision. That is the case the bare `+dev` fallback exists for.
   fs.mkdirSync(path.join(root, '.git'));
   const bin = path.join(root, 'packages', 'sdk', 'dist', 'cli.js');
   assert.equal(version(bin, ['--version']), `${BARE}+dev`);
   assert.equal(version(bin, ['version']), `${BARE}+dev`);
});

test('a package outside the checkout layout prints the bare version', () => {
   const root = copyPackage([]);
   // The layout an install has: the package's own files, no monorepo above them.
   // A `.git` beside it must not change the answer, so give it one.
   fs.mkdirSync(path.join(root, '.git'));
   const bin = path.join(root, 'dist', 'cli.js');
   assert.equal(version(bin, ['--version']), BARE);
   assert.equal(version(bin, ['version']), BARE);
});

// Git honors GIT_DIR over the `-C <root>` on the command line, so a shell that
// exports one (a hook, a wrapper, an editor's terminal) would otherwise hand this
// checkout's version line another repository's revision.

/** A second, unrelated git repository with one commit of its own. */
function otherRepo(): string {
   const dir = tmpdir();
   fs.writeFileSync(path.join(dir, 'README.md'), 'other\n');
   const git = (...args: string[]): void => {
      execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', env: { ...process.env, GIT_DIR: undefined } });
   };
   git('init', '-q');
   git('add', '-A');
   git('-c', 'user.name=T', '-c', 'user.email=t@e.com', 'commit', '-qm', 'seed');
   return dir;
}

test('GIT_DIR naming another repository does not answer for this checkout', () => {
   const other = otherRepo();
   const otherHead = execFileSync('git', ['-C', other, 'rev-parse', '--short=7', 'HEAD'], {
      encoding: 'utf8',
      env: { ...process.env, GIT_DIR: undefined },
   }).trim();
   const expected = version(cli, ['--version']);
   assert.notEqual(expected, `${BARE}+dev.${otherHead}`, 'the two repositories share a HEAD');
   assert.equal(version(cli, ['--version'], { GIT_DIR: path.join(other, '.git') }), expected);
   assert.equal(version(cli, ['version'], { GIT_DIR: path.join(other, '.git') }), expected);
});

test('GIT_DIR naming nothing does not answer for this checkout', () => {
   const expected = version(cli, ['--version']);
   assert.equal(version(cli, ['--version'], { GIT_DIR: path.join(os.tmpdir(), 'no-such-repository.git') }), expected);
});

test('no GIT_* variable redirects the lookup, GIT_DIR or otherwise', () => {
   // GIT_DIR is one name among many, and git keeps adding them: GIT_REFERENCE_BACKEND
   // redirects the ref store by URI and overrides configuration, so it answers with
   // another repository's HEAD from the same `-C` directory. The lookup inherits no
   // GIT_* variable that can do that, so neither name (nor the next one) reaches git.
   const otherGitDir = path.join(otherRepo(), '.git');
   const expected = version(cli, ['--version']);
   const redirected = version(cli, ['--version'], {
      GIT_REFERENCE_BACKEND: `files://${otherGitDir}`,
      GIT_DIR: otherGitDir,
   });
   assert.equal(redirected, expected);
});

test('GIT_CEILING_DIRECTORIES above the checkout still answers for it', () => {
   // The two variables the lookup keeps cannot change WHICH repository answers: a
   // ceiling above the checkout does not stop a search that starts inside it.
   const expected = version(cli, ['--version']);
   const aboveRepo = path.resolve(packageDir, '..', '..', '..');
   assert.equal(version(cli, ['--version'], { GIT_CEILING_DIRECTORIES: aboveRepo }), expected);
});
