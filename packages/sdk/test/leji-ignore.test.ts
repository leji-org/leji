import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as Module from 'node:module';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
   LEJI_IGNORE_CONTENT,
   LEJI_IGNORE_NOTICE,
   ensureApprovalGuard,
   ensureLejiIgnoreFile,
   loadManifest,
   newLejiIgnoreContext,
   run,
} from '../dist/index.js';

// The self-managed `.leji/.gitignore`, driven from the shared fixtures: the tool
// ignores its own tree from inside, so a layer whose root `.gitignore` never
// received the `.leji/` line is clean after its first role-creating command. The
// fixtures own the scenario definitions (`lejiIgnore`), so all three SDKs answer the
// same six questions against the same trees; the unit tests below them pin what a
// fixture cannot construct without injecting a fault.

const IGNORE_FIXTURES = ['valid-leji-ignore-fresh', 'valid-leji-ignore-existing', 'valid-leji-ignore-legacy'];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures');

interface Seed {
   from: string;
   to: string;
}

interface Plant {
   symlinkAt: string;
   symlinkTo: string;
   targetKind: 'dir' | 'file';
   targetBytes?: string;
}

interface Scenario {
   id: string;
   note: string;
   args: string[];
   plant?: Plant;
   exit: number;
   ignoreFile: 'regular' | 'symlink' | 'absent';
   bytes: string | null;
   notices: number;
   untrackedUnderLeji?: string[];
   preserved?: string[];
   jsonParses?: boolean;
}

/** A fixture-declared path, as the README fixes it: repository-root-relative POSIX,
 * normalized, no `..` segment, never absolute. */
function fixtureRel(value: string, what: string): string {
   assert.ok(!path.posix.isAbsolute(value), `${what} must be relative: ${value}`);
   const normalized = path.posix.normalize(value).replace(/\/+$/, '');
   assert.equal(normalized, value.replace(/\/+$/, ''), `${what} must be normalized: ${value}`);
   assert.ok(!normalized.split('/').includes('..'), `${what} must not escape the fixture: ${value}`);
   return normalized;
}

/** Copy a committed seed's CONTENTS into `to`, which the harness creates. */
function copySeed(from: string, to: string): void {
   fs.mkdirSync(to, { recursive: true });
   for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), `seed carries a symlink: ${path.join(from, entry.name)}`);
      const src = path.join(from, entry.name);
      const dest = path.join(to, entry.name);
      if (entry.isDirectory()) copySeed(src, dest);
      else fs.copyFileSync(src, dest);
   }
}

/** A pristine working copy of the fixture with every declared seed materialized,
 * committed to its own git repository: `git status --porcelain` is one half of what
 * these scenarios assert, and it answers nothing useful over an uncommitted tree. */
function gitFixture(name: string, seeds: Seed[]): string {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-ignore-'));
   fs.cpSync(path.join(fixturesDir, name), dir, { recursive: true });
   for (const seed of seeds) {
      const toAbs = path.join(dir, ...fixtureRel(seed.to, 'seed.to').split('/'));
      assert.ok(!fs.existsSync(toAbs), `seed target already exists: ${seed.to}`);
      copySeed(path.join(dir, ...fixtureRel(seed.from, 'seed.from').split('/')), toAbs);
   }
   const git = (...args: string[]): void => {
      execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
   };
   git('init', '-q', '-b', 'main');
   git('-c', 'user.email=fixtures@leji.org', '-c', 'user.name=Leji Fixtures', 'add', '-A');
   git(
      '-c',
      'user.email=fixtures@leji.org',
      '-c',
      'user.name=Leji Fixtures',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'fixture',
   );
   return dir;
}

/** The declared symlink, and whatever it points at, planted before the run. A link
 * out of the repository is spelled `outside`: it resolves to a directory the harness
 * makes beside the working copy, which is the only shape a fixture cannot commit and
 * cannot express as a contained relative path. */
function plant(dir: string, declaration: Plant): string {
   const at = path.join(dir, ...fixtureRel(declaration.symlinkAt, 'plant.symlinkAt').split('/'));
   let target: string;
   if (declaration.symlinkTo === 'outside') {
      target = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-ignore-outside-'));
   } else {
      target = path.join(dir, ...fixtureRel(declaration.symlinkTo, 'plant.symlinkTo').split('/'));
   }
   if (declaration.targetKind === 'dir') fs.mkdirSync(target, { recursive: true });
   else fs.writeFileSync(target, declaration.targetBytes ?? '');
   fs.mkdirSync(path.dirname(at), { recursive: true });
   fs.symlinkSync(target, at);
   return target;
}

/** stdout and stderr for the length of one run. The notice is a stderr line under
 * every output mode, so counting it is what the `notices` field pins. */
function capture(): { restore: () => void; out: () => string; err: () => string } {
   const outChunks: string[] = [];
   const errChunks: string[] = [];
   const origErr = process.stderr.write.bind(process.stderr);
   const origLog = console.log.bind(console);
   (process.stderr as unknown as { write: unknown }).write = (s: unknown): boolean => {
      errChunks.push(String(s));
      return true;
   };
   console.log = (...args: unknown[]): void => {
      outChunks.push(args.map(String).join(' ') + '\n');
   };
   return {
      restore: () => {
         (process.stderr as unknown as { write: unknown }).write = origErr;
         console.log = origLog;
      },
      out: () => outChunks.join(''),
      err: () => errChunks.join(''),
   };
}

/** `git status --porcelain` entries whose path lies under the root `.leji/`. */
function untrackedUnderLeji(dir: string): string[] {
   const raw = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
   return raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => line.slice(3).replace(/^"|"$/g, ''))
      .filter((rel) => rel === '.leji' || rel.startsWith('.leji/'))
      .sort();
}

for (const name of IGNORE_FIXTURES) {
   const expected = JSON.parse(fs.readFileSync(path.join(fixturesDir, name, 'expected.json'), 'utf8')) as {
      seeds?: Seed[];
      lejiIgnore?: { scenarios: Scenario[] };
   };
   const block = expected.lejiIgnore;
   assert.ok(block, `${name} declares a lejiIgnore block`);

   for (const scenario of block.scenarios) {
      test(`fixture ${name}: leji-ignore scenario ${scenario.id} (${scenario.note})`, async () => {
         const dir = gitFixture(name, expected.seeds ?? []);
         if (scenario.plant) plant(dir, scenario.plant);
         const before = new Map<string, Buffer>();
         for (const rel of scenario.preserved ?? []) {
            const abs = path.join(dir, ...fixtureRel(rel, 'preserved entry').split('/'));
            assert.ok(fs.existsSync(abs), `preserved path exists before the run: ${rel}`);
            before.set(rel, fs.readFileSync(abs));
         }

         const captured = capture();
         let code: number;
         try {
            code = await run([...scenario.args, '--root', dir]);
         } finally {
            captured.restore();
         }
         assert.equal(code, scenario.exit, `exit code (stderr: ${captured.err()})`);

         // The one file, judged on its ORIGINAL entry: a symlink standing there was
         // refused, never followed, so lstat is what decides its kind.
         const ignoreAbs = path.join(dir, '.leji', '.gitignore');
         const entry = fs.lstatSync(ignoreAbs, { throwIfNoEntry: false });
         if (scenario.ignoreFile === 'absent') {
            assert.equal(entry, undefined, '.leji/.gitignore must not exist');
         } else if (scenario.ignoreFile === 'symlink') {
            assert.ok(entry?.isSymbolicLink() === true, '.leji/.gitignore is still the planted symlink');
         } else {
            assert.ok(entry?.isFile() === true, '.leji/.gitignore is a regular file');
            assert.equal(fs.readFileSync(ignoreAbs, 'utf8'), scenario.bytes, '.leji/.gitignore bytes');
         }

         const notices = captured.err().split(LEJI_IGNORE_NOTICE).length - 1;
         assert.equal(notices, scenario.notices, `notice count (stderr: ${captured.err()})`);

         if (scenario.jsonParses === true) {
            const document = JSON.parse(captured.out()) as Record<string, unknown>;
            assert.ok(typeof document === 'object' && document !== null, '--json stdout parses as one document');
            assert.ok(
               !JSON.stringify(document).includes('was left as is'),
               'the notice is stderr only, never inside the JSON document',
            );
         }

         if (scenario.untrackedUnderLeji !== undefined) {
            assert.deepEqual(untrackedUnderLeji(dir), scenario.untrackedUnderLeji, 'git status under .leji/');
         }

         for (const [rel, bytes] of before) {
            const abs = path.join(dir, ...rel.split('/'));
            assert.deepEqual(fs.readFileSync(abs), bytes, `preserved byte-identical: ${rel}`);
         }
      });
   }
}

// --- unit level: what a fixture cannot prepare without injecting a fault --------

/** The smallest layer these unit tests drive, copied out of the fixture family. */
function freshCopy(): string {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-ignore-unit-'));
   fs.cpSync(path.join(fixturesDir, 'valid-leji-ignore-fresh'), dir, { recursive: true });
   fs.rmSync(path.join(dir, 'expected.json'), { force: true });
   return dir;
}

test('the notice text is frozen, and one context says it exactly once however many roles are established', () => {
   assert.equal(LEJI_IGNORE_NOTICE, 'leji: .leji/.gitignore exists and was left as is (expected content: *)');
   assert.equal(LEJI_IGNORE_CONTENT, '*\n');

   const dir = freshCopy();
   fs.mkdirSync(path.join(dir, '.leji'), { recursive: true });
   fs.writeFileSync(path.join(dir, '.leji', '.gitignore'), 'mine\n');
   const captured = capture();
   let text: string;
   try {
      const ctx = newLejiIgnoreContext();
      assert.equal(ensureLejiIgnoreFile(dir, ctx), 'left-as-is');
      assert.equal(ensureLejiIgnoreFile(dir, ctx), 'left-as-is');
      assert.equal(ensureLejiIgnoreFile(dir, ctx), 'left-as-is');
   } finally {
      captured.restore();
      text = captured.err();
   }
   assert.equal(text, `${LEJI_IGNORE_NOTICE}\n`, 'one notice per invocation context');
   assert.equal(fs.readFileSync(path.join(dir, '.leji', '.gitignore'), 'utf8'), 'mine\n', 'bytes untouched');
});

test('a context is per invocation, never per process: a second one notices for its own repository', () => {
   const first = freshCopy();
   const second = freshCopy();
   for (const dir of [first, second]) {
      fs.mkdirSync(path.join(dir, '.leji'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.leji', '.gitignore'), 'mine\n');
   }
   const captured = capture();
   let text: string;
   try {
      ensureLejiIgnoreFile(first, newLejiIgnoreContext());
      ensureLejiIgnoreFile(second, newLejiIgnoreContext());
   } finally {
      captured.restore();
      text = captured.err();
   }
   assert.equal(text.split(LEJI_IGNORE_NOTICE).length - 1, 2, 'each invocation says it for itself');
});

test('the create is exclusive: an entry that appears between the read and the write is never written through', () => {
   // The check/use gap on the WRITE side, at the one file this exception allows. The
   // verified read finds nothing standing at the target; a symlink into ordinary
   // content is planted immediately after that last look, before the create runs.
   // O_EXCL is what closes the window: a create that followed the link would rewrite
   // `decoy.txt`. Mutation that reddens: drop `exclusive` from the guarded write.
   const dir = fs.realpathSync(freshCopy());
   fs.mkdirSync(path.join(dir, '.leji'), { recursive: true });
   const decoy = path.join(dir, 'decoy.txt');
   fs.writeFileSync(decoy, 'not the ignore file\n');
   const ignoreAbs = path.join(dir, '.leji', '.gitignore');

   // Builtin ESM bindings are snapshotted at link time, hence the CJS patch plus the
   // resync (the idiom the canary suite's interception spies use). The read's own
   // failed open arms the swap, so the plant lands after the read has decided and
   // before the exclusive create asks.
   const require = createRequire(import.meta.url);
   const nodeFs = require('node:fs') as Record<string, unknown>;
   const openSync = nodeFs.openSync as (...args: unknown[]) => unknown;
   const lstatSync = nodeFs.lstatSync as (...args: unknown[]) => unknown;
   let armed = false;
   let planted = false;
   nodeFs.openSync = (...args: unknown[]): unknown => {
      if (typeof args[0] === 'string' && path.resolve(args[0]) === ignoreAbs) armed = true;
      return openSync(...args);
   };
   nodeFs.lstatSync = (...args: unknown[]): unknown => {
      const result = lstatSync(...args);
      if (armed && !planted && typeof args[0] === 'string' && path.resolve(args[0]) === ignoreAbs) {
         planted = true;
         fs.symlinkSync(decoy, ignoreAbs);
      }
      return result; // what stood there BEFORE the plant: that is the race
   };
   Module.syncBuiltinESMExports();
   let outcome: string;
   try {
      outcome = ensureLejiIgnoreFile(dir);
   } finally {
      nodeFs.openSync = openSync;
      nodeFs.lstatSync = lstatSync;
      Module.syncBuiltinESMExports();
   }

   assert.ok(planted, 'the swap landed between the read and the create');
   assert.notEqual(outcome, 'created', `nothing was created through the planted link (outcome: ${outcome})`);
   assert.equal(fs.readFileSync(decoy, 'utf8'), 'not the ignore file\n', 'the link target is untouched');
   assert.ok(fs.lstatSync(ignoreAbs).isSymbolicLink(), 'the planted link is still the planted link');
});

test('generation alone establishes a role: `leji viewer` writes the file without an export', async () => {
   // The fixture scenarios drive `viewer build` and `export`, which are one command;
   // this is the other role establisher on the viewer side, reached by its own name.
   const dir = freshCopy();
   const captured = capture();
   let code: number;
   try {
      code = await run(['viewer', '--root', dir]);
   } finally {
      captured.restore();
   }
   assert.equal(code, 0, `viewer exited cleanly (stderr: ${captured.err()})`);
   assert.equal(fs.readFileSync(path.join(dir, '.leji', '.gitignore'), 'utf8'), LEJI_IGNORE_CONTENT);
});

test('the onboarding guard establishes .leji/work/hooks/, so installing it writes the file', () => {
   const dir = freshCopy();
   assert.equal(ensureApprovalGuard(dir, 'docs/'), 'installed');
   assert.equal(fs.readFileSync(path.join(dir, '.leji', '.gitignore'), 'utf8'), LEJI_IGNORE_CONTENT);
});

test('a directly callable SDK function that is given no context still notices at most once per call', async () => {
   const dir = freshCopy();
   fs.mkdirSync(path.join(dir, '.leji'), { recursive: true });
   fs.writeFileSync(path.join(dir, '.leji', '.gitignore'), 'mine\n');
   const { manifest } = loadManifest(dir);
   assert.ok(manifest, 'the fixture manifest loads');
   const { buildViewer } = await import('../dist/index.js');
   const captured = capture();
   let text: string;
   try {
      buildViewer(dir, manifest!);
   } finally {
      captured.restore();
      text = captured.err();
   }
   // buildViewer nests generateViewer and establishes two roles of its own.
   assert.equal(text.split(LEJI_IGNORE_NOTICE).length - 1, 1, 'one notice for the whole call');
});

// --- the mounts commands: one invocation, several mounts operations, one notice ---
//
// Two CLI paths reach a role establisher more than once in a single run:
// `conformance --federation verify` probes reachability PER DECLARED MOUNT, and
// `mounts update-pin --fetch` retains twice (the current pin, then the target).
// Each establishes the managed store, so each would say the frozen line again if the
// invocation's notice state were not threaded all the way down.

/** Git in one repository, with a fixed identity so nothing depends on the machine. */
function git(cwd: string, ...args: string[]): string {
   return execFileSync(
      'git',
      [
         '-C',
         cwd,
         '-c',
         'user.email=fixtures@leji.org',
         '-c',
         'user.name=Leji Fixtures',
         '-c',
         'commit.gpgsign=false',
         ...args,
      ],
      { encoding: 'utf8' },
   ).trim();
}

/** A sibling layer as a real git repository, with one commit per named file, and the
 * commit ids in order. Small on purpose: what these tests need from it is a ref an
 * `ls-remote` can advertise and a history an ancestry check can walk. */
function siblingRepo(parent: string, name: string, files: string[]): { path: string; pins: string[] } {
   const repo = path.join(parent, name);
   fs.mkdirSync(repo, { recursive: true });
   execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { stdio: 'ignore' });
   const pins: string[] = [];
   for (const file of files) {
      fs.writeFileSync(path.join(repo, file), `# ${file}\n`);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', file);
      pins.push(git(repo, 'rev-parse', 'HEAD'));
   }
   return { path: repo, pins };
}

/** Route declared https sources to local repositories for the length of one call, the
 * way the update-pin suite already does it: `insteadOf` is git's own redirection, so
 * the SDK spells the source its manifest declares and nothing reaches the network. */
async function withLocalSources<T>(routes: { from: string; to: string }[], body: () => Promise<T>): Promise<T> {
   const saved = { ...process.env };
   process.env.GIT_CONFIG_COUNT = String(routes.length);
   routes.forEach((route, i) => {
      process.env[`GIT_CONFIG_KEY_${i}`] = `url.${route.to}.insteadOf`;
      process.env[`GIT_CONFIG_VALUE_${i}`] = route.from;
   });
   try {
      return await body();
   } finally {
      for (const key of Object.keys(process.env)) {
         if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
   }
}

/** Every declared mount names an owner; the schema requires it. */
const OWNER = { name: 'Fixture Owner' };

/** The layer with `federation.mounts` spliced in, plus somebody else's ignore file
 * already standing where the tool would write its own: the state the notice is for. */
function mountedLayer(mounts: Record<string, unknown>[]): string {
   const dir = fs.realpathSync(freshCopy());
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
   manifest.federation = { mounts };
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   fs.mkdirSync(path.join(dir, '.leji'), { recursive: true });
   fs.writeFileSync(path.join(dir, '.leji', '.gitignore'), 'mine\n');
   return dir;
}

/** The managed stores a run established, by directory name. */
function stores(dir: string): string[] {
   const storeDir = path.join(dir, '.leji', 'mounts', 'store');
   return fs.existsSync(storeDir) ? fs.readdirSync(storeDir).sort() : [];
}

test('conformance --federation probes every declared mount and notices once for the invocation', async () => {
   const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-ignore-conformance-'));
   const one = siblingRepo(parent, 'one', ['a.md']);
   const two = siblingRepo(parent, 'two', ['b.md']);
   const sources = { one: 'https://github.com/acme/one', two: 'https://github.com/acme/two' };
   const dir = mountedLayer([
      { name: 'one', source: sources.one, pin: one.pins[0], trackingRef: 'refs/heads/main', owner: OWNER },
      { name: 'two', source: sources.two, pin: two.pins[0], trackingRef: 'refs/heads/main', owner: OWNER },
   ]);

   const captured = capture();
   let text: string;
   try {
      await withLocalSources(
         [
            { from: sources.one, to: one.path },
            { from: sources.two, to: two.path },
         ],
         () => run(['conformance', '--federation', 'verify', '--root', dir]),
      );
   } finally {
      captured.restore();
      text = captured.err();
   }

   // The guard against a test that passes for the wrong reason: BOTH mounts really
   // reached the establisher, so two notices were genuinely available to be said.
   assert.equal(stores(dir).length, 2, `both mounts established a store (stderr: ${text})`);
   assert.equal(text.split(LEJI_IGNORE_NOTICE).length - 1, 1, `one notice for the invocation (stderr: ${text})`);
   assert.equal(fs.readFileSync(path.join(dir, '.leji', '.gitignore'), 'utf8'), 'mine\n', 'bytes untouched');
   fs.rmSync(parent, { recursive: true, force: true });
});

test('mounts update-pin --fetch retains twice and notices once for the invocation', async () => {
   const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-ignore-updatepin-'));
   const source = 'https://github.com/acme/one';
   const sibling = siblingRepo(parent, 'one', ['a.md', 'b.md']);
   const dir = mountedLayer([
      { name: 'one', source, pin: sibling.pins[0], trackingRef: 'refs/heads/main', owner: OWNER },
   ]);

   const captured = capture();
   let text: string;
   let code: number;
   try {
      code = await withLocalSources([{ from: source, to: sibling.path }], () =>
         run(['mounts', 'update-pin', 'one', '--fetch', '--root', dir, '--json']),
      );
   } finally {
      captured.restore();
      text = captured.err();
   }

   assert.equal(code, 0, `the move succeeded (stdout: ${captured.out()}, stderr: ${text})`);
   // The guard: both retentions really ran, so two notices were available to be said.
   const store = path.join(dir, '.leji', 'mounts', 'store', stores(dir)[0]);
   const pinRefs = git(store, 'for-each-ref', '--format=%(objectname)', 'refs/leji-pin').split('\n').sort();
   assert.deepEqual(pinRefs, [...sibling.pins].sort(), 'the current pin and the target were both retained');
   assert.equal(text.split(LEJI_IGNORE_NOTICE).length - 1, 1, `one notice for the invocation (stderr: ${text})`);
   assert.equal(fs.readFileSync(path.join(dir, '.leji', '.gitignore'), 'utf8'), 'mine\n', 'bytes untouched');
   fs.rmSync(parent, { recursive: true, force: true });
});
